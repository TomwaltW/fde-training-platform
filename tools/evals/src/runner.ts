// 跑一个脚本化玩家,检查断言。离线模式完全确定;在线模式调用真模型。
import {
  Engine,
  FixtureJudge,
  QueueGate,
  TemplateActor,
  TemplateDebrief,
  emptyJudge,
  type EngineDeps,
  type LoadedScenario,
  type SessionReport,
  type SessionState,
  type TurnResult,
} from "@fde/engine";
import { triggers } from "@fde/engine";
import { expandGate, lintPlayer, type Check, type Player } from "./players.ts";
import { auditDelivered, type LineAudit } from "./quality/auditor.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GateLogEntry {
  step: string;
  role: string;
  say: string;
  want: string[];
  got: string[];
  /** 闸门原样给出的每一条和置信度(没过 0.6 的也在),用来分清漏命中是「没给」还是「给了但低于 0.6」。只记录,不参与命中判定。
   *  注意:闸门提示词本身让模型不列 0.6 以下的(prompts/gate.ts 第 15 行),所以在线时这里基本看不到低置信度的条目——它只能说明代码里的 0.6 阈值是不是瓶颈。 */
  given: { id: string; confidence: number }[];
  acts: string[];
  commitments: { type: string; value_text: string; firm: boolean }[];
  trustMoves: { dir: string; what: string }[];
  meta: boolean;
}

export interface PlayerRun {
  player: string;
  ok: boolean;
  crashed?: string;
  checks: CheckResult[];
  total?: number;
  dims?: Record<string, number>;
  minutesUsed: number;
  turns: number;
  gateAgreement?: { expected: number; matched: number; extra: number };
  /**
   * 在线模式:每句进了闸门的话,脚本标注的触发器(want)和真闸门命中的(got,置信度 ≥ 0.6),以及真闸门标出的
   * 动作、承诺、信任加减分。调闸门提示词和触发器描述时看这里(pnpm evals --live -v 打印对不上的那些)。
   */
  gateLog?: GateLogEntry[];
  /** 每句话(进了闸门的)从发出到拿到回复的毫秒数,含闸门、演员和守卫重试(质量门槛:单轮中位耗时)。 */
  turnMs: number[];
  /** 每条实际出给用户的角色台词的审计结果(quality/auditor.ts,独立于守卫)。 */
  delivered: LineAudit[];
  state?: SessionState;
  report?: SessionReport;
}

export type Mode =
  | { kind: "offline"; /** 测试用:替换离线的某个端口(比如包一层记录提示词的演员) */ overrides?: Partial<EngineDeps> }
  | { kind: "live"; deps: Omit<EngineDeps, "judge" | "debrief"> & Partial<EngineDeps> };

export function stepCheck(name: string, c: Check, res: TurnResult, st: SessionState, before: { traps: number }): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (label: string, ok: boolean, detail: string) => out.push({ name: `${name} ${label}`, ok, detail });
  if (c.directive) add("directive", res.directive?.stance === c.directive, `期望 ${c.directive},实际 ${res.directive?.stance ?? "无"}`);
  if (c.beat !== undefined) add("beat", Boolean(res.directive?.beat) === c.beat, `beat=${res.directive?.beat ?? "无"}`);
  if (c.trap) {
    const fired = st.events.filter((e) => e.type === "trap").slice(before.traps).map((e) => String(e.payload.trap));
    add("trap", fired.includes(c.trap), `本步触发 ${fired.join(",") || "无"}`);
  }
  if (c.reveals) {
    for (const f of c.reveals) {
      const [id, lvl] = f.split("@");
      const got = st.facts[id!];
      add(`reveal ${f}`, Boolean(got) && (!lvl || got!.level >= lvl), `实际 ${got?.level ?? "未解锁"}`);
    }
  }
  if (c.obtained) for (const a of c.obtained) add(`obtained ${a}`, Boolean(st.artifacts[a]), st.artifacts[a] ? "已拿到" : "没拿到");
  if (c.discovered) for (const r of c.discovered) add(`discovered ${r}`, st.discovered.includes(r), st.discovered.join(","));
  if (c.phase) add("phase", st.phase === c.phase, `实际 ${st.phase}`);
  if (c.system_includes) add("system", res.system.some((s) => s.includes(c.system_includes!)), res.system.join(" | ") || "无");
  if (c.minutes_used !== undefined) add("minutes", st.minutesUsed === c.minutes_used, `实际 ${st.minutesUsed}`);
  for (const [r, v] of Object.entries(c.trust_min ?? {})) add(`trust_min ${r}`, (st.trust[r] ?? 0) >= v, `${r} 信任 ${st.trust[r] ?? 0}`);
  for (const [r, v] of Object.entries(c.trust_max ?? {})) add(`trust_max ${r}`, (st.trust[r] ?? 0) <= v, `${r} 信任 ${st.trust[r] ?? 0}`);
  return out;
}

