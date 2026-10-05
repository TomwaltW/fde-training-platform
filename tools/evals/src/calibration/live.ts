// --live:裁判用真模型(config/models.yaml 的 judge 环节,经 @fde/llm 网关)。
// 先查 Key 再动手:缺 Key 时给出清楚的报错,而不是每个用例各失败一遍。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LlmJudge, type JudgePort } from "@fde/engine";
import { createGateway, loadModelsConfig, type LlmCallLog, type ModelsConfig } from "@fde/llm";

/** 裁判环节要用的环境变量缺了就返回说明,齐了返回 null。 */
export function liveJudgeEnvProblem(cfg: ModelsConfig, env: Record<string, string | undefined>): string | null {
  const sc = cfg.stages.judge;
  const provider = cfg.providers[sc.provider];
  if (!provider) return `模型配置里没有 provider ${sc.provider}(judge 环节)`;
  if (!env[provider.api_key_env]?.trim()) {
    return `缺少环境变量 ${provider.api_key_env}(裁判环节用 ${sc.provider} 的 ${sc.model},见 config/models.yaml)`;
  }
  return null;
}

export interface LiveJudge {
  judge: JudgePort;
  calls: LlmCallLog[];
  model: string;
}

/** 读仓库根目录的 .env(有的话)和模型配置,建好裁判。缺 Key 抛错,消息里点名缺哪个变量。 */
export function createLiveJudge(root: string, env: NodeJS.ProcessEnv = process.env): LiveJudge {
  if (env === process.env && existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
  const cfg = loadModelsConfig(env.FDE_MODELS_CONFIG ?? join(root, "config/models.yaml"));
  const problem = liveJudgeEnvProblem(cfg, env);
  if (problem) throw new Error(`${problem}。在仓库根目录的 .env 里配置后重试;没有 Key 时用 --mock。`);
  const calls: LlmCallLog[] = [];
  const chat = createGateway(cfg, { env, onCall: (l) => calls.push(l) });
  return { judge: new LlmJudge(chat), calls, model: `${cfg.stages.judge.provider}/${cfg.stages.judge.model}` };
}
