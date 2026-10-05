// 候补名单接口测试(第三轮 F1,规格 2.1「候补名单」):登记 201/200、陷阱字段、限频、关闭登记、事件只在新登记时记、
// 管理接口的权限与名单、count 与 emails 两种邀请、已邀请的跳过、邀请邮件(失败只影响那一行)、CSV。
// 每个用例一个新的内存库文件;邮件用假的发信器(替换 runtime().mailer),不连外网。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminWaitlistResponse, InviteWaitlistResponse, RequestCodeResponse, Store, WaitlistResponse } from "@fde/contracts";
import type { Transporter } from "nodemailer";
import * as adminWaitlistCsv from "../app/api/admin/waitlist.csv/route.ts";
import * as adminWaitlistInvite from "../app/api/admin/waitlist/invite/route.ts";
import * as adminWaitlist from "../app/api/admin/waitlist/route.ts";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import * as waitlist from "../app/api/waitlist/route.ts";
import { resetForTests, runtime } from "../lib/server/runtime.ts";
import { getStore } from "../lib/server/store.ts";
import { csvCell, waitlistCsvFilename } from "../lib/server/waitlist.ts";
import { Client, errorCode } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const ADMIN = "admin@example.com";
const tmp = mkdtempSync(join(tmpdir(), "fde-waitlist-test-"));

const ENV_KEYS = [
  "FDE_ROOT",
  "FDE_ENGINE_MODE",
  "FDE_DEV_LOGIN_CODES",
  "FDE_MEMORY_STORE_FILE",
  "ADMIN_EMAILS",
  "FDE_AUTH_SECRET",
  "DATABASE_URL",
  "SMTP_URL",
  "MAIL_FROM",
  "SITE_URL",
  "DOMAIN",
  "WAITLIST_OPEN",
  "FDE_COOKIE_SECURE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let fileNo = 0;

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    FDE_ROOT: ROOT,
    FDE_ENGINE_MODE: "offline",
    FDE_DEV_LOGIN_CODES: "1",
    FDE_MEMORY_STORE_FILE: join(tmp, `store-${++fileNo}.json`),
    ADMIN_EMAILS: ADMIN,
    FDE_AUTH_SECRET: "test-secret",
  });
  await resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------- 小工具

let vidNo = 0;
/** 每个用例自己的访客 id(cookie fde_vid,16–64 位 base64url),限频互不影响。 */
function newVid(): string {
  return `testvisitor${String(++vidNo).padStart(8, "0")}`;
}

/** 直接调用 POST /api/waitlist,可以带任意请求头(cookie、x-forwarded-for)。 */
async function submit(body: unknown, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await waitlist.POST(req);
  const parsed = (await res.json()) as unknown;
  return { status: res.status, body: parsed, res };
}

function asVisitor(vid: string) {
  return { cookie: `fde_vid=${vid}` };
}

async function login(email: string, inviteCode?: string): Promise<Client> {
  const c = new Client();
  const r1 = await c.post<RequestCodeResponse>(requestCode.POST, { body: { email, ...(inviteCode && { inviteCode }) } });
  expect(r1.status, JSON.stringify(r1.body)).toBe(200);
  // 新用户的邀请码在验证通过时才消耗,校验时也要带上
  const r2 = await c.post(verify.POST, { body: { email, code: r1.body.devCode, ...(inviteCode && { inviteCode }) } });
  expect(r2.status).toBe(200);
  return c;
}

/** 直接往库里登记(可以指定登记时间)。 */
async function seed(store: Store, rows: { email: string; at: string; role?: string; note?: string; source?: string }[]) {
  for (const r of rows) {
    await store.addToWaitlist({ email: r.email, role: r.role ?? null, note: r.note ?? null, source: r.source ?? null, createdAt: r.at });
  }
}

async function joinedEvents() {
  return (await getStore()).listEvents({ types: ["waitlist_joined"] });
}

interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** 假的 SMTP:记下每封信;收件人在 failFor 里的抛错。 */
function fakeMailer(failFor: string[] = []): SentMail[] {
  const sent: SentMail[] = [];
  const url = "smtp://fake.test:2525";
  process.env.SMTP_URL = url;
  const transport = {
    sendMail: async (m: SentMail) => {
      if (failFor.includes(m.to)) throw new Error(`SMTP 550 拒收 ${m.to}`);
      sent.push(m);
      return { messageId: `<${sent.length}@fake.test>` };
    },
  };
  runtime().mailer = { url, transport: transport as unknown as Transporter };
  return sent;
}

// ---------------------------------------------------------------- 公开登记

describe("POST /api/waitlist", () => {
  it("新登记 201 并记 waitlist_joined;同一邮箱再提交 200 alreadyJoined,什么都不改、不再记事件", async () => {
    const vid = newVid();
    const r = await submit({ email: " Early@Example.com ", role: "career_switch", note: " 想转 FDE,练练访谈 ", source: "xhs" }, asVisitor(vid));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ok: true, alreadyJoined: false } satisfies WaitlistResponse);

    const store = await getStore();
    const [entry, ...rest] = await store.listWaitlist();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ email: "early@example.com", role: "career_switch", note: "想转 FDE,练练访谈", source: "xhs", invitedAt: null, inviteCode: null });
    expect(Date.now() - Date.parse(entry!.createdAt)).toBeLessThan(10_000);

    const events = await joinedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "waitlist_joined", visitorId: vid, userId: null, sessionId: null, props: { source: "xhs", role: "career_switch" } });

    // 同一邮箱(大小写不同)、换了身份和来源:200,原来的登记不变,不再记事件
    const again = await submit({ email: "EARLY@example.com", role: "student", note: "改一下", source: "jike" }, asVisitor(vid));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, alreadyJoined: true });
    expect(await store.listWaitlist()).toEqual([entry]);
    expect(await joinedEvents()).toHaveLength(1);
  });

  it("身份、备注、来源都可以不填;不合法的来源丢掉不报错,空备注存 null", async () => {
    const vid = newVid();
    expect((await submit({ email: "a@example.com" }, asVisitor(vid))).status).toBe(201);
    expect((await submit({ email: "b@example.com", note: "   ", source: "bad source!" }, asVisitor(vid))).status).toBe(201);
    expect((await submit({ email: "c@example.com", source: "x".repeat(33) }, asVisitor(vid))).status).toBe(201);
    const rows = await (await getStore()).listWaitlist();
    for (const r of rows) expect(r).toMatchObject({ role: null, note: null, source: null });
    const events = await joinedEvents();
    expect(events).toHaveLength(3);
    for (const e of events) expect(e.props).toEqual({ source: null, role: null });
  });

  it("请求体不合法 → 400 bad_request,不入库", async () => {
    const vid = newVid();
    for (const body of [{ email: "not-an-email" }, { email: "a@example.com", role: "ceo" }, { email: "a@example.com", note: "长".repeat(501) }, {}, "{oops"]) {
      const r = await submit(body, asVisitor(vid));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((r.body as { error: { code: string } }).error.code).toBe("bad_request");
    }
    expect(await (await getStore()).listWaitlist()).toEqual([]);
  });

  it("陷阱字段 website 非空:照样 201 alreadyJoined false,但不入库、不记事件、不占限频名额", async () => {
    const vid = newVid();
    for (let i = 0; i < 8; i++) {
      const r = await submit({ email: `bot${i}@spam.example`, website: "http://spam.example" }, asVisitor(vid));
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ ok: true, alreadyJoined: false });
    }
    expect(await (await getStore()).listWaitlist()).toEqual([]);
    expect(await joinedEvents()).toEqual([]);
    // 机器人的提交不算这个访客的次数
    expect((await submit({ email: "human@example.com", website: "" }, asVisitor(vid))).status).toBe(201);
    expect(await (await getStore()).listWaitlist()).toHaveLength(1);
  });

  it("限频:同一访客 10 分钟内第 6 次 429(重复提交也算);别的访客不受影响;10 分钟后恢复", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const vid = newVid();
    const statuses: number[] = [];
    // 08:00 起每分钟交一次
    for (const [i, email] of ["r1@example.com", "r2@example.com", "r1@example.com", "r3@example.com", "r4@example.com"].entries()) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, 8, i)));
      statuses.push((await submit({ email }, asVisitor(vid))).status);
    }
    expect(statuses).toEqual([201, 201, 200, 201, 201]);

    vi.setSystemTime(new Date("2026-10-05T08:09:00.000Z"));
    const sixth = await submit({ email: "r5@example.com" }, asVisitor(vid));
    expect(sixth.status).toBe(429);
    expect((sixth.body as { error: { code: string; message: string } }).error).toMatchObject({ code: "rate_limited" });
    expect((sixth.body as { error: { message: string } }).error.message).toMatch(/分钟后再试/);
    expect(await (await getStore()).listWaitlist()).toHaveLength(4);

    // 另一个访客不受影响
    expect((await submit({ email: "r5@example.com" }, asVisitor(newVid()))).status).toBe(201);

    // 最早那次提交过了 10 分钟,又能交一次
    vi.setSystemTime(new Date("2026-10-05T08:10:00.001Z"));
    expect((await submit({ email: "r6@example.com" }, asVisitor(vid))).status).toBe(201);
    expect((await submit({ email: "r7@example.com" }, asVisitor(vid))).status).toBe(429);
  });

  it("限频:没有 cookie 按 x-forwarded-for 第一段分桶;都没有的算同一个桶;不合法的 fde_vid 不算 cookie", async () => {
    for (let i = 0; i < 5; i++) expect((await submit({ email: `ip${i}@example.com` }, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).status).toBe(201);
    // 第一段相同就是同一个人(后面的代理地址不同也一样)
    expect((await submit({ email: "ip5@example.com" }, { "x-forwarded-for": " 203.0.113.7 " })).status).toBe(429);
    expect((await submit({ email: "ip5@example.com" }, { "x-forwarded-for": "203.0.113.7, 10.9.9.9", cookie: "fde_vid=bad" })).status).toBe(429);
    // 第一段不同就是另一个人
    expect((await submit({ email: "ip5@example.com" }, { "x-forwarded-for": "198.51.100.2, 203.0.113.7" })).status).toBe(201);

    for (let i = 0; i < 5; i++) expect((await submit({ email: `anon${i}@example.com` })).status).toBe(201);
    expect((await submit({ email: "anon5@example.com" })).status).toBe(429);
    // 有访客 cookie 的不和他们共用名额
    expect((await submit({ email: "anon5@example.com" }, asVisitor(newVid()))).status).toBe(201);
  });

  it("WAITLIST_OPEN=0 → 403 forbidden「候补名单暂停登记」,不入库、不记事件", async () => {
    process.env.WAITLIST_OPEN = "0";
    const r = await submit({ email: "late@example.com" }, asVisitor(newVid()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: { code: "forbidden", message: "候补名单暂停登记" } });
    expect(await (await getStore()).listWaitlist()).toEqual([]);
    expect(await joinedEvents()).toEqual([]);

    // 其他值都算开着
    process.env.WAITLIST_OPEN = "1";
    expect((await submit({ email: "late@example.com" }, asVisitor(newVid()))).status).toBe(201);
  });
});

