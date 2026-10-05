// rubric 里 d2/d3/d5 点数表的键怎么读。算分和校验器共用这一份解析,
// 场景里写错的键在 pnpm validate 阶段就报出来,而不是等到收工算分时抛异常。

export const IMPLEMENTED_DIMENSIONS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const;

export type D2Key =
  | { kind: "one"; id: string }
  | { kind: "any_two"; ids: string[] }
  | { kind: "or"; ids: string[] }
  | { kind: "two_claims" };

/** A1 / any_two_of_A3_A5_A6_A7 / X2_or_X3 / two_claims_backed_by_data */
export function parseD2Key(key: string): D2Key {
  if (key === "two_claims_backed_by_data") return { kind: "two_claims" };
  if (key.startsWith("any_two_of_")) return { kind: "any_two", ids: key.slice("any_two_of_".length).split("_") };
  if (key.includes("_or_")) return { kind: "or", ids: key.split("_or_") };
  return { kind: "one", id: key };
}

export const d2Ids = (k: D2Key): string[] => (k.kind === "one" ? [k.id] : k.kind === "two_claims" ? [] : k.ids);

export type D3Key =
  | { kind: "open_ratio"; first: number }
  | { kind: "count"; metric: "quantifying" | "follow_up" | "evidence_ask"; atLeast: number }
  | { kind: "single_focus"; pct: number }
  | { kind: "rapport" };

const D3_METRIC = { quantifying: "quantifying", followup: "follow_up", evidence_asks: "evidence_ask" } as const;

/** open_ratio_first8 / quantifying_ge4 / followup_ge3 / evidence_asks_ge3 / single_focus_ge80pct / rapport_no_blame;不认识返回 null。 */
export function parseD3Key(key: string): D3Key | null {
  let m: RegExpMatchArray | null;
  if ((m = key.match(/^open_ratio_first(\d+)$/))) return { kind: "open_ratio", first: Number(m[1]) };
  if ((m = key.match(/^(quantifying|followup|evidence_asks)_ge(\d+)$/)))
    return { kind: "count", metric: D3_METRIC[m[1] as keyof typeof D3_METRIC], atLeast: Number(m[2]) };
  if ((m = key.match(/^single_focus_ge(\d+)pct$/))) return { kind: "single_focus", pct: Number(m[1]) };
  if (key === "rapport_no_blame") return { kind: "rapport" };
  return null;
}

/** S1 / any_of_S3_S4_S5_each → 事实 id 列表。 */
export function parseD5Key(key: string): { ids: string[]; each: boolean } {
  const m = key.match(/^any_of_(.+)_each$/);
  return m ? { ids: m[1]!.split("_"), each: true } : { ids: [key], each: false };
}
