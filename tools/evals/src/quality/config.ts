// config/quality-gates.yaml 的读取与严格校验。写错就报错退出(退出码 2),不按默认值悄悄跑。
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const ratio = z.number().min(0).max(1, "比例写 0–1 的小数(0.85 而不是 85)");
const count = z.number().int().min(0);

const EvalGates = z.strictObject({
  reachability: z.strictObject({ player: z.string().min(1), total_min: z.number().min(0).max(100) }),
  discrimination: z.strictObject({ good: z.string().min(1), rush: z.string().min(1), min_gap: z.number().min(0).max(100) }),
  gate_recall_min: ratio,
  gate_extra_max: ratio,
  turn_latency_p50_max_ms: z.number().int().positive(),
  fallback_rate_max: ratio,
  delivered_leaks_max: count,
  delivered_unlisted_max: count,
  session_cost_yuan: z
    .tuple([z.number().min(0), z.number().min(0)])
    .refine(([lo, hi]) => lo <= hi, "session_cost_yuan 的下限不能大于上限"),
});

const AdversarialGates = z.strictObject({
  min_probes: z.number().int().positive(),
  delivered_leaks_max: count,
  delivered_unlisted_max: count,
});

const KEYS = [...Object.keys(EvalGates.shape), ...Object.keys(AdversarialGates.shape)] as [string, ...string[]];

export const QualityGatesSchema = z.strictObject({
  evals: EvalGates,
  adversarial: AdversarialGates,
  provisional: z.array(z.enum(KEYS)).default([]),
});
export type QualityGates = z.infer<typeof QualityGatesSchema>;

export class QualityGatesError extends Error {}

export function parseQualityGates(raw: unknown, file = "quality-gates.yaml"): QualityGates {
  const r = QualityGatesSchema.safeParse(raw);
  if (!r.success) {
    throw new QualityGatesError(`${file} 有误:\n${r.error.issues.map((i) => `  - ${i.path.join(".") || "(根)"}: ${i.message}`).join("\n")}`);
  }
  return r.data;
}

export function loadQualityGates(path: string): QualityGates {
  if (!existsSync(path)) throw new QualityGatesError(`找不到质量门槛配置 ${path}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new QualityGatesError(`${path} YAML 解析失败:${(e as Error).message}`);
  }
  return parseQualityGates(raw, path);
}
