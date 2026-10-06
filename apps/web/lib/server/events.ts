// 事件(方案 2.2「自建 events 表」):服务端在关键节点记一条,浏览器经 POST /api/events 上报白名单里的几种。
// 记事件失败只打日志,绝不影响业务请求。
import { randomBytes } from "node:crypto";
import type { EventType } from "@fde/contracts";
import { parseCookies } from "./auth.ts";
import { cookieSecure } from "./env.ts";
import { getStore } from "./store.ts";

/** 匿名访客 id 的 cookie:把"第一次打开落地页"和"登录后的第一句话"连起来。 */
export const VISITOR_COOKIE = "fde_vid";
const VISITOR_TTL_SECONDS = 365 * 24 * 60 * 60;
const VISITOR_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function visitorIdFrom(req: Request): string | null {
  const v = parseCookies(req.headers.get("cookie"))[VISITOR_COOKIE];
  return v && VISITOR_RE.test(v) ? v : null;
}

export function newVisitorId(): string {
  return randomBytes(16).toString("base64url");
}

export function visitorCookie(id: string): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${VISITOR_TTL_SECONDS}`];
  if (cookieSecure()) attrs.push("Secure");
  return `${VISITOR_COOKIE}=${id}; ${attrs.join("; ")}`;
}

export interface EventInput {
  type: EventType;
  userId?: string | null;
  sessionId?: string | null;
  visitorId?: string | null;
  props?: Record<string, unknown>;
  /** 默认现在。 */
  at?: string;
}

/** 记一条事件。永不抛错。 */
export async function recordEvent(e: EventInput): Promise<void> {
  try {
    const store = await getStore();
    await store.logEvent({
      at: e.at ?? new Date().toISOString(),
      type: e.type,
      userId: e.userId ?? null,
      sessionId: e.sessionId ?? null,
      visitorId: e.visitorId ?? null,
      props: e.props ?? {},
    });
  } catch (err) {
    console.error(`[events] 记录 ${e.type} 失败`, err);
  }
}
