// pnpm playtest 的启动前检查(纯函数:给环境变量,返回错误、提醒、要打印的行和要补给网页的环境变量)。
// 为什么不直接 pnpm dev:web:Next.js 只读 apps/web 下的 .env,不读仓库根目录的 .env——Key 写在根目录 .env 里时
// 网页会悄悄退回离线模式(模板台词),一场试玩就白约了;只有百炼 Key 没有 DeepSeek Key 时能玩、收工时裁判却失败。
// 这里把这两种情况挡在启动之前;环境里有 DATABASE_URL(试玩只用本机的内存库)、验证码既不回显也发不出去时也不启动,其余只做提醒。
import { join, resolve } from "node:path";
import { STAGES, loadModelsConfig, type ModelsConfig } from "@fde/llm";
import { defaultStoreFile, describeTarget, webDir, webEnvFiles, webFdeRoot, type Env } from "../sessions/store.ts";

/** --offline 彩排默认用的内存库文件(相对 FDE_ROOT),和试玩的 .data/dev-store.json 分开。 */
export const REHEARSAL_STORE = ".data/playtest-rehearsal.json";

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
    // 和网页的 createChat() 一样:FDE_MODELS_CONFIG(相对路径按 apps/web 解析),没设才用 <FDE_ROOT>/config/models.yaml;
    // 设成空字符串时网页会去读空路径,这里也不替它补默认值
    let cfg: ModelsConfig | undefined;
    if (env.FDE_MODELS_CONFIG !== undefined && !env.FDE_MODELS_CONFIG.trim()) {
      errors.push("FDE_MODELS_CONFIG 是空的:网页会去读一个空路径,live 模式用不了。去掉这个变量就用 <FDE_ROOT>/config/models.yaml。");
    } else {
      const cfgPath =
        env.FDE_MODELS_CONFIG !== undefined ? resolve(webDir(repoRoot), env.FDE_MODELS_CONFIG) : join(webFdeRoot(env, repoRoot), "config/models.yaml");
      try {
        cfg = loadModelsConfig(cfgPath);
      } catch (e) {
        errors.push((e as Error).message);
      }
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

  // ---------- 存储:只用本机的内存库,和 pnpm session:export 读同一个文件
  if (env.DATABASE_URL?.trim()) {
    errors.push(
      `环境里有 DATABASE_URL(${describeTarget({ kind: "pg", url: env.DATABASE_URL })}):pnpm playtest 只用本机的内存库。` +
        "带着它启动,网页会先在那个库里建表,再把彩排和试玩的对局都写进去;验证码显示在页面上时,能打开网页的人还能登录那个库里的任何账号。" +
        "去掉它再启动(从 .env 里注释掉,或者 DATABASE_URL= pnpm playtest);确实要连 PostgreSQL 试玩,直接用 pnpm dev:web 自己配。",
    );
  }
  // 传空值给网页:next dev 不会用 apps/web/.env* 覆盖已经设了的变量,那里就算写了 DATABASE_URL,网页也一定用内存库
  patch.DATABASE_URL = "";
  const fileVar = env.FDE_MEMORY_STORE_FILE?.trim() ? env.FDE_MEMORY_STORE_FILE : undefined;
  // --offline 彩排默认另用一个文件:离线局混进试玩的库,/admin 的完成率、每局成本、流失轮次就不是试玩的数字了
  const file = fileVar
    ? resolve(webDir(repoRoot), fileVar)
    : offline
      ? join(webFdeRoot(env, repoRoot), REHEARSAL_STORE)
      : defaultStoreFile(env, repoRoot);
  if (env.FDE_MEMORY_STORE_FILE !== undefined && !fileVar) {
    warnings.push(`FDE_MEMORY_STORE_FILE 是空的,网页会退回纯内存、重启就全丢;已改用默认文件 ${file}。`);
  }
  // 写成绝对路径传给网页:和这里打印的、pnpm session:export 读的保证是同一个文件
  patch.FDE_MEMORY_STORE_FILE = file;
  info.push(["存储", `${describeTarget({ kind: "memory", file })}(${offline && !fileVar ? "彩排专用,不和试玩的对局混在一起" : "重启不丢;试玩期间别删"})`]);

  // ---------- 管理员:没有就进不了 /admin,发不了邀请码
  const admins = parseAdminEmails(env.ADMIN_EMAILS);
  if (!admins.length) {
    errors.push("没设 ADMIN_EMAILS:没有管理员就进不了 /admin、生成不了邀请码。例:ADMIN_EMAILS=you@example.com pnpm playtest(或写进 .env)。");
  } else {
    info.push(["管理员", admins.join("、")]);
  }

  // ---------- 登录验证码:没配发信时只能在页面上显示,这只适合本机和当面
  // 网页只认 FDE_DEV_LOGIN_CODES=1;自己设成别的值(比如 0)又没配发信,验证码既不显示也发不出去,谁都登录不了——
  // 不替人改掉,直接不启动。没设或设成空的才替它打开
  let devCodes = env.FDE_DEV_LOGIN_CODES === "1";
  if (!devCodes && !env.SMTP_URL?.trim()) {
    if (env.FDE_DEV_LOGIN_CODES?.trim()) {
      errors.push(
        `环境里有 FDE_DEV_LOGIN_CODES=${env.FDE_DEV_LOGIN_CODES},又没配 SMTP_URL:网页只认 1,验证码既不显示在页面上、也发不出去,谁都登录不了。` +
          "去掉这个变量(pnpm playtest 会让验证码显示在页面上),或者配好 SMTP_URL。",
      );
    } else {
      patch.FDE_DEV_LOGIN_CODES = "1";
      devCodes = true;
    }
  }
  if (devCodes) {
    info.push(["登录", "验证码直接显示在登录页上(FDE_DEV_LOGIN_CODES=1)"]);
    warnings.push(
      "验证码显示在页面上:谁能打开这个网址,谁就能登录任何已注册的账号,包括 ADMIN_EMAILS 里的管理员邮箱(管理员不需要邀请码)。" +
        "只在本机、当面或腾讯会议远程控制时用;不要用隧道、端口转发把它暴露出去(远程试玩的几种做法见 docs/playtest.md)。",
    );
  } else if (env.SMTP_URL?.trim()) {
    info.push(["登录", "验证码发邮件(SMTP_URL)"]);
  } else {
    info.push(["登录", `验证码不显示、也发不出去(FDE_DEV_LOGIN_CODES=${env.FDE_DEV_LOGIN_CODES},没有 SMTP_URL)`]);
  }

  const limit = parseDailyLimit(env.FDE_DAILY_SESSION_LIMIT);
  info.push(["每日局数", `每个账号每天最多开 ${limit} 局(FDE_DAILY_SESSION_LIMIT;同一个账号要连着试玩多局时调大)`]);

  // ---------- apps/web 下的 .env*:next dev 也会读(这里已经设了的变量不会被覆盖),上面的检查却没看它们
  const webEnv = webEnvFiles(repoRoot);
  if (webEnv.length) {
    warnings.push(
      `apps/web 下有 ${webEnv.join("、")}:next dev 也会读,上面的检查没看。Key、ADMIN_EMAILS、SMTP_URL、FDE_DEV_LOGIN_CODES、FDE_ROOT、FDE_MODELS_CONFIG 写在那里时,` +
        "网页和这里看到的不一样;写进仓库根目录的 .env。存储和引擎不受影响(这里传给网页的值优先)。",
    );
  }

  return { errors, warnings, info, env: patch };
}
