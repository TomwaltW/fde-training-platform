// 登录态:cookie `fde_session` 里放随机 token,库里只存 sha256(FDE_AUTH_SECRET + token)。
// 不用 next/headers 的 cookies():直接解析请求头、用 Set-Cookie 写回,这样测试里可以直接调用路由函数。
import { createHash, randomBytes } from "node:crypto";
import type { Me, User } from "@fde/contracts";
import { authSecret, cookieSecure, isAdminEmail } from "./env.ts";
import { HttpError, MESSAGES } from "./http.ts";
import { getStore } from "./store.ts";

export const SESSION_COOKIE = "fde_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 验证码和 token 都只存这个哈希。 */
export function secretHash(value: string): string {
  return createHash("sha256").update(authSecret() + value).digest("hex");
}

export function newAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function cookieAttrs(maxAge: number): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (cookieSecure()) attrs.push("Secure");
  return attrs.join("; ");
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs(SESSION_TTL_SECONDS)}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs(0)}`;
}

export function toMe(user: User): Me {
  return { id: user.id, email: user.email, isAdmin: isAdminEmail(user.email), consentAt: user.consentAt };
}

export interface AuthContext {
  user: User;
  isAdmin: boolean;
  tokenHash: string;
}

/** 当前登录用户;没登录或 token 过期返回 null。 */
export async function currentAuth(req: Request): Promise<AuthContext | null> {
  const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = secretHash(token);
  const store = await getStore();
  const user = await store.getUserByAuthToken(tokenHash, new Date().toISOString());
  if (!user) return null;
  return { user, isAdmin: isAdminEmail(user.email), tokenHash };
}

export async function requireUser(req: Request): Promise<AuthContext> {
  const auth = await currentAuth(req);
  if (!auth) throw new HttpError("unauthorized", MESSAGES.unauthorized);
  return auth;
}

export async function requireAdmin(req: Request): Promise<AuthContext> {
  const auth = await requireUser(req);
  if (!auth.isAdmin) throw new HttpError("forbidden", MESSAGES.forbidden);
  return auth;
}