// ---------------------------------------------------------------- 管理接口

describe("管理接口", () => {
  it("未登录 401;不是管理员 403", async () => {
    const store = await getStore();
    const [code] = await store.createInvites(1, 1);
    const player = await login("player@example.com", code);
    const anon = new Client();
    for (const [method, handler, opts] of [
      ["GET", adminWaitlist.GET, { path: "/api/admin/waitlist" }],
      ["POST", adminWaitlistInvite.POST, { path: "/api/admin/waitlist/invite", body: { count: 1 } }],
      ["GET", adminWaitlistCsv.GET, { path: "/api/admin/waitlist.csv" }],
    ] as const) {
      const a = await anon.call(method, handler, opts);
      expect(a.status).toBe(401);
      expect(errorCode(a)).toBe("unauthorized");
      const p = await player.call(method, handler, opts);
      expect(p.status).toBe(403);
      expect(errorCode(p)).toBe("forbidden");
    }
  });

  it("GET /api/admin/waitlist:从早到晚;registered;bySource(没有来源记为(直接访问),按人数从多到少);status 筛选", async () => {
    const admin = await login(ADMIN);
    const store = await getStore();
    // 故意乱序写入
    await seed(store, [
      { email: "c@example.com", at: "2026-10-05T07:20:00.000Z" },
      { email: "a@example.com", at: "2026-10-05T07:00:00.000Z", role: "career_switch", note: "想转 FDE", source: "xhs" },
      { email: "d@example.com", at: "2026-10-05T07:30:00.000Z", source: "jike" },
      { email: "b@example.com", at: "2026-10-05T07:10:00.000Z", role: "fde", source: "xhs" },
      { email: "e@example.com", at: "2026-10-05T07:40:00.000Z" },
      { email: "f@example.com", at: "2026-10-05T07:50:00.000Z" },
    ]);
    await store.markWaitlistInvited("a@example.com", "QWER2345", "2026-10-05T08:00:00.000Z");
    await store.createUser("a@example.com");

    const r = await admin.get<AdminWaitlistResponse>(adminWaitlist.GET, { path: "/api/admin/waitlist" });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
    expect(r.body.invited).toBe(1);
    expect(r.body.registered).toBe(1);
    expect(r.body.bySource).toEqual([
      { source: "(直接访问)", count: 3 },
      { source: "xhs", count: 2 },
      { source: "jike", count: 1 },
    ]);
    expect(r.body.rows.map((x) => x.email)).toEqual(["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com", "f@example.com"]);
    expect(r.body.rows[0]).toEqual({
      email: "a@example.com",
      role: "career_switch",
      note: "想转 FDE",
      source: "xhs",
      createdAt: "2026-10-05T07:00:00.000Z",
      invitedAt: "2026-10-05T08:00:00.000Z",
      inviteCode: "QWER2345",
      registered: true,
    });
    expect(r.body.rows[2]).toEqual({
      email: "c@example.com",
      role: null,
      note: null,
      source: null,
      createdAt: "2026-10-05T07:20:00.000Z",
      invitedAt: null,
      inviteCode: null,
      registered: false,
    });

    // status 只筛选 rows,合计照旧
    const pending = await admin.get<AdminWaitlistResponse>(adminWaitlist.GET, { path: "/api/admin/waitlist?status=pending" });
    expect(pending.body.rows.map((x) => x.email)).toEqual(["b@example.com", "c@example.com", "d@example.com", "e@example.com", "f@example.com"]);
    expect(pending.body.total).toBe(6);
    const invited = await admin.get<AdminWaitlistResponse>(adminWaitlist.GET, { path: "/api/admin/waitlist?status=invited" });
    expect(invited.body.rows.map((x) => x.email)).toEqual(["a@example.com"]);
    const all = await admin.get<AdminWaitlistResponse>(adminWaitlist.GET, { path: "/api/admin/waitlist?status=all" });
    expect(all.body.rows).toHaveLength(6);

    const bad = await admin.get(adminWaitlist.GET, { path: "/api/admin/waitlist?status=everyone" });
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe("bad_request");
  });

  it("名单是空的:合计都是 0", async () => {
    const admin = await login(ADMIN);
    const r = await admin.get<AdminWaitlistResponse>(adminWaitlist.GET, { path: "/api/admin/waitlist" });
    expect(r.body).toEqual({ total: 0, invited: 0, registered: 0, bySource: [], rows: [] });
  });
});

