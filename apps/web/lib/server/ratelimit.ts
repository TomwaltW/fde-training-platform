// 进程内的滑动窗口限频。单实例部署(本项目的部署方式)够用;以后多实例要换成共享存储。
import { runtime } from "./runtime.ts";

export const LIMITS = {
  /** 同一 IP 每 10 分钟最多请求 20 次验证码:挡住批量探测哪些邮箱注册过、批量给别人发验证码邮件。 */
  requestCodePerIp: { limit: 20, windowMs: 10 * 60 * 1000 },
  /** 每个验证码本身最多试 5 次;再加一道同一 IP 每 10 分钟 30 次,挡住换着邮箱撞验证码。 */
  verifyPerIp: { limit: 30, windowMs: 10 * 60 * 1000 },
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