export async function runPlayer(scn: LoadedScenario, player: Player, mode: Mode): Promise<PlayerRun> {
  const queue = new QueueGate();
  const fixture = () => ({ ...emptyJudge(scn), ...(player.judge ?? {}) });
  const deps: EngineDeps =
    mode.kind === "offline"
      ? { gate: queue, actor: new TemplateActor(), judge: new FixtureJudge(fixture), debrief: new TemplateDebrief(), ...mode.overrides }
      : { judge: new FixtureJudge(fixture), debrief: new TemplateDebrief(), ...mode.deps };
  const engine = new Engine(scn, deps);
  const st = engine.start(`eval-${player.id}-${Date.now()}`);
  const checks: CheckResult[] = [];
  const agree = { expected: 0, matched: 0, extra: 0 };
  const gateLog: GateLogEntry[] = [];
  const turnMs: number[] = [];
  const delivered: LineAudit[] = [];
  const live = mode.kind === "live";

  // 脚本写错了直接算失败
  for (const e of lintPlayer(player, {
    triggers: new Set(triggers(scn).keys()),
    roles: new Set(scn.roles.keys()),
    artifacts: new Set(scn.artifacts.keys()),
    experiments: new Set(scn.experiments.keys()),
    actions: new Set(Object.keys(scn.data.actions)),
  })) {
    checks.push({ name: "脚本", ok: false, detail: e });
  }

  let endedAt: number | undefined;
  try {
    for (const [i, step] of player.steps.entries()) {
      const label = `#${i + 1}`;
      const before = { traps: st.events.filter((e) => e.type === "trap").length };
      let res: TurnResult | undefined;
      if ("say" in step) {
        if (!live) queue.push(expandGate(step.gate));
        const t0 = performance.now();
        const turnBefore = st.turn;
        res = await engine.userTurn(st, step.say);
        if (st.turn > turnBefore) turnMs.push(Math.round(performance.now() - t0));
        queue.clear();
        // 闸门对照:每句进了闸门的话都比(没进闸门的,比如被内容审核挡下,st.turns 里没有这一轮,不能拿上一轮的结果来比)。
        // 没写 t 的步骤,标准答案就是"什么触发器都不命中"(离线喂给导演的也是空的),真闸门命中的全算多命中。
        if (live && st.turn > turnBefore) {
          const got = new Set(st.turns.at(-1)?.gate?.matched_triggers.filter((m) => m.confidence >= 0.6).map((m) => m.id));
          const want = step.gate?.t ?? [];
          for (const id of want) {
            agree.expected++;
            if (got.has(id)) agree.matched++;
          }
          agree.extra += [...got].filter((id) => !want.includes(id)).length;
          const g = st.turns.at(-1)?.gate;
          gateLog.push({
            step: label,
            role: st.currentRole,
            say: step.say,
            want,
            got: [...got],
            given: (g?.matched_triggers ?? []).map((m) => ({ id: m.id, confidence: m.confidence })),
            acts: g?.acts ?? [],
            commitments: g?.commitments ?? [],
            trustMoves: g?.trust_moves ?? [],
            meta: g?.meta_or_injection ?? false,
          });
        }
      } else if ("switch" in step) res = await engine.act(st, { type: "switch_role", role: step.switch });
      else if ("open" in step) res = await engine.act(st, { type: "open_artifact", artifact: step.open });
      else if ("action" in step) res = await engine.act(st, { type: "action", action: step.action });
      else if ("experiment" in step) res = await engine.act(st, { type: "experiment", experiment: step.experiment });
      else if ("judgment" in step) res = await engine.act(st, { type: "submit_judgment", form: step.judgment });
      else if ("end" in step) {
        if (st.phase !== "debrief") res = await engine.act(st, { type: "end" });
        break;
      }
      const audit = res && auditDelivered(scn, st, res);
      if (audit) delivered.push(audit);
      // 按钮动作被拒绝(前提不满足、阶段不对)说明脚本和引擎对不上,不能悄悄跳过
      if (res && res.ok === false && !("say" in step)) {
        checks.push({ name: `${label} 动作`, ok: false, detail: `被拒绝:${res.system.join(" | ")}` });
      }
      if (res && "check" in step && step.check) {
        // 在线模式下依赖闸门的断言只作参考
        for (const c of stepCheck(label, step.check, res, st, before)) checks.push(live ? { ...c, ok: true, detail: `${c.ok ? "" : "[在线不一致] "}${c.detail}` } : c);
      }
      if (st.phase === "debrief") {
        endedAt = i;
        break;
      }
    }
    // 会话提前结束、后面还有没执行的步骤:不能当作通过(在线模式也不放过)
    if (endedAt !== undefined) {
      const rest = player.steps.slice(endedAt + 1).filter((s) => !("end" in s));
      if (rest.length) {
        checks.push({
          name: `#${endedAt + 1} 之后`,
          ok: false,
          detail: `会话在第 ${endedAt + 1} 步已结束(${st.endedReason ?? "?"}),后面 ${rest.length} 步没执行`,
        });
      }
    }
    const report = await engine.finish(st);
    return {
      player: player.id,
      ok: true,
      checks,
      total: report.score.total,
      dims: Object.fromEntries(report.score.dimensions.map((d) => [d.id, d.score])),
      minutesUsed: st.minutesUsed,
      turns: st.turn,
      ...(live && { gateAgreement: agree, gateLog }),
      turnMs,
      delivered,
      state: st,
      report,
    };
  } catch (e) {
    return { player: player.id, ok: false, crashed: (e as Error).stack ?? String(e), checks, minutesUsed: st.minutesUsed, turns: st.turn, turnMs, delivered, state: st };
  }
}

