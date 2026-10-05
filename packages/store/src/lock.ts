// 进程内的会话互斥锁。MemoryStore 和 PgStore 共用同一个(单机部署,一个 Node 进程)。
// 同一 key 的任务排队串行;等锁超时抛 SessionBusyError;timeoutMs <= 0 表示拿不到立即失败。
import { SessionBusyError } from "@fde/contracts";

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

interface Waiter {
  grant: () => void;
}

interface LockEntry {
  /** 排队等锁的任务,按先来后到。 */
  waiters: Waiter[];
}

/**
 * key → 锁。Map 里有这个 key 就表示锁被占用。
 * 挂在 globalThis 上:Next 把各个路由分别打包时,即使本模块被加载多份,同一进程里也只有一张锁表。
 */
const LOCKS_KEY = Symbol.for("fde.store.session-locks");
const g = globalThis as unknown as Record<symbol, Map<string, LockEntry> | undefined>;
const locks: Map<string, LockEntry> = (g[LOCKS_KEY] ??= new Map());

function release(key: string) {
  const entry = locks.get(key);
  if (!entry) return;
  const next = entry.waiters.shift();
  // 直接把锁交给下一个等待者,中间不释放,避免被新来的插队
  if (next) next.grant();
  else locks.delete(key);
}

/** 拿锁。必须同步完成"没人占就占上"这一步,这样同一 tick 里先调用的一定先拿到。 */
function acquire(key: string, timeoutMs: number): Promise<void> {
  const entry = locks.get(key);
  if (!entry) {
    locks.set(key, { waiters: [] });
    return Promise.resolve();
  }
  if (timeoutMs <= 0) return Promise.reject(new SessionBusyError(key));
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    const timer = setTimeout(() => {
      const i = entry.waiters.indexOf(waiter);
      if (i >= 0) entry.waiters.splice(i, 1);
      reject(new SessionBusyError(key));
    }, timeoutMs);
    entry.waiters.push(waiter);
  });
}

export async function withProcessLock<T>(key: string, fn: () => Promise<T>, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS): Promise<T> {
  await acquire(key, timeoutMs);
  try {
    return await fn();
  } finally {
    release(key);
  }
}
