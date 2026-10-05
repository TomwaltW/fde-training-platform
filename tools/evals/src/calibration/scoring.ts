// 把裁判的一次原始输出变成分数。算分全部交给引擎(checkJudgeOutput + scoreSession),
// 这里只做和 Engine.finish 一致的前置判断,以及把结果摊平成标定要比较的形状。
import {
  checkJudgeOutput,
  emptyJudge,
  scoreSession,
  successFactIds,
  type JudgeOutput,
  type LoadedScenario,
  type ScoreReport,
  type SessionState,
} from "@fde/engine";
import type { RunSnapshot } from "./metrics.ts";

export interface ScoredRun extends RunSnapshot {
  rawTotal: number;
  /** 维度 id → 引擎给的算分依据(如 "T1 hit·A +6")。 */
  details: Record<string, string[]>;
  /** 引擎校验裁判输出时发现的问题(编号不存在、A 级没有资料支持等)。 */
  issues: string[];
  caps: string[];
  /** 裁判原始输出(live 模式可以 --record 存成 fixture)。 */
  raw: unknown;
}

/** 用户一句话都没说时 Engine.finish 不调裁判,直接用空结果;标定时保持同样的口径。 */
export const hasUserTurns = (st: SessionState) => st.transcript.some((l) => l.speaker === "user");

/** 检查项判定的简写:T 项 "hit·A"、S 项"写进/没写"、W 项"是/否"。用来找出多次运行之间在变的检查项。 */
export function itemSignatures(out: JudgeOutput): Record<string, string> {
  const items: Record<string, string> = {};
  for (const t of out.T) items[t.id] = `${t.verdict}${t.grade ? `·${t.grade}` : ""}`;
  for (const s of out.S) items[s.id] = s.mentioned_in_judgment ? "写进" : "没写";
  for (const w of out.W) items[w.id] = w.met ? "是" : "否";
  return items;
}

export function scoreJudgeOutput(scn: LoadedScenario, st: SessionState, raw: unknown): ScoredRun {
  // 引擎的校验和算分只读状态;复制一份是为了让调用方放心地对同一个状态反复算
  const state = structuredClone(st);
  const checked = hasUserTurns(state)
    ? checkJudgeOutput(scn, state, raw)
    : { output: emptyJudge(scn), issues: ["没有任何对话,跳过裁判"] };
  const score: ScoreReport = scoreSession(scn, state, checked.output);
  return {
    total: score.total,
    rawTotal: score.rawTotal,
    dims: Object.fromEntries(score.dimensions.map((d) => [d.id, d.score])),
    details: Object.fromEntries(score.dimensions.map((d) => [d.id, d.details])),
    items: itemSignatures(checked.output),
    issues: checked.issues,
    caps: score.caps.map((c) => c.label),
    raw,
  };
}

/** 检查项 id → 所属维度和一句话说明(稳定性报告里提示"改哪一条")。 */
export function checkItemCatalog(scn: LoadedScenario): Map<string, { dims: string[]; text: string }> {
  const m = new Map<string, { dims: string[]; text: string }>();
  // T 项决定 D4;A 级证据的条数还影响 D2 的 two_claims_backed_by_data
  for (const t of scn.data.truth.diagnosis_items) m.set(t.id, { dims: ["D4", "D2"], text: t.statement });
  for (const id of successFactIds(scn)) m.set(id, { dims: ["D5"], text: scn.fact(id).statement });
  for (const w of scn.data.rubric.d7_checklist) m.set(w.id, { dims: ["D7"], text: w.item });
  return m;
}
