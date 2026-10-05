// 标定的两道门槛(方案 3.4.2 第 5、6 条)用到的纯计算:档位、稳定性、一致性。
// 这里不碰文件、不调模型,方便单测把边界钉死。

/** 每个维度的满分等分成几档(档位 0 到 BAND_COUNT-1)。 */
export const BAND_COUNT = 5;
/** 人工与裁判相差不超过几档算一致。 */
export const MAX_BAND_GAP = 1;
/** 一致性门槛:所有用例 × 所有维度里,相差不超过 1 档的比例。 */
export const AGREEMENT_MIN = 0.8;
/** 稳定性门槛:同一对话多次运行的总分极差(±3 即 6)。 */
export const STABILITY_MAX_SPREAD = 6;
/** 默认每个用例跑几次裁判。 */
export const DEFAULT_RUNS = 3;

/** 分数四舍五入到一位小数(和引擎算分的精度一致)。 */
export const r1 = (v: number) => Math.round(v * 10) / 10;

/** 显示用:整数不带小数点,其余保留一位。 */
export const fmt = (v: number) => (Number.isInteger(r1(v)) ? String(r1(v)) : r1(v).toFixed(1));

/**
 * score 落在第几档(0–4)。满分等分成 5 段,左闭右开,满分本身算最高档。
 * 例:满分 20 → [0,4) 第 0 档、[4,8) 第 1 档……[16,20] 第 4 档。
 */
export function bandOf(score: number, max: number): number {
  if (!(max > 0)) throw new Error(`维度满分必须大于 0(实际 ${max})`);
  if (!Number.isFinite(score)) throw new Error(`分数不是有效数字:${score}`);
  // 先乘后除,再加一点余量:避免 2.4/6*5 = 1.9999… 这类浮点误差把边界上的分数落到下一档
  const x = (score * BAND_COUNT) / max;
  return Math.min(BAND_COUNT - 1, Math.max(0, Math.floor(x + 1e-9)));
}

/** 第 band 档对应的分数区间 [lo, hi)(最高档含满分)。 */
export function bandRange(max: number, band: number): [number, number] {
  const w = max / BAND_COUNT;
  return [r1(band * w), r1((band + 1) * w)];
}

export function median(xs: number[]): number {
  if (!xs.length) throw new Error("median: 空数组");
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : r1((s[mid - 1]! + s[mid]!) / 2);
}

// ---------------------------------------------------------------- 稳定性

/** 一次裁判运行的结果(已经过引擎校验与算分)。 */
export interface RunSnapshot {
  total: number;
  /** 维度 id → 分数(封顶规则之后)。 */
  dims: Record<string, number>;
  /** 检查项 id → 判定的简写(T 项 "hit·A"、S/W 项 "是/否")。 */
  items: Record<string, string>;
}

export interface Varying<T> {
  id: string;
  values: T[];
}

export interface StabilityVerdict {
  totals: number[];
  /** 总分极差 max − min。 */
  spread: number;
  ok: boolean;
  /** 不通过的原因(通过时为空)。 */
  reason?: string;
  /** 各次分数不完全相同的维度(通过时也列出,方便提前发现苗头)。 */
  changedDims: Varying<number>[];
  /** 各次判定不完全相同的检查项。 */
  changedItems: Varying<string>[];
}

function varying<T>(keys: string[], rows: Record<string, T>[], missing: T): Varying<T>[] {
  const out: Varying<T>[] = [];
  for (const id of keys) {
    const values = rows.map((r) => (id in r ? r[id]! : missing));
    if (new Set(values).size > 1) out.push({ id, values });
  }
  return out;
}

/** 同一对话跑 N 次:总分极差 ≤ 6(±3)为通过;至少要 2 次才谈得上稳定。 */
export function checkStability(runs: RunSnapshot[]): StabilityVerdict {
  const totals = runs.map((r) => r.total);
  const spread = totals.length ? r1(Math.max(...totals) - Math.min(...totals)) : 0;
  const dimKeys = [...new Set(runs.flatMap((r) => Object.keys(r.dims)))];
  const itemKeys = [...new Set(runs.flatMap((r) => Object.keys(r.items)))];
  const changedDims = varying(dimKeys, runs.map((r) => r.dims), Number.NaN);
  const changedItems = varying(itemKeys, runs.map((r) => r.items), "(缺)");
  let reason: string | undefined;
  if (runs.length < 2) reason = `只跑了 ${runs.length} 次,至少 2 次才能看稳定性`;
  else if (spread > STABILITY_MAX_SPREAD) reason = `总分极差 ${fmt(spread)} 超过 ${STABILITY_MAX_SPREAD}(±${STABILITY_MAX_SPREAD / 2})`;
  return { totals, spread, ok: reason === undefined, ...(reason && { reason }), changedDims, changedItems };
}

// ---------------------------------------------------------------- 一致性

export interface AgreementCell {
  caseId: string;
  dim: string;
  max: number;
  human: number;
  judge: number;
  humanBand: number;
  judgeBand: number;
  /** 档位差的绝对值。 */
  gap: number;
  ok: boolean;
}

export function compareCell(caseId: string, dim: string, max: number, human: number, judge: number): AgreementCell {
  const humanBand = bandOf(human, max);
  const judgeBand = bandOf(judge, max);
  const gap = Math.abs(humanBand - judgeBand);
  return { caseId, dim, max, human, judge, humanBand, judgeBand, gap, ok: gap <= MAX_BAND_GAP };
}

export interface DimAgreement {
  dim: string;
  agreed: number;
  total: number;
  /** 这个维度上差异最大的用例(档位差大的在前,同档差按分差),最多 3 个,只列有差异的。 */
  worst: AgreementCell[];
}

export interface AgreementSummary {
  cells: AgreementCell[];
  agreed: number;
  total: number;
  /** 一致的比例;没有任何可比的单元格时为 0。 */
  ratio: number;
  ok: boolean;
  byDim: DimAgreement[];
}

const byDisagreement = (a: AgreementCell, b: AgreementCell) =>
  b.gap - a.gap || Math.abs(b.human - b.judge) / b.max - Math.abs(a.human - a.judge) / a.max;

/** 汇总所有用例 × 维度:相差不超过 1 档的比例 ≥ 80% 为通过。 */
export function summarizeAgreement(cells: AgreementCell[], dims: string[]): AgreementSummary {
  const agreed = cells.filter((c) => c.ok).length;
  const total = cells.length;
  const ratio = total ? agreed / total : 0;
  const byDim = dims.map((dim) => {
    const mine = cells.filter((c) => c.dim === dim);
    const worst = mine
      .filter((c) => c.gap > 0 || c.human !== c.judge)
      .sort(byDisagreement)
      .slice(0, 3);
    return { dim, agreed: mine.filter((c) => c.ok).length, total: mine.length, worst };
  });
  // 比较时留一点余量:12/15 这类恰好 80% 的情况不能因为浮点误差判成不过
  return { cells, agreed, total, ratio, ok: total > 0 && ratio >= AGREEMENT_MIN - 1e-12, byDim };
}