// ------------------------------------------------------------------
// 场景级断言(scenario.yaml 的 evals[].expect)
// ------------------------------------------------------------------

const guardFlagCount = (st: SessionState, type: string) =>
  st.events
    .filter((e) => e.type === "guard_block")
    .flatMap((e) => (e.payload.flags as string[]) ?? [])
    .filter((f) => f.startsWith(`${type}:`)).length;

export function checkExpectations(run: PlayerRun, expect: Record<string, number | boolean | string>): CheckResult[] {
  const out: CheckResult[] = [];
  const st = run.state!;
  const rep = run.report;
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  for (const [key, want] of Object.entries(expect)) {
    let m: RegExpMatchArray | null;
    if (key === "no_crash") add(key, !run.crashed === want, run.crashed ? "崩溃" : "正常");
    else if (run.crashed || !rep) add(key, false, "运行失败,无法检查");
    else if (key === "total_min") add(key, rep.score.total >= Number(want), `总分 ${rep.score.total}`);
    else if (key === "total_max") add(key, rep.score.total <= Number(want), `总分 ${rep.score.total}`);
    else if (key === "raw_total_min") {
      // 这条断言查的是场景设计("封顶真的在起作用",离线确定地验);在线时 D3 随闸门的提问标签浮动,只作参考
      const ok = rep.score.rawTotal >= Number(want);
      const live = run.gateAgreement !== undefined;
      add(key, ok || live, `${!ok && live ? "[在线只作参考] " : ""}封顶前 ${rep.score.rawTotal}`);
    }
    else if (key === "cap") add(key, rep.score.caps.some((c) => c.label === want), `触发 ${rep.score.caps.map((c) => c.label).join("、") || "无"}`);
    else if (key === "badge") add(key, rep.score.badges.includes(String(want)), `标记 ${rep.score.badges.join("、") || "无"}`);
    else if ((m = key.match(/^(D\d)(_max|_min)?$/))) {
      const v = rep.score.dimensions.find((d) => d.id === m![1])?.score ?? NaN;
      const ok = m[2] === "_max" ? v <= Number(want) : m[2] === "_min" ? v >= Number(want) : v === Number(want);
      add(key, ok, `${m[1]} = ${v}`);
    } else if (key === "premature") {
      const n = st.ledger.filter((e) => e.premature).length;
      add(key, n === Number(want), `过早承诺 ${n} 条`);
    } else if ((m = key.match(/^(\w+)_directive$/))) {
      const stances = st.turns.filter((t) => t.role === m![1]).map((t) => t.directive?.stance);
      add(key, stances.includes(want as never), `${m[1]} 的指令:${stances.join(",")}`);
    } else if (key === "ledger_recalled_in_report") add(key, st.ledgerRecalled === want, `ledgerRecalled=${st.ledgerRecalled}`);
    else if (key === "artifacts_max") {
      const n = Object.keys(st.artifacts).length;
      add(key, n <= Number(want), `拿到资料 ${n} 份`);
    } else if (key === "canary_hits") {
      const n = guardFlagCount(st, "canary");
      add(key, n <= Number(want), `金丝雀命中 ${n} 次(含被守卫拦下的)`);
    } else if (key === "unlisted_numbers") {
      const n = guardFlagCount(st, "number");
      add(key, n <= Number(want), `白名单外数字 ${n} 次(含被守卫拦下的)`);
    } else if (key === "in_character") {
      const n = guardFlagCount(st, "ooc");
      add(key, (n === 0) === want, `出戏 ${n} 次`);
    } else if (key === "npc_confirms_unknown_fact") {
      const n = guardFlagCount(st, "sycophancy") + rep.judge.npc_inconsistencies.length;
      add(key, n <= Number(want), `附和 + 角色不一致 ${n} 次`);
    } else if ((m = key.match(/^trust_(\w+)_max$/))) {
      const v = st.trust[m[1]!] ?? 0;
      add(key, v <= Number(want), `${m[1]} 信任 ${v}`);
    } else if ((m = key.match(/^(A\d+)_unlocked$/))) {
      add(key, Boolean(st.artifacts[m[1]!]) === want, st.artifacts[m[1]!] ? "已拿到" : "没拿到");
    } else if (key === "report_generated") add(key, Boolean(rep.markdown.trim()) === want, `${rep.markdown.length} 字`);
    else if (key === "moderation_blocked") {
      const n = st.events.filter((e) => e.type === "moderation_block").length;
      add(key, (n > 0) === want, `拦截 ${n} 次`);
    } else add(key, false, "不支持的断言(需要在 tools/evals/src/runner.ts 里实现)");
  }
  return out;
}
