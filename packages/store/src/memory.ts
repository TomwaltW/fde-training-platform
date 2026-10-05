// MemoryStore:本地开发和测试用。数据放在一个普通对象里;给了 file 就在启动时加载、
// 每次变更后整体落盘(先写临时文件再 rename,不会写出半截文件)。
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  VersionConflictError,
  normalizeRedeemCode,
  type EventQuery,
  type RedeemCode,
  type StoredEvent,
  type WaitlistEntry,
  type StoredFeedback,
  type StoredLlmCall,
  type StoredReport,
  type StoredSession,
  type Store,
  type User,
} from "@fde/contracts";
import type { SessionReport, SessionState } from "@fde/engine";
import { withProcessLock } from "./lock.ts";
import { jsonClone, ms, normalizeEmail, randomInviteCode, randomRedeemCode } from "./util.ts";

export interface MemoryStoreOptions {
  /** 给出时把全部数据落盘成这个 JSON 文件(本地开发重启不丢);不给就纯内存。 */
  file?: string;
}

interface InviteRow {
  maxUses: number;
  used: number;
  note: string | null;
  createdAt: string;
}

interface LoginCodeRow {
  codeHash: string;
  expiresAt: string;
  attempts: number;
}

interface AuthTokenRow {
  userId: string;
  expiresAt: string;
}

/** 落盘文件的结构。字段只增不改,老文件缺的字段按空处理。 */
interface MemoryData {
  invites: Record<string, InviteRow>;
  users: Record<string, User>;
  loginCodes: Record<string, LoginCodeRow>;
  authTokens: Record<string, AuthTokenRow>;
  sessions: Record<string, StoredSession>;
  reports: Record<string, StoredReport>;
  feedback: StoredFeedback[];
  llmCalls: StoredLlmCall[];
  // 第三轮
  waitlist: Record<string, WaitlistEntry>;
  events: StoredEvent[];
  redeemCodes: Record<string, RedeemCode>;
  /** 开局记录(删除对局后保留,每日限额用)。 */
  sessionStarts: { sessionId: string; userId: string; startedAt: string }[];
}

function emptyData(): MemoryData {
  return {
    invites: {},
    users: {},
    loginCodes: {},
    authTokens: {},
    sessions: {},
    reports: {},
    feedback: [],
    llmCalls: [],
    waitlist: {},
    events: [],
    redeemCodes: {},
    sessionStarts: [],
  };
}

/** 老文件(第三轮之前)里的记录缺新字段,按 null 补上。 */
function upgrade(d: MemoryData): MemoryData {
  for (const u of Object.values(d.users)) u.phone ??= null;
  for (const f of d.feedback) f.wantNext ??= null;
  if (!d.sessionStarts.length) d.sessionStarts = Object.values(d.sessions).map((s) => ({ sessionId: s.id, userId: s.userId, startedAt: s.startedAt }));
  return d;
}

function loadFile(file: string): MemoryData {
  if (!existsSync(file)) return emptyData();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    // 宁可启动失败也不要悄悄丢数据
    throw new Error(`内存库文件 ${file} 无法解析:${(e as Error).message}`);
  }
  return upgrade({ ...emptyData(), ...(raw as Partial<MemoryData>) });
}

const MAX_LOGIN_ATTEMPTS = 5;
let tmpSeq = 0;

class MemoryStore implements Store {
  private data: MemoryData;

  constructor(private file?: string) {
    this.data = file ? loadFile(file) : emptyData();
  }

  /** 每次变更后调用。同步写,保证 rename 之前文件内容完整。 */
  private persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${++tmpSeq}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  async migrate(): Promise<void> {}

  async close(): Promise<void> {}

  // ---------------------------------------------------------------- 邀请码

  async createInvites(count: number, maxUses: number, note?: string): Promise<string[]> {
    const codes: string[] = [];
    const now = new Date().toISOString();
    while (codes.length < count) {
      const code = randomInviteCode();
      if (this.data.invites[code]) continue;
      this.data.invites[code] = { maxUses, used: 0, note: note ?? null, createdAt: now };
      codes.push(code);
    }
    this.persist();
    return codes;
  }

