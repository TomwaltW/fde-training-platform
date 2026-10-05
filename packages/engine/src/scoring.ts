// 算分(方案 3.4.1):全部由代码完成,模型不输出任何分数。
// D1、D2、D6 纯规则;D3 由闸门标签经规则汇总;D4、D5、D7 用裁判抽出的证据(已校验)按规则计算。
import { evalExpr } from "./expr.ts";
import type { JudgeOutput } from "./judge.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import { parseD2Key, parseD3Key, parseD5Key } from "./rubric-keys.ts";
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

/** 资料算"打开过",验证算"做过";按场景里的 id 归属判断,不靠前缀。 */
const opened = (scn: LoadedScenario, st: SessionState, id: string) =>
  scn.experiments.has(id) ? st.experiments[id] !== undefined : st.artifacts[id]?.openedTurn !== undefined;

/** 对一线甩锅(D3 rapport_no_blame 只看这一类减分行为)。 */
const BLAME = /归咎|甩锅/;

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
    const k = parseD2Key(key);
    const ok =
      k.kind === "one"
        ? opened(scn, st, k.id)
        : k.kind === "any_two"
          ? k.ids.filter((id) => opened(scn, st, id)).length >= 2
          : k.kind === "or"
            ? k.ids.some((id) => opened(scn, st, id))
            : judge.T.filter((t) => (t.verdict === "hit" || t.verdict === "partial") && t.grade === "A").length >= 2;
    if (ok) {
      score += pts;
      details.push(`${key} +${pts}`);
    }
  }
  return { id: "D2", name: "", max, score: r1(clamp(score, 0, max)), details };
}

function d3(scn: LoadedScenario, st: SessionState, max: number): DimensionScore {
  const gates = st.turns.map((t) => t.gate).filter((g) => g !== undefined && !g.meta_or_injection);
  // 提问:开放式、量化、追问、一次一件事都按"问"算;要证据还包括直接要资料、要做验证、要授权这类请求
  const qs = gates.filter((g) => g!.acts.includes("ask")).map((g) => g!);
  const asksOrRequests = gates.filter((g) => g!.acts.some((a) => a === "ask" || a.startsWith("request_"))).map((g) => g!);
  const details: string[] = [];
  let score = 0;
  for (const [key, pts] of Object.entries(scn.data.rubric.d3_points)) {
    const k = parseD3Key(key);
    if (!k) throw new Error(`d3_points 里有不认识的键: ${key}`);
    let frac = 0;
    if (k.kind === "open_ratio") {
      const first = qs.slice(0, k.first);
      const ratio = first.length ? first.filter((g) => g.question_tags.open).length / first.length : 0;
      frac = Math.min(1, ratio / 0.5);
      details.push(`前 ${first.length} 问开放式占 ${Math.round(ratio * 100)}%`);
    } else if (k.kind === "count") {
      const pool = k.metric === "evidence_ask" ? asksOrRequests : qs;
      const n = pool.filter((g) => g.question_tags[k.metric]).length;
      frac = Math.min(1, n / k.atLeast);
      details.push(`${key.replace(/_ge\d+$/, "")} ${n} 次`);
    } else if (k.kind === "single_focus") {
      const share = qs.length ? qs.filter((g) => g.question_tags.bundled_count <= 1).length / qs.length : 0;
      frac = Math.min(1, share / (k.pct / 100));
      details.push(`一次只问一件事 ${Math.round(share * 100)}%`);
    } else {
      const blame = st.turns.flatMap((t) => t.gate?.trust_moves ?? []).filter((m) => m.dir === "minus" && BLAME.test(m.what));
      frac = blame.length === 0 ? 1 : 0;
      if (blame.length) details.push(`对一线甩锅 ${blame.length} 次`);
    }
    score += pts * frac;
  }
  if (asksOrRequests.length === 0) details.push("没有提问");
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
    for (const id of parseD5Key(key).ids) {
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
  // 每一类扣一次;这一类里的承诺全部明确收回了,才加回一次(加回不超过这一类的扣分)。
  // 收回后又重新给了坚决承诺,不加回。过早给方案收不回来。
  const cats = [
    { label: "过早承诺工期", pts: p.premature_time, rows: live.filter((e) => e.type === "time" && e.premature) },
    { label: "过早报价", pts: p.premature_price, rows: live.filter((e) => e.type === "price" && e.premature) },
    { label: "保证准确率", pts: p.accuracy_guarantee, rows: live.filter((e) => e.type === "accuracy") },
  ];
  let recovered = 0;
  for (const c of cats) {
    if (!c.rows.length) continue;
    score -= c.pts;
    details.push(`${c.label} -${c.pts}`);
    if (c.rows.every((e) => e.retractedTurn !== undefined)) {
      const back = Math.min(scn.data.rubric.d6_recover_per_retraction, c.pts);
      score += back;
      recovered++;
      details.push(`明确收回「${c.label}」+${back}`);
    }
  }
  if (st.events.some((e) => e.type === "premature_solution")) {
    score -= p.premature_solution;
    details.push(`过早给方案 -${p.premature_solution}`);
  }
  if (recovered) details.push(`明确收回 ${recovered} 项`);
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
