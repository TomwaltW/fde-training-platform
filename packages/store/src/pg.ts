// PgStore:线上 PostgreSQL 16。只依赖 SqlClient(线上传 pg.Pool,测试传 PGlite)。
// 表结构见 infra/db/001_init.sql 与 002_round3.sql。时间一律以 ISO 字符串传入、用 ::timestamptz 转换,读回来再转成 ISO。
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VersionConflictError,
  normalizeRedeemCode,
  type EventQuery,
  type RedeemCode,
  type StoredEvent,
  type WaitlistEntry,
  type SqlClient,
  type StoredFeedback,
  type StoredLlmCall,
  type StoredReport,
  type StoredSession,
  type Store,
  type User,
} from "@fde/contracts";
import type { SessionReport, SessionState } from "@fde/engine";
import { withProcessLock } from "./lock.ts";
import { normalizeEmail, randomInviteCode, randomRedeemCode, toIso, toIsoOrNull } from "./util.ts";

export interface PgStoreOptions {
  /** 迁移脚本目录(infra/db),按文件名排序执行 *.sql,已执行的记在 schema_migrations。 */
  migrationsDir: string;
}

type Row = Record<string, unknown>;

/** jsonb 列:驱动一般已经解析成对象;万一是字符串再解析一次。 */
function json<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

/** numeric / bigint 列在 pg 驱动里是字符串。 */
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function toUser(r: Row): User {
  return {
    id: String(r.id),
    email: strOrNull(r.email),
    phone: strOrNull(r.phone),
    createdAt: toIso(r.created_at),
    consentAt: toIsoOrNull(r.consent_at),
  };
}

const USER_COLS = "id, email, phone, created_at, consent_at";

function toSession(r: Row): StoredSession {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    scenarioId: String(r.scenario_id),
    state: json<SessionState>(r.state),
    status: r.status === "ended" ? "ended" : "active",
    startedAt: toIso(r.started_at),
    endedAt: toIsoOrNull(r.ended_at),
    version: num(r.version),
  };
}

function toFeedback(r: Row): StoredFeedback {
  return {
    sessionId: String(r.session_id),
    userId: String(r.user_id),
    rating: numOrNull(r.rating),
    text: r.text === null || r.text === undefined ? null : String(r.text),
    dispute: r.dispute === null || r.dispute === undefined ? null : json<{ dimension: string; reason: string }>(r.dispute),
    wantNext: r.want_next === null || r.want_next === undefined ? null : Boolean(r.want_next),
    createdAt: toIso(r.created_at),
  };
}

function toWaitlist(r: Row): WaitlistEntry {
  return {
    email: String(r.email),
    role: strOrNull(r.role),
    note: strOrNull(r.note),
    source: strOrNull(r.source),
    createdAt: toIso(r.created_at),
    invitedAt: toIsoOrNull(r.invited_at),
    inviteCode: strOrNull(r.invite_code),
  };
}

function toEvent(r: Row): StoredEvent {
  return {
    at: toIso(r.at),
    type: String(r.type),
    userId: strOrNull(r.user_id),
    sessionId: strOrNull(r.session_id),
    visitorId: strOrNull(r.visitor_id),
    props: json<Record<string, unknown>>(r.props ?? {}),
  };
}

function toRedeemCode(r: Row): RedeemCode {
  return {
    code: String(r.code),
    productId: String(r.product_id),
    note: strOrNull(r.note),
    createdAt: toIso(r.created_at),
    redeemedBy: strOrNull(r.redeemed_by),
    redeemedAt: toIsoOrNull(r.redeemed_at),
  };
}

const REDEEM_COLS = "code, product_id, note, created_at, redeemed_by, redeemed_at";

function toLlmCall(r: Row): StoredLlmCall {
  return {
    sessionId: r.session_id === null || r.session_id === undefined ? null : String(r.session_id),
    at: toIso(r.at),
    stage: String(r.stage),
    provider: String(r.provider),
    model: String(r.model),
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    cachedTokens: num(r.cached_tokens),
    costYuan: numOrNull(r.cost_yuan),
    latencyMs: num(r.latency_ms),
    ok: Boolean(r.ok),
    error: r.error === null || r.error === undefined ? null : String(r.error),
  };
}

