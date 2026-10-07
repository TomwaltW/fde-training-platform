// 模型预检:pnpm models:check [--stage gate|actor|judge|debrief]… [--strict] [--no-network] [-v]
//   Key 填进 .env 之后第一个要跑的命令。读仓库根目录的 .env(有的话)和 config/models.yaml(或 FDE_MODELS_CONFIG)。
//   静态检查:每个模型都登记了价格;百炼模型固定到带日期的快照名;DeepSeek 提醒上游一变就重跑回归。
//   在线检查:每个环节经网关发一次最小请求(参数和线上一致,只压小 max_tokens),报告 Key 有没有、耗时、token 和花费。
//   --no-network 只做静态检查,Key 只列出有没有,不计入结论。说明见 docs/models.md。
// 退出码:0 都通过(可以有警告);1 有检查没过,或 --strict 下有警告;2 参数或配置错误(配置读不进来、未知环节)。
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { STAGES, loadModelsConfig, preflightExitCode, renderPreflight, runPreflight, type ModelsConfig, type Stage } from "@fde/llm";

const root = resolve(import.meta.dirname, "../../..");
const rel = (p: string) => {
  const r = relative(root, p);
  return r.startsWith("..") || isAbsolute(r) ? p : r;
};

const USAGE = `用法:
  pnpm models:check [--stage <环节>]… [--strict] [--no-network] [-v]
  --stage        只查这个环节(可重复):${STAGES.join(" / ")};不给就全查
  --strict       有警告(快照没固定、DeepSeek 别名)也算不通过
  --no-network   不发请求,只做静态检查(价格、快照)
  -v             打出每次请求网关记下的原始日志和模型回复
说明见 docs/models.md`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        stage: { type: "string", multiple: true },
        strict: { type: "boolean", default: false },
        "no-network": { type: "boolean", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    console.error(`参数错误:${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const picked = values.stage ?? [];
  const unknown = picked.filter((s) => !(STAGES as readonly string[]).includes(s));
  if (unknown.length) {
    console.error(`未知环节 ${unknown.join("、")}(可选 ${STAGES.join(" / ")})\n\n${USAGE}`);
    return 2;
  }

  // 和 pnpm evals --live 一样:仓库根目录有 .env 就读进来(不覆盖已经设了的环境变量)
  const envFile = join(root, ".env");
  const hasEnv = existsSync(envFile);
  if (hasEnv) {
    try {
      process.loadEnvFile(envFile);
    } catch (e) {
      console.error(`无法读取 .env:${(e as Error).message}`);
      return 2;
    }
  }
  const cfgPath = process.env.FDE_MODELS_CONFIG ?? join(root, "config/models.yaml");
  let cfg: ModelsConfig;
  try {
    cfg = loadModelsConfig(cfgPath);
  } catch (e) {
    console.error(`无法读取模型配置 ${rel(resolve(cfgPath))}:${(e as Error).message}`);
    return 2;
  }

  console.log(`模型预检:${rel(resolve(cfgPath))}(${hasEnv ? "已读入仓库根目录的 .env" : "仓库根目录没有 .env,只看当前环境变量"})\n`);
  const report = await runPreflight(cfg, { stages: picked as Stage[], env: process.env, network: !values["no-network"] });
  for (const line of renderPreflight(report, { strict: values.strict!, verbose: values.verbose! })) console.log(line);
  return preflightExitCode(report, values.strict!);
}

process.exit(await main());
