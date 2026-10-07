// 跑对抗集:每组一局。准备步骤用脚本标注喂导演(两种模式都一样,结果确定),探测轮换成真正的闸门:
//   离线:关键词闸门 + 模板台词。确定性的冒烟测试,证明这套工具本身能跑、审计不误报(pnpm test 里跑)。
//   在线:真闸门 + 真演员(config/models.yaml)。准备步骤的台词也由真演员说,让探测接在一段自然的对话后面。
// 每条实际出给用户的台词都过 quality/auditor.ts;守卫的拦截和兜底只作诊断。
import {
  Engine,
  FixtureJudge,
  HeuristicGate,
  QueueGate,
  TemplateActor,
  TemplateDebrief,
  emptyJudge,
  type ActorPort,
  type GateInput,
  type GatePort,
  type LoadedScenario,
  type SessionState,
  type TurnResult,
} from "@fde/engine";
import type { LlmCallLog } from "@fde/llm";
import { expandGate } from "../players.ts";
import { auditDelivered, type LineAudit } from "../quality/auditor.ts";
import type { SuiteRunInput } from "../quality/bars.ts";
import { stepCheck } from "../runner.ts";
import type { Group, Suite } from "./suite.ts";

export type AdversarialMode = { kind: "offline" } | { kind: "live"; gate: GatePort; actor: ActorPort };

/** 准备阶段用脚本标注,探测阶段换成真正的闸门。引擎的端口在构造时就定了,所以在这里切换。 */
class PhasedGate implements GatePort {
  phase: "setup" | "probe" = "setup";
  constructor(
    readonly queue: QueueGate,
    private probeGate: GatePort,
  ) {}
  classify(input: GateInput) {
    return this.phase === "setup" ? this.queue.classify() : this.probeGate.classify(input);
  }
}

export interface ProbeResult {
  say: string;
  aims?: string[];
  /** 拿到了角色台词(没被换人失败、阶段、轮数上限之类挡掉)。 */
  delivered: boolean;
  reply?: string;
  system: string[];
  ms?: number;
}

export interface GroupRun {
  group: string;
  title: string;
  setupProblems: string[];
  probes: ProbeResult[];
  delivered: LineAudit[];
  costYuan: number;
  crashed?: string;
}

export interface SuiteRun {
  suite: string;
  title: string;
  groups: GroupRun[];
}

export async function runGroup(scn: LoadedScenario, group: Group, mode: AdversarialMode, sessionId: string): Promise<Omit<GroupRun, "costYuan">> {
  const queue = new QueueGate();
  const gate = new PhasedGate(queue, mode.kind === "live" ? mode.gate : new HeuristicGate());
  const actor = mode.kind === "live" ? mode.actor : new TemplateActor();
  const engine = new Engine(scn, { gate, actor, judge: new FixtureJudge(() => emptyJudge(scn)), debrief: new TemplateDebrief() });
  const st: SessionState = engine.start(sessionId);
  const setupProblems: string[] = [];
  const probes: ProbeResult[] = [];
  const delivered: LineAudit[] = [];
  const out = { group: group.id, title: group.title, setupProblems, probes, delivered };
  const audit = (res: TurnResult | undefined, section: string) => {
    const a = res && auditDelivered(scn, st, res, `${group.id}·${section}`);
    if (a) delivered.push(a);
  };

  try {
    // ---- 准备步骤:断言一律严格(标注是脚本给的,结果应当和离线完全一样)
    for (const [i, step] of group.setup.entries()) {
      const label = `${group.id} 准备 #${i + 1}`;
      const before = { traps: st.events.filter((e) => e.type === "trap").length };
      let res: TurnResult | undefined;
      if ("say" in step) {
        queue.push(expandGate(step.gate));
        res = await engine.userTurn(st, step.say);
        queue.clear();
      } else if ("switch" in step) res = await engine.act(st, { type: "switch_role", role: step.switch });
      else if ("open" in step) res = await engine.act(st, { type: "open_artifact", artifact: step.open });
      else if ("action" in step) res = await engine.act(st, { type: "action", action: step.action });
      else if ("experiment" in step) res = await engine.act(st, { type: "experiment", experiment: step.experiment });
      else if ("judgment" in step) res = await engine.act(st, { type: "submit_judgment", form: step.judgment });
      else {
        setupProblems.push(`${label}:准备步骤里不能收工`);
        break;
      }
      audit(res, "准备");
      if (res.ok === false && !("say" in step)) setupProblems.push(`${label} 动作被拒绝:${res.system.join(" | ")}`);
      if ("check" in step && step.check) {
        for (const c of stepCheck(label, step.check, res, st, before)) if (!c.ok) setupProblems.push(`${c.name}:${c.detail}`);
      }
      if (st.phase === "debrief") {
        setupProblems.push(`${label} 之后会话已经结束(${st.endedReason ?? "?"})`);
        break;
      }
    }

    // ---- 探测
    gate.phase = "probe";
    for (const p of group.probes) {
      const r: ProbeResult = { say: p.say, ...(p.aims && { aims: p.aims }), delivered: false, system: [] };
      probes.push(r);
      if (st.phase === "debrief") {
        r.system.push("会话已经结束,没发出去");
        continue;
      }
      const t0 = performance.now();
      const turnBefore = st.turn;
      const res = await engine.userTurn(st, p.say);
      if (st.turn > turnBefore) r.ms = Math.round(performance.now() - t0);
      r.system = res.system;
      if (res.reply) {
        r.delivered = true;
        r.reply = res.reply.text;
      }
      audit(res, "探测");
    }
    return out;
  } catch (e) {
    return { ...out, crashed: (e as Error).stack ?? String(e) };
  }
}

/** 跑一个对抗集。calls 是模型调用日志(在线时由网关追加),用来按组切出花费。 */
export async function runSuite(scn: LoadedScenario, suite: Suite, mode: AdversarialMode, calls: LlmCallLog[] = []): Promise<SuiteRun> {
  const groups: GroupRun[] = [];
  for (const [i, g] of suite.groups.entries()) {
    const mark = calls.length;
    const run = await runGroup(scn, g, mode, `adv-${suite.id}-${g.id}-${i}-${Date.now()}`);
    groups.push({ ...run, costYuan: calls.slice(mark).reduce((s, c) => s + (c.costYuan ?? 0), 0) });
  }
  return { suite: suite.id, title: suite.title, groups };
}

/** 给质量门槛用的汇总。 */
export function suiteBarInput(run: SuiteRun): SuiteRunInput {
  return {
    suite: run.suite,
    probesWritten: run.groups.reduce((s, g) => s + g.probes.length, 0),
    probesDelivered: run.groups.reduce((s, g) => s + g.probes.filter((p) => p.delivered).length, 0),
    setupProblems: run.groups.flatMap((g) => [...g.setupProblems, ...(g.crashed ? [`${g.group} 崩溃:${g.crashed.split("\n")[0]}`] : [])]),
    delivered: run.groups.flatMap((g) => g.delivered),
    probeMs: run.groups.flatMap((g) => g.probes.flatMap((p) => (p.ms === undefined ? [] : [p.ms]))),
    groupCosts: run.groups.map((g) => g.costYuan),
  };
}
