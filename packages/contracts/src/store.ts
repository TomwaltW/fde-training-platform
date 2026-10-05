// 持久化契约(本轮冻结)。两套实现:MemoryStore(本地开发、测试;可选落盘 JSON)和 PgStore(线上 PostgreSQL 16)。
// 两套实现必须通过同一套一致性测试(packages/store/test/conformance.ts)。
// 表结构见 infra/db/001_init.sql(同样冻结)与第三轮的 002_round3.sql(只增不改)。所有时间都是 ISO 8601 字符串(UTC)。
import type { SessionReport, SessionState } from "@fde/engine";

export interface User {
  id: string;
  /** 统一小写。第三轮起手机号注册的用户为 null(email 与 phone 至少有一个)。 */
  email: string | null;
  /** 第三轮:"+86" 开头的 E.164 手机号;邮箱注册的用户为 null。 */
  phone: string | null;
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
  /** 第三轮:想不想玩下一个场景;没回答为 null。 */
  wantNext: boolean | null;
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

// ---------------------------------------------------------------- 第三轮

export interface WaitlistEntry {
  /** 统一小写。 */
  email: string;
  role: string | null;
  note: string | null;
  source: string | null;
  createdAt: string;
  invitedAt: string | null;
  inviteCode: string | null;
}

export interface StoredEvent {
  at: string;
  type: string;
  userId: string | null;
  sessionId: string | null;
  /** 匿名访客 id(cookie fde_vid);服务端事件里可以为 null。 */
  visitorId: string | null;
  props: Record<string, unknown>;
}

export interface EventQuery {
  /** 含。 */
  since?: string;
  /** 不含。 */
  until?: string;
  types?: string[];
  sessionId?: string;
  userId?: string;
  visitorId?: string;
  /** 默认不限。 */
  limit?: number;
}

export interface RedeemCode {
  /** 规范格式 XXXX-XXXX-XXXX(字符集同邀请码)。 */
  code: string;
  productId: string;
  note: string | null;
  createdAt: string;
  redeemedBy: string | null;
  redeemedAt: string | null;
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
  /** 评审修复:只看不用——码存在且还有剩余次数返回 true(请求验证码时先核对,验证通过后才 redeemInvite)。 */
  inviteAvailable(code: string): Promise<boolean>;

  // ---------- 用户
  /** email 统一小写后存(phone 为 null)。已存在时抛错(调用方应先 getUserByEmail)。 */
  createUser(email: string): Promise<User>;
  /** 第三轮:手机号用户(email 为 null)。phone 由调用方规范成 "+86…" 后传入,原样存。已存在时抛错。 */
  createUserByPhone(phone: string): Promise<User>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  /** 第三轮。按原样比较(调用方先规范化)。 */
  getUserByPhone(phone: string): Promise<User | null>;
  setConsent(userId: string, at: string): Promise<void>;
  countUsers(): Promise<number>;

  // ---------- 登录验证码(只存哈希)
  // address 是统一小写的邮箱,或第三轮起的 "+86…" 手机号(两者不会重合:邮箱一定含 @)。
  /** 覆盖该地址之前的验证码,尝试次数清零。 */
  saveLoginCode(address: string, codeHash: string, expiresAt: string): Promise<void>;
  /**
   * 校验:哈希相同且未过期且尝试次数 < 5 → 删除这条验证码并返回 true;
   * 否则尝试次数 +1 并返回 false。没有验证码返回 false。
   */
  verifyLoginCode(address: string, codeHash: string, now: string): Promise<boolean>;

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
  /** 该用户在 since 之后开的局数,含已经被 deleteUserSessions 删掉的(每日限额用)。 */
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
  /**
   * 删除该用户的所有对局及其复盘、反馈、事件;返回删除的对局数。
   * 模型调用记录不含对局内容,只解除关联(sessionId 变为 null),总花费不变;开局记录保留(每日限额照算)。
   */
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

  // ================================================================ 第三轮

  // ---------- 候补名单
  /**
   * 登记。email 统一小写。已经在名单里时什么都不改,返回 created: false。
   * role / note / source 原样存(调用方负责校验和截断)。
   */
  addToWaitlist(e: { email: string; role: string | null; note: string | null; source: string | null; createdAt: string }): Promise<{ created: boolean }>;
  /** 按 createdAt 从早到晚(同一时间按 email)。invited:true 只要已邀请的,false 只要还没邀请的,省略为全部。 */
  listWaitlist(opts?: { invited?: boolean; limit?: number }): Promise<WaitlistEntry[]>;
  /** 记下发出的邀请码和时间;不在名单里的 email 什么都不做。 */
  markWaitlistInvited(email: string, inviteCode: string, at: string): Promise<void>;

  // ---------- 事件
  logEvent(e: StoredEvent): Promise<void>;
  /** 按 at 从早到晚(同一时间按写入顺序)。 */
  listEvents(q?: EventQuery): Promise<StoredEvent[]>;

  // ---------- 兑换码
  /** 生成 count 个兑换码(规范格式 XXXX-XXXX-XXXX,随机,不重复),返回规范格式。 */
  createRedeemCodes(productId: string, count: number, note?: string): Promise<string[]>;
  /** 按任意写法查(不区分大小写,忽略空格和短横线);不存在返回 null。 */
  getRedeemCode(code: string): Promise<RedeemCode | null>;
  /**
   * 兑换:码存在且还没被用过 → 记下 userId 和时间,返回兑换后的行;否则返回 null(含已被任何人用过)。
   * 并发调用同一个码只有一个成功。
   */
  redeemCode(code: string, userId: string, at: string): Promise<RedeemCode | null>;
  /** 新的在前(createdAt 倒序,同一时间按 code)。 */
  listRedeemCodes(opts?: { productId?: string; redeemedBy?: string; limit?: number }): Promise<RedeemCode[]>;
}

/** PgStore 只依赖这个最小接口:线上传 pg.Pool,测试传 PGlite。 */
export interface SqlClient {
  /** 单条语句,参数用 $1 $2 …… */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** 多条语句的脚本(迁移用,没有参数)。pg.Pool 可以不提供(它的 query 不带参数时就能跑多条)。 */
  exec?(sql: string): Promise<unknown>;
}

/**
 * 兑换码的规范格式:先做 NFKC(全角字母数字转半角),转大写,去掉字母数字以外的一切(空格、各种横线、
 * 零宽字符),再每 4 位一组用 "-" 连接。两套实现与接口层共用。
 */
export function normalizeRedeemCode(input: string): string {
  const raw = input.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.match(/.{1,4}/g)?.join("-") ?? "";
}
