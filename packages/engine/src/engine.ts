// 引擎:把闸门 → 导演 → 演员 → 守卫串起来(方案 3.3.1),收工后跑裁判 → 算分 → 复盘。
import { buildDebriefData, type DebriefData } from "./debrief.ts";
import {
  bossRole,
  discoverFromReply,
  doAction,
  doExperiment,
  doOpenArtifact,
  doSwitchRole,
  endSession,
  planReportOpening,
  planUserTurn,
  submitJudgment,
  type ActionResult,
  type TurnPlan,
} from "./director.ts";
import { activeCanaries, checkReply, fallbackLine } from "./guard.ts";
import { checkJudgeOutput, emptyJudge, type JudgeOutput } from "./judge.ts";
import { Moderation } from "./moderation.ts";
import type { ActorPort, DebriefPort, GatePort, JudgePort } from "./ports.ts";
import { buildActorPrompt } from "./prompts/actor.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import { scoreSession, type ScoreReport } from "./scoring.ts";
import { addEvent, addLine, createSession, minutesLeft } from "./state.ts";
import type { SessionState, TurnResult } from "./types.ts";

export interface EngineDeps {
  gate: GatePort;
  actor: ActorPort;
  judge: JudgePort;
  debrief: DebriefPort;
  moderation?: Moderation;
  /** 守卫不通过时的重试次数(方案:最多 2 次)。 */
  actorRetries?: number;
}

export type UserAction =
  | { type: "switch_role"; role: string }
  | { type: "open_artifact"; artifact: string }
  | { type: "action"; action: string }
  | { type: "experiment"; experiment: string }
  | { type: "submit_judgment"; form: Record<string, string> }
  | { type: "end" };

export interface SessionReport {
  score: ScoreReport;
  judge: JudgeOutput;
  judgeIssues: string[];
  debrief: DebriefData;
  markdown: string;
  /** 裁判调用失败(超时、模型拒答、输出不是 JSON),本次按空裁判算分。调用方可以决定先不保存、稍后重试。 */
  judgeFailed?: true;
}

/** 裁判失败时放在复盘最前面,让玩家知道分数不完整。 */
export const JUDGE_FAILED_NOTICE = "> 这次评分模型没有响应,依赖它的几项(提问质量、判断、成功定义、报告)没有计分,总分偏低。可以在下面的申诉里说明,我们会人工复核。";

export class Engine {
  private moderation: Moderation;
  constructor(
    readonly scn: LoadedScenario,
    private deps: EngineDeps,
  ) {
    this.moderation = deps.moderation ?? new Moderation();
  }

  start(sessionId: string): SessionState {
    return createSession(this.scn, { sessionId });
  }

  private result(st: SessionState, partial: Partial<TurnResult> = {}): TurnResult {
    return {
      system: [],
      unlockedArtifacts: [],
      discovered: [],
      guardFlags: [],
      ...partial,
      minutesLeft: Math.max(0, minutesLeft(st, this.scn)),
      phase: st.phase,
      ended: st.phase === "debrief",
    };
  }

  async userTurn(st: SessionState, text: string): Promise<TurnResult> {
    const mod = this.moderation.check(text);
    if (!mod.ok) {
      addEvent(st, "moderation_block", { reason: mod.reason, detail: mod.detail });
      const msg =
        mod.reason === "too_long"
          ? "一次说太多了。请控制在 500 字以内,一次说一件事。"
          : mod.reason === "empty"
            ? "你还什么都没说。"
            : "这句话没法发出去,换个说法吧。";
      return this.result(st, { system: [msg] });
    }
    if (st.phase === "debrief") return this.result(st, { system: ["这一局已经结束。"] });
    if (st.phase === "judgment") {
      return this.result(st, { system: ["现在需要先提交你的判断(J1–J5),然后去会议室向周总汇报。"] });
    }

    st.turn += 1;
    const userLine = addLine(st, "user", text.trim(), st.currentRole);
    const gate = await this.deps.gate.classify({ scn: this.scn, st, userText: text.trim() });
    const plan = planUserTurn(this.scn, st, gate);
    if (plan.role) userLine.roleId = plan.role;

    for (const s of plan.system) addLine(st, "system", s);
    const res = this.result(st, {
      system: [...plan.system],
      unlockedArtifacts: [...plan.obtained],
      discovered: [...plan.discovered],
    });
    let guardFlags: string[] = [];
    let attempts = 0;
    if (plan.role && plan.directive) {
      const spoken = await this.speak(st, plan, text.trim());
      guardFlags = spoken.flags;
      attempts = spoken.attempts;
      const line = addLine(st, "npc", spoken.text, plan.role);
      res.reply = { roleId: plan.role, text: spoken.text, ref: line.ref };
      res.directive = plan.directive;
      res.discovered.push(...discoverFromReply(this.scn, st, plan.role, spoken.text));
      this.maybeEndReport(st, res);
    }
    // 同一句话里的去现场、做验证,发生在角色回话之后
    for (const s of plan.after) addLine(st, "system", s);
    res.system.push(...plan.after);
    st.turns.push({
      turn: st.turn,
      role: plan.role ?? st.currentRole,
      userText: text.trim(),
      gate,
      ...(plan.directive && { directive: plan.directive }),
      reveals: plan.reveals.map((r) => r.ruleId),
      guardFlags,
      attempts,
      minutesAfter: st.minutesUsed,
    });
    return this.result(st, { ...res, guardFlags });
  }