  async redeemInvite(code: string): Promise<boolean> {
    // 检查和加一之间没有 await,单线程下天然不会超用
    const row = this.data.invites[code];
    if (!row || row.used >= row.maxUses) return false;
    row.used += 1;
    this.persist();
    return true;
  }

  // ---------------------------------------------------------------- 用户

  async createUser(email: string): Promise<User> {
    const e = normalizeEmail(email);
    if (this.findUserByEmail(e)) throw new Error(`用户 ${e} 已存在`);
    const user: User = { id: randomUUID(), email: e, phone: null, createdAt: new Date().toISOString(), consentAt: null };
    this.data.users[user.id] = user;
    this.persist();
    return jsonClone(user);
  }

  async createUserByPhone(phone: string): Promise<User> {
    if (Object.values(this.data.users).some((u) => u.phone === phone)) throw new Error(`用户 ${phone} 已存在`);
    const user: User = { id: randomUUID(), email: null, phone, createdAt: new Date().toISOString(), consentAt: null };
    this.data.users[user.id] = user;
    this.persist();
    return jsonClone(user);
  }

  private findUserByEmail(email: string): User | undefined {
    const e = normalizeEmail(email);
    return Object.values(this.data.users).find((u) => u.email === e);
  }

  async getUserByPhone(phone: string): Promise<User | null> {
    const u = Object.values(this.data.users).find((x) => x.phone === phone);
    return u ? jsonClone(u) : null;
  }

  async getUser(id: string): Promise<User | null> {
    const u = this.data.users[id];
    return u ? jsonClone(u) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const u = this.findUserByEmail(email);
    return u ? jsonClone(u) : null;
  }

  async setConsent(userId: string, at: string): Promise<void> {
    const u = this.data.users[userId];
    if (!u) return;
    u.consentAt = new Date(at).toISOString();
    this.persist();
  }

  async countUsers(): Promise<number> {
    return Object.keys(this.data.users).length;
  }

  // ---------------------------------------------------------------- 登录验证码

  async saveLoginCode(address: string, codeHash: string, expiresAt: string): Promise<void> {
    this.data.loginCodes[normalizeEmail(address)] = { codeHash, expiresAt, attempts: 0 };
    this.persist();
  }

  async verifyLoginCode(address: string, codeHash: string, now: string): Promise<boolean> {
    const e = normalizeEmail(address);
    const row = this.data.loginCodes[e];
    if (!row) return false;
    if (row.codeHash === codeHash && ms(row.expiresAt) > ms(now) && row.attempts < MAX_LOGIN_ATTEMPTS) {
      delete this.data.loginCodes[e];
      this.persist();
      return true;
    }
    row.attempts += 1;
    this.persist();
    return false;
  }

  // ---------------------------------------------------------------- 登录态

  async createAuthToken(userId: string, tokenHash: string, expiresAt: string): Promise<void> {
    this.data.authTokens[tokenHash] = { userId, expiresAt };
    this.persist();
  }

  async getUserByAuthToken(tokenHash: string, now: string): Promise<User | null> {
    const row = this.data.authTokens[tokenHash];
    if (!row || ms(row.expiresAt) <= ms(now)) return null;
    return this.getUser(row.userId);
  }

  async deleteAuthToken(tokenHash: string): Promise<void> {
    if (!(tokenHash in this.data.authTokens)) return;
    delete this.data.authTokens[tokenHash];
    this.persist();
  }

  // ---------------------------------------------------------------- 对局

  async createSession(s: Omit<StoredSession, "version" | "endedAt" | "status">): Promise<StoredSession> {
    if (this.data.sessions[s.id]) throw new Error(`对局 ${s.id} 已存在`);
    const row: StoredSession = { ...jsonClone(s), status: "active", endedAt: null, version: 1 };
    this.data.sessions[s.id] = row;
    this.data.sessionStarts.push({ sessionId: s.id, userId: s.userId, startedAt: s.startedAt });
    this.persist();
    return jsonClone(row);
  }

  async getSession(id: string): Promise<StoredSession | null> {
    const s = this.data.sessions[id];
    return s ? jsonClone(s) : null;
  }