describe("POST /api/admin/waitlist/invite", () => {
  it("count:最早的 count 个还没邀请的;每人一个只能用一次的邀请码(备注「候补:<邮箱>」);没配 SMTP 时 mailed 为 false", async () => {
    const admin = await login(ADMIN);
    const store = await getStore();
    await seed(store, [
      { email: "first@example.com", at: "2026-10-05T07:00:00.000Z" },
      { email: "second@example.com", at: "2026-10-05T07:10:00.000Z" },
      { email: "third@example.com", at: "2026-10-05T07:20:00.000Z" },
      { email: "fourth@example.com", at: "2026-10-05T07:30:00.000Z" },
    ]);
    await store.markWaitlistInvited("first@example.com", "OLDC0DE2", "2026-10-05T07:05:00.000Z");
    const createInvites = vi.spyOn(store, "createInvites");

    const r = await admin.post<InviteWaitlistResponse>(adminWaitlistInvite.POST, { body: { count: 2 } });
    expect(r.status).toBe(200);
    expect(r.body.invited.map((x) => x.email)).toEqual(["second@example.com", "third@example.com"]);
    for (const x of r.body.invited) {
      expect(x.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect(x.mailed).toBe(false);
    }
    expect(createInvites.mock.calls).toEqual([
      [1, 1, "候补:second@example.com"],
      [1, 1, "候补:third@example.com"],
    ]);

    // 记到名单上;第一个人原来的邀请不变
    const rows = await store.listWaitlist();
    expect(rows.find((x) => x.email === "first@example.com")).toMatchObject({ inviteCode: "OLDC0DE2", invitedAt: "2026-10-05T07:05:00.000Z" });
    for (const x of r.body.invited) {
      const row = rows.find((w) => w.email === x.email)!;
      expect(row.inviteCode).toBe(x.inviteCode);
      expect(Date.now() - Date.parse(row.invitedAt!)).toBeLessThan(10_000);
    }
    expect(rows.find((x) => x.email === "fourth@example.com")).toMatchObject({ inviteCode: null, invitedAt: null });

    // 邀请码能登录(验证通过时消耗),但只能用一次
    const code = r.body.invited[0]!.inviteCode;
    await login("second@example.com", code);
    const reuse = await new Client().post(requestCode.POST, { body: { email: "stranger@example.com", inviteCode: code } });
    expect(reuse.status).toBe(400);
    expect(errorCode(reuse)).toBe("invite_invalid");

    // count 比剩下的多:只邀请剩下的;都邀请过了再来就是空的
    const rest = await admin.post<InviteWaitlistResponse>(adminWaitlistInvite.POST, { body: { count: 50 } });
    expect(rest.body.invited.map((x) => x.email)).toEqual(["fourth@example.com"]);
    const none = await admin.post<InviteWaitlistResponse>(adminWaitlistInvite.POST, { body: { count: 5 } });
    expect(none.status).toBe(200);
    expect(none.body.invited).toEqual([]);
  });

  it("emails:只处理在名单里且还没邀请的,其他的跳过不报错", async () => {
    const admin = await login(ADMIN);
    const store = await getStore();
    await seed(store, [
      { email: "old@example.com", at: "2026-10-05T07:00:00.000Z" },
      { email: "pick-b@example.com", at: "2026-10-05T07:10:00.000Z" },
      { email: "skip@example.com", at: "2026-10-05T07:20:00.000Z" },
      { email: "pick-a@example.com", at: "2026-10-05T07:30:00.000Z" },
    ]);
    await store.markWaitlistInvited("old@example.com", "OLDC0DE2", "2026-10-05T07:05:00.000Z");

    const r = await admin.post<InviteWaitlistResponse>(adminWaitlistInvite.POST, {
      body: { emails: ["Pick-A@Example.com", "old@example.com", "nobody@example.com", "pick-b@example.com", "pick-a@example.com"] },
    });
    expect(r.status).toBe(200);
    // 按登记时间处理,重复的只算一次
    expect(r.body.invited.map((x) => x.email)).toEqual(["pick-b@example.com", "pick-a@example.com"]);
    const rows = await store.listWaitlist();
    expect(rows.find((x) => x.email === "old@example.com")!.inviteCode).toBe("OLDC0DE2");
    expect(rows.find((x) => x.email === "skip@example.com")!.inviteCode).toBeNull();
    expect(rows.find((x) => x.email === "nobody@example.com")).toBeUndefined();

    // 全都不符合:空结果,不报错
    const none = await admin.post<InviteWaitlistResponse>(adminWaitlistInvite.POST, { body: { emails: ["old@example.com", "nobody@example.com"] } });
    expect(none.status).toBe(200);
    expect(none.body.invited).toEqual([]);
  });

  it("count 和 emails 必须给且只给一个;不合法的 400", async () => {
    const admin = await login(ADMIN);
    for (const body of [{}, { count: 1, emails: ["a@example.com"] }, { count: 0 }, { count: 201 }, { count: 1.5 }, { emails: [] }, { emails: ["not-an-email"] }]) {
      const r = await admin.post(adminWaitlistInvite.POST, { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(r)).toBe("bad_request");
    }
  });

  it("有 SMTP:发邀请邮件,链接是 <SITE_URL>/login?invite=..&email=..(URL 编码);某一封失败只把该行 mailed 记为 false 并打日志", async () => {
    process.env.SITE_URL = "https://fde.example.com/";
    process.env.MAIL_FROM = "FDE 训练场 <invite@fde.example.com>";
    const admin = await login(ADMIN);
    const store = await getStore();
    await seed(store, [
      { email: "a+tag@example.com", at: "2026-10-05T07:00:00.000Z" },
      { email: "bounce@example.com", at: "2026-10-05T07:10:00.000Z" },
      { email: "c@example.com", at: "2026-10-05T07:20:00.000Z" },
    ]);
    const sent = fakeMailer(["bounce@example.com"]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await admin.post<InviteWaitlistResponse>(adminWaitlistInvite.POST, { body: { count: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.invited.map((x) => [x.email, x.mailed])).toEqual([
      ["a+tag@example.com", true],
      ["bounce@example.com", false],
      ["c@example.com", true],
    ]);
    // 发信失败的人邀请码照样发了(管理员可以手动转给他)
    expect((await store.listWaitlist({ invited: true })).map((x) => x.email)).toEqual(["a+tag@example.com", "bounce@example.com", "c@example.com"]);

    expect(sent.map((m) => m.to).sort()).toEqual(["a+tag@example.com", "c@example.com"]);
    const first = sent.find((m) => m.to === "a+tag@example.com")!;
    const code = r.body.invited[0]!.inviteCode;
    expect(first.from).toBe("FDE 训练场 <invite@fde.example.com>");
    expect(first.subject).toContain(code);
    expect(first.text).toContain(`邀请码:${code}`);
    expect(first.text).toContain(`https://fde.example.com/login?invite=${code}&email=a%2Btag%40example.com`);

    expect(logged).toHaveBeenCalled();
    expect(logged.mock.calls.some((args) => String(args[0]).includes("bounce@example.com"))).toBe(true);
  });

  it("没有 SITE_URL 时链接用 https://<DOMAIN>", async () => {
    process.env.DOMAIN = "fde.example.cn";
    const admin = await login(ADMIN);
    await seed(await getStore(), [{ email: "x@example.com", at: "2026-10-05T07:00:00.000Z" }]);
    const sent = fakeMailer();
    const r = await admin.post<InviteWaitlistResponse>(adminWaitlistInvite.POST, { body: { emails: ["x@example.com"] } });
    expect(r.body.invited[0]!.mailed).toBe(true);
    expect(sent[0]!.text).toContain(`https://fde.example.cn/login?invite=${r.body.invited[0]!.inviteCode}&email=x%40example.com`);
  });
});

// ---------------------------------------------------------------- CSV

describe("GET /api/admin/waitlist.csv", () => {
  it("UTF-8 带 BOM、列、RFC 4180 转义、防公式注入、文件名", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // UTC 10 月 5 日 17 点 = 北京时间 10 月 6 日
    vi.setSystemTime(new Date("2026-10-05T17:00:00.000Z"));
    const admin = await login(ADMIN);
    const store = await getStore();
    await seed(store, [
      { email: "plain@example.com", at: "2026-10-05T07:00:00.000Z", role: "fde", note: "想练访谈", source: "xhs" },
      { email: "quote@example.com", at: "2026-10-05T07:10:00.000Z", note: '他说"先上线",然后\n就没有然后了' },
      { email: "=cmd@example.com", at: "2026-10-05T07:20:00.000Z", note: "=HYPERLINK(\"http://evil\",\"点我\")" },
      { email: "plus@example.com", at: "2026-10-05T07:30:00.000Z", note: "+1 想试试" },
      { email: "minus@example.com", at: "2026-10-05T07:40:00.000Z", note: "-2+3" },
      { email: "at@example.com", at: "2026-10-05T07:50:00.000Z", note: "@SUM(A1)" },
    ]);
    await store.markWaitlistInvited("plain@example.com", "QWER2345", "2026-10-05T08:00:00.000Z");
    await store.createUser("plain@example.com");

    const r = await admin.get(adminWaitlistCsv.GET, { path: "/api/admin/waitlist.csv" });
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.res.headers.get("content-disposition")).toBe('attachment; filename="waitlist-20261006.csv"');

    const bytes = new Uint8Array(await r.res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith("﻿email,role,note,source,created_at,invited_at,invite_code,registered\r\n")).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
    const body = text.slice(1).split("\r\n").slice(1, -1);
    expect(body).toEqual([
      "plain@example.com,fde,想练访谈,xhs,2026-10-05T07:00:00.000Z,2026-10-05T08:00:00.000Z,QWER2345,true",
      'quote@example.com,,"他说""先上线"",然后\n就没有然后了",,2026-10-05T07:10:00.000Z,,,false',
      `'=cmd@example.com,,"'=HYPERLINK(""http://evil"",""点我"")",,2026-10-05T07:20:00.000Z,,,false`,
      "plus@example.com,,'+1 想试试,,2026-10-05T07:30:00.000Z,,,false",
      "minus@example.com,,'-2+3,,2026-10-05T07:40:00.000Z,,,false",
      "at@example.com,,'@SUM(A1),,2026-10-05T07:50:00.000Z,,,false",
    ]);
  });

  it("名单是空的:只有表头", async () => {
    const admin = await login(ADMIN);
    const r = await admin.get(adminWaitlistCsv.GET, { path: "/api/admin/waitlist.csv" });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await r.res.arrayBuffer());
    expect(text).toBe("﻿email,role,note,source,created_at,invited_at,invite_code,registered\r\n");
  });

  it("单元格与文件名的小工具", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+86 138")).toBe("'+86 138");
    expect(csvCell("-1,2")).toBe(`"'-1,2"`);
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("a=1")).toBe("a=1");
    expect(waitlistCsvFilename(new Date("2026-10-05T15:59:59.000Z"))).toBe("waitlist-20261005.csv");
    expect(waitlistCsvFilename(new Date("2026-10-05T16:00:00.000Z"))).toBe("waitlist-20261006.csv");
  });
});
