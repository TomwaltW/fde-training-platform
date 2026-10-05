// POST /api/events 的限频:同一访客每分钟最多 60 条,超了照样 204,只是不入库。
// 计数放在进程内存里(单实例部署够用),挂在 globalThis 上,开发模式热更新时不会清零。

export const EVENTS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

interface EventLimiter {
  /** key → 最近一分钟内入库的时间戳(毫秒,从早到晚)。 */
  hits: Map<string, number[]>;
  lastSweep: number;
}

const KEY = Symbol.for("fde.web.events-rate-limit");

function limiter(): EventLimiter {
  const g = globalThis as unknown as Record<symbol, EventLimiter | undefined>;
  return (g[KEY] ??= { hits: new Map(), lastSweep: 0 });
}

/** 每分钟最多清一次早已过期的 key,免得访客多了以后表越来越大。 */
function sweep(l: EventLimiter, now: number) {
  if (now - l.lastSweep < WINDOW_MS) return;
  l.lastSweep = now;
  for (const [key, ts] of l.hits) {
    const last = ts[ts.length - 1];
    if (last === undefined || now - last >= WINDOW_MS) l.hits.delete(key);
  }
}

/** 还有额度就记一次并返回 true;这一分钟已经满了返回 false(不记)。 */
export function takeEventQuota(key: string, now: number = Date.now()): boolean {
  const l = limiter();
  sweep(l, now);
  const recent = (l.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  const ok = recent.length < EVENTS_PER_MINUTE;
  if (ok) recent.push(now);
  l.hits.set(key, recent);
  return ok;
}

/** 测试用:清空计数。 */
export function resetEventQuotaForTests(): void {
  const l = limiter();
  l.hits.clear();
  l.lastSweep = 0;
}