  private sortedSessions(filter: (s: StoredSession) => boolean): StoredSession[] {
    return Object.values(this.data.sessions)
      .filter(filter)
      .sort((a, b) => ms(b.startedAt) - ms(a.startedAt));
  }

  async listSessions(userId: string): Promise<StoredSession[]> {
    return jsonClone(this.sortedSessions((s) => s.userId === userId));
  }

  async listAllSessions(limit: number, before?: string): Promise<StoredSession[]> {
    const cut = before === undefined ? undefined : ms(before);
    return jsonClone(this.sortedSessions((s) => cut === undefined || ms(s.startedAt) < cut).slice(0, Math.max(0, limit)));
  }

  async countSessionsSince(userId: string, since: string): Promise<number> {
    const t = ms(since);
    return this.data.sessionStarts.filter((s) => s.userId === userId && ms(s.startedAt) >= t).length;
  }

  async saveSession(id: string, state: SessionState, expectedVersion: number, end?: { endedAt: string }): Promise<number> {
    const s = this.data.sessions[id];
    if (!s || s.version !== expectedVersion) throw new VersionConflictError(id);
    s.state = jsonClone(state);
    s.version += 1;
    if (end) {
      s.status = "ended";
      s.endedAt = new Date(end.endedAt).toISOString();
    }
    this.persist();
    return s.version;
  }

  withSessionLock<T>(id: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    return withProcessLock(id, fn, timeoutMs);
  }

  async deleteUserSessions(userId: string): Promise<number> {
    const ids = new Set(Object.values(this.data.sessions).filter((s) => s.userId === userId).map((s) => s.id));
    if (!ids.size) return 0;
    for (const id of ids) {
      delete this.data.sessions[id];
      delete this.data.reports[id];
    }
    this.data.feedback = this.data.feedback.filter((f) => !ids.has(f.sessionId));
    // 模型调用记录只解除关联,花费保留
    for (const c of this.data.llmCalls) if (c.sessionId !== null && ids.has(c.sessionId)) c.sessionId = null;
    this.data.events = this.data.events.filter((ev) => ev.sessionId === null || !ids.has(ev.sessionId));
    this.persist();
    return ids.size;
  }

  // ---------------------------------------------------------------- 复盘

  async saveReport(sessionId: string, report: SessionReport, createdAt: string): Promise<void> {
    this.data.reports[sessionId] = { sessionId, report: jsonClone(report), createdAt: new Date(createdAt).toISOString() };
    this.persist();
  }

  async getReport(sessionId: string): Promise<StoredReport | null> {
    const r = this.data.reports[sessionId];
    return r ? jsonClone(r) : null;
  }

  // ---------------------------------------------------------------- 反馈与申诉

  async addFeedback(f: StoredFeedback): Promise<void> {
    this.data.feedback.push(jsonClone(f));
    this.persist();
  }

