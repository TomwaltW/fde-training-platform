// --live 之前先查 Key:缺 Key 时闸门会悄悄退化成"什么都没命中"、演员全走兜底台词,
// 跑出来的门槛表全是假数。所以缺 Key 直接报错退出(退出码 2),点名缺哪个变量。
import type { ModelsConfig } from "@fde/llm";

type Stage = keyof ModelsConfig["stages"];

export function liveEnvProblem(cfg: ModelsConfig, env: Record<string, string | undefined>, stages: Stage[]): string | null {
  const missing: string[] = [];
  for (const s of stages) {
    const sc = cfg.stages[s];
    const provider = cfg.providers[sc.provider];
    if (!provider) return `模型配置里没有 provider ${sc.provider}(${s} 环节)`;
    if (!env[provider.api_key_env]?.trim()) missing.push(`${provider.api_key_env}(${s} 环节用 ${sc.provider} 的 ${sc.model})`);
  }
  return missing.length ? `缺少环境变量 ${[...new Set(missing)].join("、")}` : null;
}
