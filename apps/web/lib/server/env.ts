// 服务端配置:统一从环境变量读取(变量表见 docs/dev-spec-2026-10-05.md 3.2)。
// 每次调用都现读 process.env,测试里改环境变量后 resetForTests() 即可生效。
import { resolve } from "node:path";

/** 仓库根目录(含 scenarios/ config/ infra/db)。 */
export function fdeRoot(): string {
  const v = process.env.FDE_ROOT;
  return v ? resolve(v) : resolve(process.cwd(), "../..");
}

export type EngineMode = "offline" | "live";

/**
 * offline:关键词闸门 + 模板演员;live:模型。不设时有任何一家的模型 Key(DEEPSEEK_API_KEY、DASHSCOPE_API_KEY)就 live。
 * 只看有没有 Key,不对照 config/models.yaml 每个环节用哪家:缺的那家会在调用时报错点名,pnpm playtest 启动前按配置逐个环节查。
 */
export function engineMode(): EngineMode {
  const m = process.env.FDE_ENGINE_MODE;
  if (m === "offline" || m === "live") return m;
  return process.env.DEEPSEEK_API_KEY || process.env.DASHSCOPE_API_KEY ? "live" : "offline";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * FDE_DEV_LOGIN_CODES=1:验证码直接在响应里返回(仅开发和测试)。
 * 生产环境(NODE_ENV=production)还要同时设 FDE_DEV_LOGIN_CODES_IN_PRODUCTION=1 才生效——只给跑生产构建的
 * 自动化测试用;上线时误开 FDE_DEV_LOGIN_CODES 不会让任何人都能拿到别人(包括管理员)的验证码。
 */
export function devLoginCodes(): boolean {
  if (process.env.FDE_DEV_LOGIN_CODES !== "1") return false;
  return !isProduction() || process.env.FDE_DEV_LOGIN_CODES_IN_PRODUCTION === "1";
}

const DEV_AUTH_SECRET = "fde-dev-secret-do-not-use-in-production";

/** 验证码、token 哈希的 pepper。生产环境必填(没有例外);开发、测试用默认值。 */
export function authSecret(): string {
  const v = process.env.FDE_AUTH_SECRET;
  if (v) return v;
  if (isProduction()) throw new Error("生产环境必须设置 FDE_AUTH_SECRET");
  return DEV_AUTH_SECRET;
}

/** cookie 是否加 Secure:FDE_COOKIE_SECURE 显式给出时按它,否则生产环境加。 */
export function cookieSecure(): boolean {
  const v = process.env.FDE_COOKIE_SECURE;
  if (v === "1") return true;
  if (v === "0") return false;
  return isProduction();
}

/** ADMIN_EMAILS:逗号分隔,不区分大小写。 */
export function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().has(email.trim().toLowerCase());
}

/** 每人每天(UTC+8 自然日)最多开局数。 */
export function dailySessionLimit(): number {
  const v = Number.parseInt(process.env.FDE_DAILY_SESSION_LIMIT ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 3;
}

/** 空字符串按未配置处理。 */
export function optionalEnv(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

// ================================================================ 第三轮

/** 站点对外地址(邀请邮件里的链接用):SITE_URL,没有就用 https://<DOMAIN>,都没有是本地开发地址。 */
export function siteUrl(): string {
  const v = optionalEnv("SITE_URL");
  if (v) return v.replace(/\/+$/, "");
  const domain = optionalEnv("DOMAIN");
  return domain ? `https://${domain}` : "http://localhost:3000";
}

/** 候补名单是否开放登记(WAITLIST_OPEN=0 关闭)。 */
export function waitlistOpen(): boolean {
  return process.env.WAITLIST_OPEN !== "0";
}

export interface SmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  /** 短信签名(审核通过的)。 */
  signName: string;
  /** 验证码模板,内容里用 ${code}。 */
  templateCode: string;
  endpoint: string;
}

/** 阿里云短信:四个变量都填了才算配置好。 */
export function smsConfig(): SmsConfig | null {
  const accessKeyId = optionalEnv("ALIYUN_SMS_ACCESS_KEY_ID");
  const accessKeySecret = optionalEnv("ALIYUN_SMS_ACCESS_KEY_SECRET");
  const signName = optionalEnv("ALIYUN_SMS_SIGN_NAME");
  const templateCode = optionalEnv("ALIYUN_SMS_TEMPLATE_CODE");
  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) return null;
  return { accessKeyId, accessKeySecret, signName, templateCode, endpoint: optionalEnv("ALIYUN_SMS_ENDPOINT") ?? "https://dysmsapi.aliyuncs.com" };
}

/**
 * 是否开放手机号登录:配置了短信;或者开发模式(FDE_DEV_LOGIN_CODES=1)下打开了 FDE_DEV_SMS_LOGIN=1
 * (不真发短信,验证码在响应里回显,用来本地调试和测试)。
 */
export function smsLoginEnabled(): boolean {
  return smsConfig() !== null || (devLoginCodes() && process.env.FDE_DEV_SMS_LOGIN === "1");
}

function intEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** 全站每小时最多发多少条短信(防刷,超了 429)。 */
export function smsHourlyLimit(): number {
  return intEnv("SMS_HOURLY_LIMIT", 100);
}

/** 同一手机号每天(UTC+8)最多发多少条。 */
export function smsDailyPerPhone(): number {
  return intEnv("SMS_DAILY_PER_PHONE", 10);
}

/** 商品与免费场景配置(预售页、兑换码)。 */
export function productsConfigPath(): string {
  return process.env.FDE_PRODUCTS_CONFIG ? resolve(process.env.FDE_PRODUCTS_CONFIG) : resolve(fdeRoot(), "config/products.yaml");
}

/** 方案 6.3 的门槛配置。 */
export function gatesConfigPath(): string {
  return process.env.FDE_GATES_CONFIG ? resolve(process.env.FDE_GATES_CONFIG) : resolve(fdeRoot(), "config/gates.yaml");
}
