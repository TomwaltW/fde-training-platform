// 持久化契约(本轮冻结)。两套实现:MemoryStore(本地开发、测试;可选落盘 JSON)和 PgStore(线上 PostgreSQL 16)。
// 两套实现必须通过同一套一致性测试(packages/store/test/conformance.ts)。
// 表结构见 infra/db/001_init.sql(同样冻结)。所有时间都是 ISO 8601 字符串(UTC)。
import type { SessionReport, SessionState } from "@fde/engine";

export interface User {
  id: string;
  email: string;
  createdAt: string;
  consentAt: string | null;
}

export type SessionStatus = "active" | "ended";

export interface StoredSession {
  id: string;
  userId: string;
  scenarioId: string;
  state: SessionState;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  /** 乐观锁版本号,创建时为 1,每次 saveSession 成功加 1。 */
  version: number;
}

export interface StoredReport {
  sessionId: string;
  report: SessionReport;
  createdAt: string;
}

export interface StoredFeedback {
  sessionId: string;
  userId: string;
  rating: number | null;
  text: string | null;
  dispute: { dimension: string; reason: string } | null;
  createdAt: string;
}

export interface StoredLlmCall {
  sessionId: string | null;
  at: string;
  stage: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costYuan: number | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
}

/** saveSession 的版本号对不上(别的请求先写了)。 */
export class VersionConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} 版本冲突`);
    this.name = "VersionConflictError";
  }
}

/** withSessionLock 等锁超时(默认 30 秒)。 */
export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} 正在处理另一个请求`);
    this.name = "SessionBusyError";
  }
}

export interface Store {
  /** 建表/迁移。PgStore 按顺序执行 infra/db/*.sql(已执行过的跳过);MemoryStore 什么都不做。可重复调用。 */
  migrate(): Promise<void>;
  close(): Promise<void>;

  // ---------- 邀请码
  /** 生成 count 个随机邀请码(8 位,大写字母和数字,去掉易混的 0O1I),每个可用 maxUses 次。 */
  createInvites(count: number, maxUses: number, note?: string): Promise<string[]>;
  /** 有效且未用尽则用掉一次并返回 true;无效或用尽返回 false。并发调用不能超用。 */
  redeemInvite(code: string): Promise<boolean>;

  // ---------- 用户
  /** email 统一小写后存。已存在时抛错(调用方应先 getUserByEmail)。 */
  createUser(email: string): Promise<User>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  setConsent(userId: string, at: string): Promise<void>;
  countUsers(): Promise<number>;

  // ---------- 登录验证码(只存哈希)
  /** 覆盖该邮箱之前的验证码,尝试次数清零。 */
  saveLoginCode(email: string, codeHash: string, expiresAt: string): Promise<void>;
  /**
   * 校验:哈希相同且未过期且尝试次数 < 5 → 删除这条验证码并返回 true;
   * 否则尝试次数 +1 并返回 false。没有验证码返回 false。
   */
  verifyLoginCode(email: string, codeHash: string, now: string): Promise<boolean>;

  // ---------- 登录态(cookie 里放随机 token,库里只存哈希)
  createAuthToken(userId: string, tokenHash: string, expiresAt: string): Promise<void>;
  /** token 存在且未过期返回用户,否则 null。 */
  getUserByAuthToken(tokenHash: string, now: string): Promise<User | null>;
  deleteAuthToken(tokenHash: string): Promise<void>;

  // ---------- 对局
  createSession(s: Omit<StoredSession, "version" | "endedAt" | "status">): Promise<StoredSession>;
  getSession(id: string): Promise<StoredSession | null>;
  /** 本人的对局,按 startedAt 倒序。 */
  listSessions(userId: string): Promise<StoredSession[]>;
  /** 所有人的对局,按 startedAt 倒序;before 给出时只返回更早的。 */
  listAllSessions(limit: number, before?: string): Promise<StoredSession[]>;
  countSessionsSince(userId: string, since: string): Promise<number>;
  /**
   * 乐观锁写入:当前版本等于 expectedVersion 才写,返回新版本号;否则抛 VersionConflictError。
   * status 为 "ended" 时同时写 endedAt(调用方给出)。
   */
  saveSession(id: string, state: SessionState, expectedVersion: number, end?: { endedAt: string }): Promise<number>;
  /**
   * 同一 sessionId 的 fn 串行执行(同一进程内);等锁超过 timeoutMs(默认 30000)抛 SessionBusyError。
   * fn 抛错时锁也要释放。
   */
  withSessionLock<T>(id: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
  /** 删除该用户的所有对局及其复盘、反馈、模型调用记录;返回删除的对局数。 */
  deleteUserSessions(userId: string): Promise<number>;

  // ---------- 复盘
  /** 一局一份;重复保存覆盖。 */
  saveReport(sessionId: string, report: SessionReport, createdAt: string): Promise<void>;
  getReport(sessionId: string): Promise<StoredReport | null>;

  // ---------- 反馈与申诉
  addFeedback(f: StoredFeedback): Promise<void>;
  listFeedback(opts?: { sessionId?: string; limit?: number }): Promise<StoredFeedback[]>;

  // ---------- 模型调用日志
  logLlmCall(c: StoredLlmCall): Promise<void>;
  listLlmCalls(sessionId: string): Promise<StoredLlmCall[]>;
  /** 所有调用的总花费(元),costYuan 为 null 的按 0 计。 */
  totalCostYuan(): Promise<number>;
}

/** PgStore 只依赖这个最小接口:线上传 pg.Pool,测试传 PGlite。 */
export interface SqlClient {
  /** 单条语句,参数用 $1 $2 …… */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** 多条语句的脚本(迁移用,没有参数)。pg.Pool 可以不提供(它的 query 不带参数时就能跑多条)。 */
  exec?(sql: string): Promise<unknown>;
}
