// 服务端配置:统一从环境变量读取(变量表见 docs/dev-spec-2026-10-05.md 3.2)。
// 每次调用都现读 process.env,测试里改环境变量后 resetForTests() 即可生效。
import { resolve } from "node:path";

/** 仓库根目录(含 scenarios/ config/ infra/db)。 */
export function fdeRoot(): string {
  const v = process.env.FDE_ROOT;
  return v ? resolve(v) : resolve(process.cwd(), "../..");
}

export type EngineMode = "offline" | "live";

/** offline:关键词闸门 + 模板演员;live:模型。不设时有 DASHSCOPE_API_KEY 就 live。 */
export function engineMode(): EngineMode {
  const m = process.env.FDE_ENGINE_MODE;
  if (m === "offline" || m === "live") return m;
  return process.env.DASHSCOPE_API_KEY ? "live" : "offline";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** FDE_DEV_LOGIN_CODES=1:验证码直接在响应里返回(仅开发和测试)。 */
export function devLoginCodes(): boolean {
  return process.env.FDE_DEV_LOGIN_CODES === "1";
}

const DEV_AUTH_SECRET = "fde-dev-secret-do-not-use-in-production";

/**
 * 验证码、token 哈希的 pepper。生产必填;开发、测试(含 FDE_DEV_LOGIN_CODES=1 的本地 next start)用默认值。
 */
export function authSecret(): string {
  const v = process.env.FDE_AUTH_SECRET;
  if (v) return v;
  if (isProduction() && !devLoginCodes()) throw new Error("生产环境必须设置 FDE_AUTH_SECRET");
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
