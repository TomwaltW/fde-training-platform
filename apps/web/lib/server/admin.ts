// 管理接口的计算:统计、对局列表、反馈行。
import type { AdminSessionRow, AdminStats, FeedbackRow, Store, StoredFeedback, StoredSession } from "@fde/contracts";
import { userLabel } from "./auth.ts";
import { sessionSummaries } from "./sessions.ts";

/** 统计时一页取多少局(按开始时间倒序翻页)。 */
const PAGE = 500;

export async function allSessions(store: Store): Promise<StoredSession[]> {
  const out: StoredSession[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await store.listAllSessions(PAGE, before);
    out.push(...page);
    if (page.length < PAGE) return out;
    before = page[page.length - 1]!.startedAt;
  }
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const BUCKETS = ["0-9", "10-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70-79", "80-89", "90-100"];

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export async function computeStats(store: Store): Promise<AdminStats> {
  const [users, sessions, feedback, costYuanTotal] = await Promise.all([
    store.countUsers(),
    allSessions(store),
    store.listFeedback(),
    store.totalCostYuan(),
  ]);
  const disputed = new Set(feedback.filter((f) => f.dispute).map((f) => f.sessionId));

  const reports = await Promise.all(sessions.map((s) => store.getReport(s.id)));
  const finished: { s: StoredSession; total: number }[] = [];
  const unfinished: StoredSession[] = [];
  sessions.forEach((s, i) => {
    const r = reports[i];
    if (r) finished.push({ s, total: r.report.score.total });
    else unfinished.push(s);
  });

  const histogram = BUCKETS.map((bucket) => ({ bucket, count: 0 }));
  for (const { total } of finished) {
    const i = Math.min(BUCKETS.length - 1, Math.max(0, Math.floor(total / 10)));
    histogram[i]!.count += 1;
  }

  // 没收工(没出复盘)的对局停在第几轮
  const drop = new Map<number, number>();
  for (const s of unfinished) drop.set(s.state.turn, (drop.get(s.state.turn) ?? 0) + 1);

  const started = sessions.length;
  return {
    users,
    sessionsStarted: started,
    sessionsFinished: finished.length,
    completionRate: started ? round(finished.length / started, 4) : 0,
    medianMinutesUsed: median(finished.map((f) => f.s.state.minutesUsed)),
    medianTotal: median(finished.map((f) => f.total)),
    disputeRate: finished.length ? round(finished.filter((f) => disputed.has(f.s.id)).length / finished.length, 4) : 0,
    costYuanTotal: round(costYuanTotal, 6),
    costYuanPerSession: started ? round(costYuanTotal / started, 6) : null,
    scoreHistogram: histogram,
    dropOffByTurn: [...drop.entries()].sort((a, b) => a[0] - b[0]).map(([turn, count]) => ({ turn, count })),
  };
}

/** 用户邮箱查询带缓存(一页里同一个人的对局很多)。 */
export function emailLookup(store: Store) {
  const cache = new Map<string, Promise<string>>();
  return (userId: string): Promise<string> => {
    let p = cache.get(userId);
    if (!p) {
      p = store.getUser(userId).then((u) => (u ? userLabel(u) : "(已删除的用户)"));
      cache.set(userId, p);
    }
    return p;
  };
}

export async function adminSessionRows(store: Store, sessions: StoredSession[]): Promise<AdminSessionRow[]> {
  const email = emailLookup(store);
  const summaries = await sessionSummaries(store, sessions);
  return Promise.all(
    sessions.map(async (s, i) => {
      const calls = await store.listLlmCalls(s.id);
      return {
        ...summaries[i]!,
        userEmail: await email(s.userId),
        turns: s.state.turn,
        costYuan: round(
          calls.reduce((sum, c) => sum + (c.costYuan ?? 0), 0),
          6,
        ),
      };
    }),
  );
}

export async function feedbackRows(store: Store, rows: StoredFeedback[]): Promise<FeedbackRow[]> {
  const email = emailLookup(store);
  return Promise.all(
    rows.map(async (f) => ({
      sessionId: f.sessionId,
      userEmail: await email(f.userId),
      rating: f.rating,
      text: f.text,
      dispute: f.dispute,
      wantNext: f.wantNext,
      createdAt: f.createdAt,
    })),
  );
}