const SESSION_COLS = "id, user_id, scenario_id, state, status, started_at, ended_at, version";
const MAX_LOGIN_ATTEMPTS = 5;

class PgStore implements Store {
  constructor(
    private db: SqlClient,
    private opts: PgStoreOptions,
  ) {}

  private async rows<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(sql, params)).rows;
  }

  /** 执行多条语句的脚本(无参数)。有 exec 用 exec;pg.Pool 的 query 不带参数时也能跑多条。 */
  private async script(sql: string): Promise<void> {
    if (this.db.exec) await this.db.exec(sql);
    else await this.db.query(sql);
  }

  async migrate(): Promise<void> {
    // 记录表本身也要先有(和 001_init.sql 里的定义一致),才能判断哪些已经执行过
    await this.script(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now());",
    );
    const applied = new Set((await this.rows<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
    const files = readdirSync(this.opts.migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(this.opts.migrationsDir, f), "utf8");
      // 脚本和登记放在同一次多语句执行里:PostgreSQL 把它当成一个隐式事务,失败整体回滚
      const name = f.replace(/'/g, "''");
      await this.script(`${sql}\n;\ninsert into schema_migrations (name) values ('${name}') on conflict (name) do nothing;`);
    }
  }

  async close(): Promise<void> {
    // 连接由调用方创建,也由调用方关闭(pg.Pool.end / PGlite.close)
  }

  // ---------------------------------------------------------------- 邀请码

  async createInvites(count: number, maxUses: number, note?: string): Promise<string[]> {
    const codes: string[] = [];
    while (codes.length < count) {
      const code = randomInviteCode();
      const r = await this.rows(
        "insert into invite_codes (code, max_uses, used, note) values ($1, $2, 0, $3) on conflict (code) do nothing returning code",
        [code, maxUses, note ?? null],
      );
      if (r.length) codes.push(code);
    }
    return codes;
  }

  async inviteAvailable(code: string): Promise<boolean> {
    const r = await this.rows("select 1 from invite_codes where code = $1 and used < max_uses", [code]);
    return r.length > 0;
  }

  async redeemInvite(code: string): Promise<boolean> {
    // 条件写在同一条 UPDATE 里:并发时行锁保证 used 不会超过 max_uses
    const r = await this.rows("update invite_codes set used = used + 1 where code = $1 and used < max_uses returning code", [code]);
    return r.length > 0;
  }

  // ---------------------------------------------------------------- 用户

  async createUser(email: string): Promise<User> {
    const r = await this.rows(
      `insert into users (id, email, phone, created_at, consent_at) values ($1, $2, null, $3::timestamptz, null) returning ${USER_COLS}`,
      [randomUUID(), normalizeEmail(email), new Date().toISOString()],
    );
    return toUser(r[0]!);
  }

  async createUserByPhone(phone: string): Promise<User> {
    const r = await this.rows(
      `insert into users (id, email, phone, created_at, consent_at) values ($1, null, $2, $3::timestamptz, null) returning ${USER_COLS}`,
      [randomUUID(), phone, new Date().toISOString()],
    );
    return toUser(r[0]!);
  }

  async getUser(id: string): Promise<User | null> {
    const r = await this.rows(`select ${USER_COLS} from users where id = $1`, [id]);
    return r[0] ? toUser(r[0]) : null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const r = await this.rows(`select ${USER_COLS} from users where email = $1`, [normalizeEmail(email)]);
    return r[0] ? toUser(r[0]) : null;
  }

  async getUserByPhone(phone: string): Promise<User | null> {
    const r = await this.rows(`select ${USER_COLS} from users where phone = $1`, [phone]);
    return r[0] ? toUser(r[0]) : null;
  }

  async setConsent(userId: string, at: string): Promise<void> {
    await this.rows("update users set consent_at = $2::timestamptz where id = $1", [userId, at]);
  }

  async countUsers(): Promise<number> {
    const r = await this.rows<{ n: unknown }>("select count(*)::int as n from users");
    return num(r[0]?.n ?? 0);
  }

  // ---------------------------------------------------------------- 登录验证码

  async saveLoginCode(address: string, codeHash: string, expiresAt: string): Promise<void> {
    await this.rows(
      `insert into login_codes (address, code_hash, expires_at, attempts) values ($1, $2, $3::timestamptz, 0)
       on conflict (address) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      [normalizeEmail(address), codeHash, expiresAt],
    );
  }

  async verifyLoginCode(address: string, codeHash: string, now: string): Promise<boolean> {
    const e = normalizeEmail(address);
    // 先原子地占用一次尝试机会:条件和加一在同一条 UPDATE 里,并发的猜测按行锁排队,
    // 无论同时来多少个请求,最多只有 5 个能走到比对哈希这一步
    const claimed = await this.rows(
      "update login_codes set attempts = attempts + 1 where address = $1 and attempts < $2 returning code_hash, expires_at",
      [e, MAX_LOGIN_ATTEMPTS],
    );
    const row = claimed[0];
    if (!row || String(row.code_hash) !== codeHash || Date.parse(toIso(row.expires_at)) <= Date.parse(now)) return false;
    // 对了就删:并发的两次正确提交只有一次删到(带上哈希,防止期间被新验证码覆盖)
    const del = await this.rows("delete from login_codes where address = $1 and code_hash = $2 returning address", [e, codeHash]);
    return del.length > 0;
  }

  // ---------------------------------------------------------------- 登录态

  async createAuthToken(userId: string, tokenHash: string, expiresAt: string): Promise<void> {
    await this.rows("insert into auth_tokens (token_hash, user_id, expires_at) values ($1, $2, $3::timestamptz)", [tokenHash, userId, expiresAt]);
  }

  async getUserByAuthToken(tokenHash: string, now: string): Promise<User | null> {
    const r = await this.rows(
      `select u.id, u.email, u.phone, u.created_at, u.consent_at from auth_tokens t join users u on u.id = t.user_id
       where t.token_hash = $1 and t.expires_at > $2::timestamptz`,
      [tokenHash, now],
    );
    return r[0] ? toUser(r[0]) : null;
  }

  async deleteAuthToken(tokenHash: string): Promise<void> {
    await this.rows("delete from auth_tokens where token_hash = $1", [tokenHash]);
  }

  // ---------------------------------------------------------------- 对局

  async createSession(s: Omit<StoredSession, "version" | "endedAt" | "status">): Promise<StoredSession> {
    // 同一条语句里顺带记开局记录(每日限额用,删除对局后保留)
    const r = await this.rows(
      `with s as (
         insert into sessions (id, user_id, scenario_id, state, status, started_at, ended_at, version)
         values ($1, $2, $3, $4::jsonb, 'active', $5::timestamptz, null, 1) returning ${SESSION_COLS}
       ), st as (
         insert into session_starts (session_id, user_id, started_at) select id, user_id, started_at from s
       )
       select ${SESSION_COLS} from s`,
      [s.id, s.userId, s.scenarioId, JSON.stringify(s.state), s.startedAt],
    );
    return toSession(r[0]!);
  }

  async getSession(id: string): Promise<StoredSession | null> {
    const r = await this.rows(`select ${SESSION_COLS} from sessions where id = $1`, [id]);
    return r[0] ? toSession(r[0]) : null;
  }

  async listSessions(userId: string): Promise<StoredSession[]> {
    const r = await this.rows(`select ${SESSION_COLS} from sessions where user_id = $1 order by started_at desc, id`, [userId]);
    return r.map(toSession);
  }

  async listAllSessions(limit: number, before?: string): Promise<StoredSession[]> {
    const r = await this.rows(
      `select ${SESSION_COLS} from sessions where ($2::timestamptz is null or started_at < $2::timestamptz)
       order by started_at desc, id limit $1`,
      [Math.max(0, limit), before ?? null],
    );
    return r.map(toSession);
  }

  async countSessionsSince(userId: string, since: string): Promise<number> {
    const r = await this.rows<{ n: unknown }>("select count(*)::int as n from session_starts where user_id = $1 and started_at >= $2::timestamptz", [
      userId,
      since,
    ]);
    return num(r[0]?.n ?? 0);
  }

  async saveSession(id: string, state: SessionState, expectedVersion: number, end?: { endedAt: string }): Promise<number> {
    // 乐观锁:版本号对得上才写,一条语句完成比较和加一
    const r = await this.rows<{ version: unknown }>(
      `update sessions set state = $3::jsonb, version = version + 1,
         status = case when $4::timestamptz is null then status else 'ended' end,
         ended_at = coalesce($4::timestamptz, ended_at)
       where id = $1 and version = $2 returning version`,
      [id, expectedVersion, JSON.stringify(state), end?.endedAt ?? null],
    );
    if (!r[0]) throw new VersionConflictError(id);
    return num(r[0].version);
  }

  withSessionLock<T>(id: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    return withProcessLock(id, fn, timeoutMs);
  }

  async deleteUserSessions(userId: string): Promise<number> {
    // reports、feedback、events(带 session_id 的)是 on delete cascade;llm_calls 是 set null(保留花费);session_starts 不动
    const r = await this.rows("delete from sessions where user_id = $1 returning id", [userId]);
    return r.length;
  }

  // ---------------------------------------------------------------- 复盘

  async saveReport(sessionId: string, report: SessionReport, createdAt: string): Promise<void> {
    await this.rows(
      `insert into reports (session_id, report, created_at) values ($1, $2::jsonb, $3::timestamptz)
       on conflict (session_id) do update set report = excluded.report, created_at = excluded.created_at`,
      [sessionId, JSON.stringify(report), createdAt],
    );
  }

  async getReport(sessionId: string): Promise<StoredReport | null> {
    const r = await this.rows("select session_id, report, created_at from reports where session_id = $1", [sessionId]);
    const row = r[0];
    return row ? { sessionId: String(row.session_id), report: json<SessionReport>(row.report), createdAt: toIso(row.created_at) } : null;
  }

  // ---------------------------------------------------------------- 反馈与申诉

  async addFeedback(f: StoredFeedback): Promise<void> {
    await this.rows(
      "insert into feedback (session_id, user_id, rating, text, dispute, want_next, created_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)",
      [f.sessionId, f.userId, f.rating, f.text, f.dispute === null ? null : JSON.stringify(f.dispute), f.wantNext ?? null, f.createdAt],
    );
  }

  async listFeedback(opts: { sessionId?: string; limit?: number } = {}): Promise<StoredFeedback[]> {
    const r = await this.rows(
      `select session_id, user_id, rating, text, dispute, want_next, created_at from feedback
       where ($1::text is null or session_id = $1) order by created_at desc, id desc limit $2`,
      [opts.sessionId ?? null, opts.limit === undefined ? null : Math.max(0, opts.limit)],
    );
    return r.map(toFeedback);
  }

  // ---------------------------------------------------------------- 模型调用日志

  async logLlmCall(c: StoredLlmCall): Promise<void> {
    await this.rows(
      `insert into llm_calls (session_id, at, stage, provider, model, tokens_in, tokens_out, cached_tokens, cost_yuan, latency_ms, ok, error)
       values ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [c.sessionId, c.at, c.stage, c.provider, c.model, c.tokensIn, c.tokensOut, c.cachedTokens, c.costYuan, c.latencyMs, c.ok, c.error],
    );
  }

  async listLlmCalls(sessionId: string): Promise<StoredLlmCall[]> {
    const r = await this.rows(
      `select session_id, at, stage, provider, model, tokens_in, tokens_out, cached_tokens, cost_yuan, latency_ms, ok, error
       from llm_calls where session_id = $1 order by at, id`,
      [sessionId],
    );
    return r.map(toLlmCall);
  }

  async totalCostYuan(): Promise<number> {
    const r = await this.rows<{ total: unknown }>("select coalesce(sum(cost_yuan), 0) as total from llm_calls");
    return num(r[0]?.total ?? 0);
  }

  // ================================================================ 第三轮

  // ---------------------------------------------------------------- 候补名单

  async addToWaitlist(e: { email: string; role: string | null; note: string | null; source: string | null; createdAt: string }): Promise<{ created: boolean }> {
    const r = await this.rows(
      `insert into waitlist (email, role, note, source, created_at) values ($1, $2, $3, $4, $5::timestamptz)
       on conflict (email) do nothing returning email`,
      [normalizeEmail(e.email), e.role, e.note, e.source, e.createdAt],
    );
    return { created: r.length > 0 };
  }

  async listWaitlist(opts: { invited?: boolean; limit?: number } = {}): Promise<WaitlistEntry[]> {
    const r = await this.rows(
      `select email, role, note, source, created_at, invited_at, invite_code from waitlist
       where ($1::boolean is null or (invited_at is not null) = $1::boolean)
       order by created_at, email limit $2`,
      [opts.invited ?? null, opts.limit === undefined ? null : Math.max(0, opts.limit)],
    );
    return r.map(toWaitlist);
  }

  async markWaitlistInvited(email: string, inviteCode: string, at: string): Promise<void> {
    await this.rows("update waitlist set invite_code = $2, invited_at = $3::timestamptz where email = $1", [normalizeEmail(email), inviteCode, at]);
  }

  // ---------------------------------------------------------------- 事件

  async logEvent(e: StoredEvent): Promise<void> {
    await this.rows(
      "insert into events (at, type, user_id, session_id, visitor_id, props) values ($1::timestamptz, $2, $3, $4, $5, $6::jsonb)",
      [e.at, e.type, e.userId, e.sessionId, e.visitorId, JSON.stringify(e.props ?? {})],
    );
  }

  async listEvents(q: EventQuery = {}): Promise<StoredEvent[]> {
    const r = await this.rows(
      `select at, type, user_id, session_id, visitor_id, props from events
       where ($1::timestamptz is null or at >= $1::timestamptz)
         and ($2::timestamptz is null or at < $2::timestamptz)
         and ($3::text[] is null or type = any($3::text[]))
         and ($4::text is null or session_id = $4)
         and ($5::text is null or user_id = $5)
         and ($6::text is null or visitor_id = $6)
       order by at, id limit $7`,
      [q.since ?? null, q.until ?? null, q.types ?? null, q.sessionId ?? null, q.userId ?? null, q.visitorId ?? null, q.limit === undefined ? null : Math.max(0, q.limit)],
    );
    return r.map(toEvent);
  }

  // ---------------------------------------------------------------- 兑换码

  async createRedeemCodes(productId: string, count: number, note?: string): Promise<string[]> {
    const codes: string[] = [];
    const now = new Date().toISOString();
    while (codes.length < count) {
      const code = randomRedeemCode();
      const r = await this.rows(
        "insert into redeem_codes (code, product_id, note, created_at) values ($1, $2, $3, $4::timestamptz) on conflict (code) do nothing returning code",
        [code, productId, note ?? null, now],
      );
      if (r.length) codes.push(code);
    }
    return codes;
  }

  async getRedeemCode(code: string): Promise<RedeemCode | null> {
    const r = await this.rows(`select ${REDEEM_COLS} from redeem_codes where code = $1`, [normalizeRedeemCode(code)]);
    return r[0] ? toRedeemCode(r[0]) : null;
  }

  async redeemCode(code: string, userId: string, at: string): Promise<RedeemCode | null> {
    // 条件写在同一条 UPDATE 里:并发兑换同一个码只有一个成功
    const r = await this.rows(
      `update redeem_codes set redeemed_by = $2, redeemed_at = $3::timestamptz
       where code = $1 and redeemed_at is null returning ${REDEEM_COLS}`,
      [normalizeRedeemCode(code), userId, at],
    );
    return r[0] ? toRedeemCode(r[0]) : null;
  }

  async listRedeemCodes(opts: { productId?: string; redeemedBy?: string; limit?: number } = {}): Promise<RedeemCode[]> {
    const r = await this.rows(
      `select ${REDEEM_COLS} from redeem_codes
       where ($1::text is null or product_id = $1) and ($2::text is null or redeemed_by = $2)
       order by created_at desc, code limit $3`,
      [opts.productId ?? null, opts.redeemedBy ?? null, opts.limit === undefined ? null : Math.max(0, opts.limit)],
    );
    return r.map(toRedeemCode);
  }
}

export function createPgStore(client: SqlClient, opts: PgStoreOptions): Store {
  return new PgStore(client, opts);
}
