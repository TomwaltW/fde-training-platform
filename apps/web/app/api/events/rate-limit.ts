// POST /api/events 的限频:同一访客每分钟最多 60 条(同一 IP 600 条),超了照样 204,只是不入库。
// 计数用全站共用的 ratelimit.ts。
import { LIMITS, allow, allowVisitor, resetRateLimitsForTests } from "../../../lib/server/ratelimit.ts";

export const EVENTS_PER_MINUTE = LIMITS.eventsPerVisitor.limit;

/** 还有额度就记一次并返回 true;超了返回 false(不记)。 */
export function takeEventQuota(req: Request, now: number = Date.now()): boolean {
  return allowVisitor("events", req, LIMITS.eventsPerVisitor, LIMITS.eventsPerIp, now);
}

/** 只按一个键计数(单元测试检查窗口滑动用)。 */
export function takeEventQuotaForKey(key: string, now: number = Date.now()): boolean {
  return allow("events:visitor", key, LIMITS.eventsPerVisitor.limit, LIMITS.eventsPerVisitor.windowMs, now);
}

/** 测试用:清空计数。 */
export const resetEventQuotaForTests = resetRateLimitsForTests;
