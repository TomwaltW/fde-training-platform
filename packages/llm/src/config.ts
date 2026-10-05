import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const STAGES = ["gate", "actor", "judge", "debrief"] as const;
export type Stage = (typeof STAGES)[number];

const Provider = z.strictObject({
  base_url: z.string().url(),
  api_key_env: z.string(),
});

const StageConfig = z.strictObject({
  provider: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2),
  max_tokens: z.number().int().positive(),
  json: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type StageConfig = z.infer<typeof StageConfig>;

export const ModelsConfigSchema = z.strictObject({
  providers: z.record(z.string(), Provider),
  stages: z.strictObject({ gate: StageConfig, actor: StageConfig, judge: StageConfig, debrief: StageConfig }),
  prices: z.record(z.string(), z.tuple([z.number(), z.number()])),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export function loadModelsConfig(path: string): ModelsConfig {
  if (!existsSync(path)) throw new Error(`找不到模型配置 ${path}`);
  const raw = parse(readFileSync(path, "utf8"));
  const r = ModelsConfigSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`模型配置有误:\n${r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  for (const s of STAGES) {
    const p = r.data.stages[s].provider;
    if (!r.data.providers[p]) throw new Error(`模型配置有误:${s} 用了未定义的 provider ${p}`);
  }
  return r.data;
}

/** 元:按 [输入, 输出] 元/百万 token 计。没登记价格的模型记 0 并在日志里标出。 */
export function costYuan(cfg: ModelsConfig, model: string, tokensIn: number, tokensOut: number): number | undefined {
  const p = cfg.prices[model];
  if (!p) return undefined;
  return (tokensIn * p[0] + tokensOut * p[1]) / 1_000_000;
}
