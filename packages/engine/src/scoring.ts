// 算分(方案 3.4.1):全部由代码完成,模型不输出任何分数。
// D1、D2、D6 纯规则;D3 由闸门标签经规则汇总;D4、D5、D7 用裁判抽出的证据(已校验)按规则计算。
import { evalExpr } from "./expr.ts";
import type { JudgeOutput } from "./judge.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import { hasFactAtLeast, stateResolver } from "./state.ts";
import type { SessionState } from "./types.ts";

export interface DimensionScore {
  id: string;
  name: string;
  max: number;
  score: number;
  details: string[];
}

export interface ScoreReport {
  dimensions: DimensionScore[];
  rawTotal: number;
  total: number;
  caps: { label: string; total_max?: number; set?: Record<string, number> }[];
  badges: string[];
  band: string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const BANDS: [number, string][] = [
  [85, "可以独立去见这个客户"],
  [70, "方向对,有遗漏"],
  [50, "被客户带着走"],
  [0, "接了一个会翻车的单"],
];

const opened = (st: SessionState, id: string) =>
  id.startsWith("X") ? st.experiments[id] !== undefined : st.artifacts[id]?.openedTurn !== undefined;

function d1(scn: LoadedScenario, st: SessionState, max: number): DimensionScore {
  const ru = scn.data.rubric;
  const total = scn.data.facts.reduce((s, f) => s + f.weight, 0);
  const covered = scn.data.facts.filter((f) => hasFactAtLeast(st, f.id, ru.d1_min_level));
  const got = covered.reduce((s, f) => s + f.weight, 0);
  const need = total * ru.full_credit_ratio;
  return {
    id: "D1",
    name: "",
    max,
    score: r1(clamp((got / need) * max, 0, max)),
    details: [`覆盖事实权重 ${got} / 满分线 ${r1(need)}(${ru.d1_min_level} 及以上)`],
  };
}

function d2(scn: LoadedScenario, st: SessionState, judge: JudgeOutput, max: number): DimensionScore {
  let score = 0;
  const details: string[] = [];
  for (const [key, pts] of Object.entries(scn.data.rubric.d2_points)) {
    let ok = false;
    let m: RegExpMatchArray | null;
    if (/^[AX]\d+$/.test(key)) ok = opened(st, key);
    else if ((m = key.match(/^any_two_of_(.+)$/))) ok = m[1]!.split("_").filter((id) => opened(st, id)).length >= 2;
    else if (key.includes("_or_")) ok = key.split("_or_").some((id) => opened(st, id));
    else if (key === "two_claims_backed_by_data")
      ok = judge.T.filter((t) => (t.verdict === "hit" || t.verdict === "partial") && t.grade === "A").length >= 2;
    else throw new Error(`d2_points 里有不认识的键: ${key}`);
    if (ok) {
      score += pts;
      details.push(`${key} +${pts}`);
    }
  }
  return { id: "D2", name: "", max, score: r1(clamp(score, 0, max)), details };
}

function d3(scn: LoadedScenario, st: SessionState, max: number): DimensionScore {
  const qs = st.turns.filter((t) => t.gate && t.gate.acts.includes("ask") && !t.gate.meta_or_injection).map((t) => t.gate!);
  const details: string[] = [];
  let score = 0;
  for (const [key, pts] of Object.entries(scn.data.rubric.d3_points)) {
    let frac = 0;
    let m: RegExpMatchArray | null;
    if ((m = key.match(/^open_ratio_first(\d+)$/))) {
      const first = qs.slice(0, Number(m[1]));
      const ratio = first.length ? first.filter((g) => g.question_tags.open).length / first.length : 0;
      frac = Math.min(1, ratio / 0.5);
      details.push(`前 ${first.length} 问开放式占 ${Math.round(ratio * 100)}%`);
    } else if ((m = key.match(/^(quantifying|followup|evidence_asks)_ge(\d+)$/))) {
      const tag = { quantifying: "quantifying", followup: "follow_up", evidence_asks: "evidence_ask" }[m[1]!] as
        | "quantifying"
        | "follow_up"
        | "evidence_ask";
      const n = qs.filter((g) => g.question_tags[tag]).length;
      frac = Math.min(1, n / Number(m[2]));
      details.push(`${m[1]} ${n} 次`);
    } else if ((m = key.match(/^single_focus_ge(\d+)pct$/))) {
      const share = qs.length ? qs.filter((g) => g.question_tags.bundled_count <= 1).length / qs.length : 0;
      frac = Math.min(1, share / (Number(m[1]) / 100));
      details.push(`一次只问一件事 ${Math.round(share * 100)}%`);
    } else if (key === "rapport_no_blame") {
      const minus = st.turns.flatMap((t) => t.gate?.trust_moves ?? []).filter((m) => m.dir === "minus");
      frac = minus.length === 0 ? 1 : 0;
      if (minus.length) details.push(`减分行为:${minus.map((m) => m.what).join("、")}`);
    } else throw new Error(`d3_points 里有不认识的键: ${key}`);
    score += pts * frac;
  }
  if (qs.length === 0) details.push("没有提问");
  return { id: "D3", name: "", max, score: r1(clamp(score, 0, max)), details };
}

function d4(scn: LoadedScenario, judge: JudgeOutput, max: number): DimensionScore {
  const rules = scn.data.rubric.d4_rules;
  const items = scn.data.truth.diagnosis_items;
  const wsum = items.reduce((s, t) => s + t.weight, 0);
  let raw = 0;
  const details: string[] = [];
  for (const it of items) {
    const j = judge.T.find((t) => t.id === it.id);
    const verdict = j?.verdict ?? "miss";
    let v = it.weight * rules[verdict];
    if (j?.grade === "D" && v > 0) v *= rules.grade_D_multiplier;
    raw += v;
    details.push(`${it.id} ${verdict}${j?.grade ? `·${j.grade}` : ""} ${v >= 0 ? "+" : ""}${r1(v)}`);
  }
  return { id: "D4", name: "", max, score: r1(clamp((raw * max) / wsum, 0, max)), details };
}

function d5(scn: LoadedScenario, st: SessionState, judge: JudgeOutput, max: number): DimensionScore {
  const minLevel = scn.data.rubric.d1_min_level;
  const ok = (id: string) =>
    hasFactAtLeast(st, id, minLevel) && judge.S.some((s) => s.id === id && s.mentioned_in_judgment);
  let score = 0;
  const details: string[] = [];
  for (const [key, pts] of Object.entries(scn.data.rubric.d5_points)) {
    const m = key.match(/^any_of_(.+)_each$/);
    const ids = m ? m[1]!.split("_") : [key];
    for (const id of ids) {
      if (ok(id)) {
        score += pts;
        details.push(`${id} +${pts}`);
      }
    }
  }
  return { id: "D5", name: "", max, score: r1(clamp(score, 0, max)), details };
}

function d6(scn: LoadedScenario, st: SessionState, max: number): DimensionScore {
  const p = scn.data.rubric.d6_penalties;
  const details: string[] = [];
  let score = max;
  const live = st.ledger.filter((e) => e.type !== "solution");
  const hit = (cond: boolean, pts: number, label: string) => {
    if (!cond) return;
    score -= pts;
    details.push(`${label} -${pts}`);
  };
  hit(live.some((e) => e.type === "time" && e.premature), p.premature_time, "过早承诺工期");
  hit(live.some((e) => e.type === "price" && e.premature), p.premature_price, "过早报价");
  hit(live.some((e) => e.type === "accuracy"), p.accuracy_guarantee, "保证准确率");
  hit(st.events.some((e) => e.type === "premature_solution"), p.premature_solution, "过早给方案");
  const recovered = live.filter((e) => e.retractedTurn !== undefined && (e.premature || e.type === "accuracy")).length;
  if (recovered) {
    score += recovered * scn.data.rubric.d6_recover_per_retraction;
    details.push(`明确收回 ${recovered} 项 +${recovered * scn.data.rubric.d6_recover_per_retraction}`);
  }
  return { id: "D6", name: "", max, score: r1(clamp(score, 0, max)), details };
}

function d7(scn: LoadedScenario, judge: JudgeOutput, max: number): DimensionScore {
  let score = 0;
  const details: string[] = [];
  for (const w of scn.data.rubric.d7_checklist) {
    if (judge.W.some((x) => x.id === w.id && x.met)) {
      score += w.points;
      details.push(`${w.id} +${w.points}`);
    }
  }
  return { id: "D7", name: "", max, score: r1(clamp(score, 0, max)), details };
}

export function scoreSession(scn: LoadedScenario, st: SessionState, judge: JudgeOutput): ScoreReport {
  const dims = scn.data.rubric.dimensions;
  const fns: Record<string, (max: number) => DimensionScore> = {
    D1: (m) => d1(scn, st, m),
    D2: (m) => d2(scn, st, judge, m),
    D3: (m) => d3(scn, st, m),
    D4: (m) => d4(scn, judge, m),
    D5: (m) => d5(scn, st, judge, m),
    D6: (m) => d6(scn, st, m),
    D7: (m) => d7(scn, judge, m),
  };
  const dimensions = dims.map((dim) => {
    const fn = fns[dim.id];
    if (!fn) throw new Error(`没有实现评分维度 ${dim.id}`);
    return { ...fn(dim.max), name: dim.name };
  });

  const caps: ScoreReport["caps"] = [];
  const badges: string[] = [];
  const resolver = stateResolver(st, scn);
  for (const c of scn.data.rubric.caps) {
    if (!evalExpr(c.if, resolver)) continue;
    caps.push({ label: c.label, ...(c.total_max !== undefined && { total_max: c.total_max }), ...(c.set && { set: c.set }) });
    for (const [dimId, v] of Object.entries(c.set ?? {})) {
      const d = dimensions.find((x) => x.id === dimId);
      if (d) {
        d.score = v;
        d.details.push(`封顶规则「${c.label}」:记 ${v}`);
      }
    }
    if (c.badge) badges.push(c.badge);
  }

  const rawTotal = r1(dimensions.reduce((s, d) => s + d.score, 0));
  let total = Math.round(rawTotal);
  for (const c of caps) if (c.total_max !== undefined) total = Math.min(total, c.total_max);
  const band = BANDS.find(([min]) => total >= min)?.[1] ?? "";
  return { dimensions, rawTotal, total, caps, badges, band };
}