  async listFeedback(opts: { sessionId?: string; limit?: number } = {}): Promise<StoredFeedback[]> {
    // 新的在前;同一时间的按写入顺序倒排
    const rows = this.data.feedback
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => opts.sessionId === undefined || f.sessionId === opts.sessionId)
      .sort((a, b) => ms(b.f.createdAt) - ms(a.f.createdAt) || b.i - a.i)
      .map(({ f }) => f);
    return jsonClone(opts.limit === undefined ? rows : rows.slice(0, Math.max(0, opts.limit)));
  }

  // ---------------------------------------------------------------- 模型调用日志

  async logLlmCall(c: StoredLlmCall): Promise<void> {
    this.data.llmCalls.push(jsonClone(c));
    this.persist();
  }

  async listLlmCalls(sessionId: string): Promise<StoredLlmCall[]> {
    return jsonClone(this.data.llmCalls.filter((c) => c.sessionId === sessionId).sort((a, b) => ms(a.at) - ms(b.at)));
  }

  async totalCostYuan(): Promise<number> {
    return this.data.llmCalls.reduce((sum, c) => sum + (c.costYuan ?? 0), 0);
  }

  // ================================================================ 第三轮

  // ---------------------------------------------------------------- 候补名单

  async addToWaitlist(e: { email: string; role: string | null; note: string | null; source: string | null; createdAt: string }): Promise<{ created: boolean }> {
    const email = normalizeEmail(e.email);
    if (this.data.waitlist[email]) return { created: false };
    this.data.waitlist[email] = {
      email,
      role: e.role,
      note: e.note,
      source: e.source,
      createdAt: new Date(e.createdAt).toISOString(),
      invitedAt: null,
      inviteCode: null,
    };
    this.persist();
    return { created: true };
  }

  async listWaitlist(opts: { invited?: boolean; limit?: number } = {}): Promise<WaitlistEntry[]> {
    const rows = Object.values(this.data.waitlist)
      .filter((w) => opts.invited === undefined || (w.invitedAt !== null) === opts.invited)
      .sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    return jsonClone(opts.limit === undefined ? rows : rows.slice(0, Math.max(0, opts.limit)));
  }

  async markWaitlistInvited(email: string, inviteCode: string, at: string): Promise<void> {
    const w = this.data.waitlist[normalizeEmail(email)];
    if (!w) return;
    w.inviteCode = inviteCode;
    w.invitedAt = new Date(at).toISOString();
    this.persist();
  }

  // ---------------------------------------------------------------- 事件

  async logEvent(e: StoredEvent): Promise<void> {
    this.data.events.push({ ...jsonClone(e), at: new Date(e.at).toISOString() });
    this.persist();
  }

  async listEvents(q: EventQuery = {}): Promise<StoredEvent[]> {
    const since = q.since === undefined ? undefined : ms(q.since);
    const until = q.until === undefined ? undefined : ms(q.until);
    const types = q.types === undefined ? undefined : new Set(q.types);
    const rows = this.data.events
      .map((e, i) => ({ e, i, t: ms(e.at) }))
      .filter(
        ({ e, t }) =>
          (since === undefined || t >= since) &&
          (until === undefined || t < until) &&
          (types === undefined || types.has(e.type)) &&
          (q.sessionId === undefined || e.sessionId === q.sessionId) &&
          (q.userId === undefined || e.userId === q.userId) &&
          (q.visitorId === undefined || e.visitorId === q.visitorId),
      )
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map(({ e }) => e);
    return jsonClone(q.limit === undefined ? rows : rows.slice(0, Math.max(0, q.limit)));
  }

  // ---------------------------------------------------------------- 兑换码

  async createRedeemCodes(productId: string, count: number, note?: string): Promise<string[]> {
    const codes: string[] = [];
    const now = new Date().toISOString();
    while (codes.length < count) {
      const code = randomRedeemCode();
      if (this.data.redeemCodes[code]) continue;
      this.data.redeemCodes[code] = { code, productId, note: note ?? null, createdAt: now, redeemedBy: null, redeemedAt: null };
      codes.push(code);
    }
    this.persist();
    return codes;
  }

  async getRedeemCode(code: string): Promise<RedeemCode | null> {
    const r = this.data.redeemCodes[normalizeRedeemCode(code)];
    return r ? jsonClone(r) : null;
  }

  async redeemCode(code: string, userId: string, at: string): Promise<RedeemCode | null> {
    // 检查和写入之间没有 await,单线程下同一个码只会兑换一次
    const r = this.data.redeemCodes[normalizeRedeemCode(code)];
    if (!r || r.redeemedAt !== null) return null;
    r.redeemedBy = userId;
    r.redeemedAt = new Date(at).toISOString();
    this.persist();
    return jsonClone(r);
  }

  async listRedeemCodes(opts: { productId?: string; redeemedBy?: string; limit?: number } = {}): Promise<RedeemCode[]> {
    const rows = Object.values(this.data.redeemCodes)
      .filter((r) => (opts.productId === undefined || r.productId === opts.productId) && (opts.redeemedBy === undefined || r.redeemedBy === opts.redeemedBy))
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return jsonClone(opts.limit === undefined ? rows : rows.slice(0, Math.max(0, opts.limit)));
  }
}

export function createMemoryStore(opts: MemoryStoreOptions = {}): Store {
  return new MemoryStore(opts.file);
}
