// 进程内的滑动窗口限频。单实例部署(本项目的部署方式)够用;以后多实例要换成共享存储。
// 全站共用这一份:登录、候补名单登记、浏览器埋点都在这里定额度。
import { visitorIdFrom } from "./events.ts";
import { runtime } from "./runtime.ts";

export const LIMITS = {
  /** 同一 IP 每 10 分钟最多请求 20 次验证码:挡住批量探测哪些邮箱注册过、批量给别人发验证码邮件。 */
  requestCodePerIp: { limit: 20, windowMs: 10 * 60 * 1000 },
  /** 每个验证码本身最多试 5 次;再加一道同一 IP 每 10 分钟 30 次,挡住换着邮箱撞验证码。 */
  verifyPerIp: { limit: 30, windowMs: 10 * 60 * 1000 },
  /**
   * 邀请码在验证通过时才消耗,在那之前同一个码每小时最多给 5 个不同的新地址请求验证码(同一地址重发不算新):
   * 正常人改一两次邮箱足够;防止拿一个码给任意地址批量发验证码邮件或短信。
   */
  requestCodePerInvite: { limit: 5, windowMs: 60 * 60 * 1000 },
  /** 候补名单登记:同一访客 10 分钟 5 次;同一 IP 10 分钟 30 次(换着 cookie 也绕不过去)。 */
  waitlistPerVisitor: { limit: 5, windowMs: 10 * 60 * 1000 },
  waitlistPerIp: { limit: 30, windowMs: 10 * 60 * 1000 },
  /** 浏览器埋点:同一访客每分钟 60 条;同一 IP 每分钟 600 条(防止伪造 cookie 刷库)。 */
  eventsPerVisitor: { limit: 60, windowMs: 60 * 1000 },
  eventsPerIp: { limit: 600, windowMs: 60 * 1000 },
} as const;

/**
 * 客户端 IP:取 X-Forwarded-For 的第一段。线上只有 Caddy 能连到应用(compose 不对外暴露 3000),
 * Caddy 对不受信任的来源会用真实 IP 覆盖这个头,所以第一段就是访客 IP。拿不到时所有人共用一个桶。
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 按访客限频用的键:带着合法的访客 cookie(fde_vid)就按访客,否则按 IP。 */
export function visitorKey(req: Request): string {
  const vid = visitorIdFrom(req);
  return vid ? `vid:${vid}` : `ip:${clientIp(req)}`;
}

/**
 * 同时满足"按访客"和"按 IP"两道额度才放行。先查 IP:IP 已经超了就不再占用访客的额度。
 * 只按访客限的话,脚本每次换一个随机 cookie 就能绕过。
 */
export function allowVisitor(
  bucket: string,
  req: Request,
  perVisitor: { limit: number; windowMs: number },
  perIp: { limit: number; windowMs: number },
  now = Date.now(),
): boolean {
  return allow(`${bucket}:ip`, clientIp(req), perIp.limit, perIp.windowMs, now) && allow(`${bucket}:visitor`, visitorKey(req), perVisitor.limit, perVisitor.windowMs, now);
}

/**
 * 数"不同的成员":windowMs 内同一个 key 下最多出现 limit 个不同的 member。已经出现过的 member 再来照样放行
 * (刷新它的时间);新的 member 超额返回 false。比如"一个邀请码一小时内最多给 5 个不同的地址发验证码"。
 */
export function allowDistinct(bucket: string, key: string, member: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const map = (runtime().rateLimits ??= new Map<string, number[]>());
  const prefix = `${bucket}\u0000${key}\u0000`;
  const live: string[] = [];
  for (const [id, ts] of map) {
    if (!id.startsWith(prefix)) continue;
    if (ts.some((t) => now - t < windowMs)) live.push(id);
    else map.delete(id);
  }
  const id = `${prefix}${member}`;
  if (!live.includes(id) && live.length >= limit) return false;
  map.set(id, [now]);
  return true;
}

/** 只看不记:windowMs 内再来一次会不会超过 limit。几道额度要一起判断时,先都看一遍再一起记(见 login.ts 的短信额度)。 */
export function wouldAllow(bucket: string, key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const ts = runtime().rateLimits?.get(`${bucket}\u0000${key}`) ?? [];
  return ts.filter((t) => now - t < windowMs).length < limit;
}

/** 测试用:清空全部计数(resetForTests 也会清)。 */
export function resetRateLimitsForTests(): void {
  runtime().rateLimits = undefined;
}

/**
 * 记一次并判断是否还在限额内:windowMs 内(含这一次)不超过 limit 次返回 true;超了返回 false,且不记这一次。
 * bucket 区分用途(如 "request-code:ip"),key 是 IP、邮箱之类。
 */
export function allow(bucket: string, key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const map = (runtime().rateLimits ??= new Map<string, number[]>());
  const id = `${bucket}\u0000${key}`;
  const recent = (map.get(id) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    map.set(id, recent);
    return false;
  }
  recent.push(now);
  map.set(id, recent);
  // 顺手清理:表太大时删掉已经过期的键
  if (map.size > 5000) for (const [k, ts] of map) if (!ts.some((t) => now - t < windowMs)) map.delete(k);
  return true;
}
