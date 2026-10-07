// pnpm playtest 的启动前检查(纯函数:给环境变量,返回错误、提醒、要打印的行和要补给网页的环境变量)。
// 为什么不直接 pnpm dev:web:Next.js 只读 apps/web 下的 .env,不读仓库根目录的 .env——Key 写在根目录 .env 里时
// 网页会悄悄退回离线模式(模板台词),一场试玩就白约了;只有百炼 Key 没有 DeepSeek Key 时能玩、收工时裁判却失败。
// 这里把这两种情况挡在启动之前,其余只做提醒。
import { resolve } from "node:path";
import { STAGES, loadModelsConfig, type ModelsConfig } from "@fde/llm";
import { defaultStoreFile, describeTarget, webDir, webStoreTarget, type Env } from "../sessions/store.ts";

export interface PreflightInput {
  env: Env;
  repoRoot: string;
  /** --offline:只彩排流程(登录、邀请码、导出),不调模型。 */
  offline: boolean;
}

export interface Preflight {
  /** 有一条就不启动(退出码 2)。 */
  errors: string[];
  warnings: string[];
  /** [标签, 内容],启动前打印。 */
  info: [string, string][];
  /** 补给网页进程的环境变量(覆盖同名变量)。 */
  env: Record<string, string>;
}

const STAGE_NAMES: Record<(typeof STAGES)[number], string> = { gate: "闸门", actor: "演员", judge: "裁判", debrief: "复盘" };

/** 和网页的 adminEmails() 一样:逗号分隔、去空格、转小写。 */
export function parseAdminEmails(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** 和网页的 dailySessionLimit() 一样:非负整数,否则 3。 */
export function parseDailyLimit(v: string | undefined): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

/** 模型配置里各环节要的 Key,缺了的按变量名合并:DEEPSEEK_API_KEY(裁判 deepseek/deepseek-v4-pro)。 */
export function missingModelKeys(cfg: ModelsConfig, env: Env): string[] {
  const missing = new Map<string, string[]>();
  for (const stage of STAGES) {
    const sc = cfg.stages[stage];
    const key = cfg.providers[sc.provider]!.api_key_env;
    if (env[key]?.trim()) continue;
    missing.set(key, [...(missing.get(key) ?? []), `${STAGE_NAMES[stage]} ${sc.provider}/${sc.model}`]);
  }
  return [...missing.entries()].map(([key, uses]) => `${key}(${uses.join("、")})`);
}

export function preflight({ env, repoRoot, offline }: PreflightInput): Preflight {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: [string, string][] = [];
  const patch: Record<string, string> = {};

  // ---------- 引擎:试玩必须是真模型;--offline 只彩排
  if (offline) {
    patch.FDE_ENGINE_MODE = "offline";
    info.push(["引擎", "offline(关键词闸门 + 模板台词,不调模型)"]);
    warnings.push("--offline 只用来彩排流程(登录、发邀请码、导出):这样玩出来的对局不算 L1 试玩,也不要拿去标定。");
  } else {
    if (env.FDE_ENGINE_MODE === "offline") {
      errors.push("环境变量里有 FDE_ENGINE_MODE=offline,网页会用模板台词。试玩要真模型:去掉这个变量;只想彩排流程就加 --offline。");
    }
    // 和网页的 createChat() 一样读 FDE_MODELS_CONFIG(相对路径按 apps/web 解析)
    const cfgPath = env.FDE_MODELS_CONFIG ? resolve(webDir(repoRoot), env.FDE_MODELS_CONFIG) : resolve(repoRoot, "config/models.yaml");
    let cfg: ModelsConfig | undefined;
    try {
      cfg = loadModelsConfig(cfgPath);
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (cfg) {
      const missing = missingModelKeys(cfg, env);
      if (missing.length) {
        errors.push(`缺少模型 Key:${missing.join(";")}。写进仓库根目录的 .env(见 .env.example);没有 Key 时只能 --offline 彩排。`);
      }
      info.push(["引擎", `live:${STAGES.map((s) => `${STAGE_NAMES[s]} ${cfg.stages[s].provider}/${cfg.stages[s].model}`).join(" · ")}`]);
    }
    // 网页不设 FDE_ENGINE_MODE 时按"有没有百炼 Key"判断;这里写死成 live,Key 的检查已经在上面做过
    patch.FDE_ENGINE_MODE = "live";
  }

  // ---------- 存储:和网页同一个库,导出时才找得到
  const target = webStoreTarget(env, repoRoot);
  if (target.kind === "memory") {
    if (env.FDE_MEMORY_STORE_FILE !== undefined && !env.FDE_MEMORY_STORE_FILE.trim()) {
      warnings.push(`FDE_MEMORY_STORE_FILE 是空的,网页会退回纯内存、重启就全丢;已改用默认文件 ${defaultStoreFile(env, repoRoot)}。`);
    }
    // 写成绝对路径传给网页:和这里打印的、pnpm session:export 读的保证是同一个文件
    patch.FDE_MEMORY_STORE_FILE = target.file;
    info.push(["存储", `${describeTarget(target)}(重启不丢;试玩期间别删)`]);
  } else {
    info.push(["存储", `${describeTarget(target)}(DATABASE_URL;启动时会建表)`]);
  }

  // ---------- 管理员:没有就进不了 /admin,发不了邀请码
  const admins = parseAdminEmails(env.ADMIN_EMAILS);
  if (!admins.length) {
    errors.push("没设 ADMIN_EMAILS:没有管理员就进不了 /admin、生成不了邀请码。例:ADMIN_EMAILS=you@example.com pnpm playtest(或写进 .env)。");
  } else {
    info.push(["管理员", admins.join("、")]);
  }

  // ---------- 登录验证码:没配发信时只能在页面上显示,这只适合本机和当面
  let devCodes = env.FDE_DEV_LOGIN_CODES === "1";
  if (!devCodes && !env.SMTP_URL?.trim()) {
    patch.FDE_DEV_LOGIN_CODES = "1";
    devCodes = true;
  }
  if (devCodes) {
    info.push(["登录", "验证码直接显示在登录页上(FDE_DEV_LOGIN_CODES=1)"]);
    warnings.push(
      "验证码显示在页面上:谁能打开这个网址,谁就能用任何邮箱登录,包括 ADMIN_EMAILS 里的管理员邮箱。" +
        "只在本机、当面或腾讯会议远程控制时用;不要用隧道、端口转发把它暴露出去(远程试玩的几种做法见 docs/playtest.md)。",
    );
  } else {
    info.push(["登录", "验证码发邮件(SMTP_URL)"]);
  }

  const limit = parseDailyLimit(env.FDE_DAILY_SESSION_LIMIT);
  info.push(["每日局数", `每个账号每天最多开 ${limit} 局(FDE_DAILY_SESSION_LIMIT;同一个账号要连着试玩多局时调大)`]);

  return { errors, warnings, info, env: patch };
}