  private maybeEndReport(st: SessionState, res: TurnResult) {
    if (st.phase !== "report") return;
    const boss = this.scn.role(bossRole(this.scn));
    const cap = boss.caps?.report_exchanges;
    if (cap && (st.phaseExchanges[boss.id] ?? 0) >= cap) {
      endSession(st, "report_cap");
      const msg = `${boss.name}看了看表:"就这样吧。"汇报结束。`;
      addLine(st, "system", msg);
      res.system.push(msg);
    }
  }

  /** 演员说话,守卫检查;不通过收紧后重试,仍不通过用兜底台词。 */
  private async speak(st: SessionState, plan: TurnPlan, userText: string | undefined) {
    const retries = this.deps.actorRetries ?? 2;
    const canaries = activeCanaries(this.scn, st);
    const userTexts = st.transcript.filter((l) => l.speaker === "user").map((l) => l.text);
    const ledgerTexts = st.ledger.map((e) => e.valueText);
    // 用户已经看到过的文字(其他角色的话、旁白、拿到的资料标题):金丝雀词出现在这里就不算泄露
    const seenTexts = [
      ...st.transcript.filter((l) => l.speaker !== "user").map((l) => l.text),
      ...Object.keys(st.artifacts).map((id) => this.scn.artifacts.get(id)?.title ?? ""),
    ];
    let previous: string[] = [];
    for (let attempt = 0; attempt <= retries; attempt++) {
      const prompt = buildActorPrompt(this.scn, st, plan, userText);
      if (attempt > 0) {
        const sys = prompt.messages[0]!;
        sys.content += `\n\n【注意】你上一次的回复不合格(${previous.join("、")})。这次严格只说上面写明的事实,不说任何上面没有的数字、名字或说法,不附和对方。`;
      }
      let text: string;
      try {
        text = await this.deps.actor.speak({ scn: this.scn, st, plan, userText, attempt, previousFlags: previous, prompt });
      } catch (e) {
        // 模型出错时状态已经改过了(时间、解锁、压力时刻),不能把异常抛出去留下半截状态:重试,最后用兜底台词
        const msg = e instanceof Error ? e.message : String(e);
        previous = [`actor_error:${msg.slice(0, 80)}`];
        addEvent(st, "actor_error", { attempt, error: msg });
        continue;
      }
      const flags = checkReply(text, {
        actorContext: prompt.context,
        userTexts,
        seenTexts,
        ledgerTexts,
        canaries,
        stance: plan.directive!.stance,
      });
      if (!flags.length) return { text, flags: previous, attempts: attempt + 1 };
      previous = flags.map((f) => `${f.type}:${f.detail}`);
      addEvent(st, "guard_block", { attempt, flags: previous, text });
    }
    addEvent(st, "guard_fallback", { flags: previous });
    const text = fallbackLine(this.scn, plan.role!, plan.directive!);
    return { text, flags: [...previous, "fallback"], attempts: retries + 1 };
  }

  async act(st: SessionState, action: UserAction): Promise<TurnResult> {
    let r: ActionResult;
    switch (action.type) {
      case "switch_role":
        r = doSwitchRole(this.scn, st, action.role);
        break;
      case "open_artifact":
        r = doOpenArtifact(this.scn, st, action.artifact);
        break;
      case "action":
        r = doAction(this.scn, st, action.action);
        break;
      case "experiment":
        r = doExperiment(this.scn, st, action.experiment);
        break;
      case "submit_judgment": {
        r = submitJudgment(this.scn, st, action.form);
        if (!r.ok) break;
        for (const s of r.system) addLine(st, "system", s);
        // 汇报开场:周总先开口
        const plan = planReportOpening(this.scn, st);
        const spoken = await this.speak(st, plan, undefined);
        const line = addLine(st, "npc", spoken.text, plan.role);
        return this.result(st, {
          ok: true,
          system: r.system,
          reply: { roleId: plan.role!, text: spoken.text, ref: line.ref },
          ...(plan.directive && { directive: plan.directive }),
          guardFlags: spoken.flags,
        });
      }
      case "end":
        endSession(st, "user");
        r = { ok: true, system: ["你收工了。"], obtained: [], discovered: [] };
        break;
    }
    if (r.ok) for (const s of r.system) addLine(st, "system", s);
    return this.result(st, { ok: r.ok, system: r.system, unlockedArtifacts: r.obtained, discovered: r.discovered });
  }

  /** 收工:裁判抽证据 → 代码算分 → 复盘。 */
  async finish(st: SessionState): Promise<SessionReport> {
    endSession(st, st.endedReason ?? "user");
    let judge: JudgeOutput;
    let issues: string[] = [];
    let judgeFailed = false;
    const userTurns = st.transcript.filter((l) => l.speaker === "user").length;
    if (userTurns === 0) {
      judge = emptyJudge(this.scn);
      issues = ["没有任何对话,跳过裁判"];
    } else {
      try {
        const raw = await this.deps.judge.judge({ scn: this.scn, st });
        const checked = checkJudgeOutput(this.scn, st, raw);
        judge = checked.output;
        issues = checked.issues;
      } catch (e) {
        judge = emptyJudge(this.scn);
        issues = [`裁判调用失败:${(e as Error).message}`];
        judgeFailed = true;
      }
    }
    if (!st.judgment) issues.push("用户没有提交判断,D4、D5、D7 只能按对话内容判定");
    const score = scoreSession(this.scn, st, judge);
    const debrief = buildDebriefData(this.scn, st, score, judge, issues);
    const written = await this.deps.debrief.write({ scn: this.scn, st, data: debrief });
    const markdown = judgeFailed ? `${JUDGE_FAILED_NOTICE}\n\n${written}` : written;
    return { score, judge, judgeIssues: issues, debrief, markdown, ...(judgeFailed && { judgeFailed: true as const }) };
  }
}
