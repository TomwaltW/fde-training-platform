// 浏览器埋点接口 POST /api/events(第三轮,spec 2.1「埋点与指标」):访客 cookie、userId 与 sessionId 的归属、
// 请求体白名单、每个访客每分钟 60 条的限频(超了照样 204 但不入库)。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CreateSessionResponse, RequestCodeResponse } from "@fde/contracts";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import * as events from "../app/api/events/route.ts";
import { EVENTS_PER_MINUTE, resetEventQuotaForTests, takeEventQuota } from "../app/api/events/rate-limit.ts";
import * as consent from "../app/api/me/consent/route.ts";
import * as sessions from "../app/api/sessions/route.ts";
import { VISITOR_COOKIE } from "../lib/server/events.ts";
import { resetForTests } from "../lib/server/runtime.ts";
import { getStore } from "../lib/server/store.ts";
import { Client, errorCode } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const tmp = mkdtempSync(join(tmpdir(), "fde-events-test-"));

const ENV_KEYS = [
  "FDE_ROOT",
  "FDE_ENGINE_MODE",
  "FDE_DEV_LOGIN_CODES",
  "FDE_MEMORY_STORE_FILE",
  "ADMIN_EMAILS",
  "FDE_AUTH_SECRET",
  "DATABASE_URL",
  "FDE_COOKIE_SECURE",
  "FDE_DAILY_SESSION_LIMIT",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    FDE_ROOT: ROOT,
    FDE_ENGINE_MODE: "offline",
    FDE_DEV_LOGIN_CODES: "1",
    FDE_MEMORY_STORE_FILE: join(tmp, "store.json"),
    ADMIN_EMAILS: "admin@example.com",
    FDE_AUTH_SECRET: "test-secret",
  });
  await resetForTests();
});

afterAll(async () => {
  await resetForTests();
  resetEventQuotaForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => resetEventQuotaForTests());

/** 合法的访客 id(16–64 位 base64url 字符)。 */
const vid = (n: number) => `visitor${String(n).padStart(12, "0")}`;

/** 带访客 cookie 的客户端;session 是登录后的 fde_session=…。 */
function withVisitor(visitorId: string, session?: Client): Client {
  return new Client([session?.cookie, `${VISITOR_COOKIE}=${visitorId}`].filter(Boolean).join("; "));
}

async function eventsOf(visitorId: string) {
  return (await getStore()).listEvents({ visitorId });
}

async function login(email: string): Promise<Client> {
  const store = await getStore();
  const [invite] = await store.createInvites(1, 1, "events.test");
  const c = new Client();
  const r1 = await c.post<RequestCodeResponse>(requestCode.POST, { body: { email, inviteCode: invite } });
  expect(r1.status, JSON.stringify(r1.body)).toBe(200);
  const r2 = await c.post(verify.POST, { body: { email, code: r1.body.devCode } });
  expect(r2.status).toBe(200);
  return c;
}

async function startSession(c: Client): Promise<string> {
  expect((await c.post(consent.POST)).status).toBe(200);
  const r = await c.post<CreateSessionResponse>(sessions.POST, { body: { scenarioId: "freight-docs" } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.sessionId;
}

describe("访客 cookie", () => {
  it("没有 cookie:发一个新的(HttpOnly、一年),204 无响应体,事件记在这个访客名下", async () => {
    const r = await new Client().post(events.POST, { body: { type: "landing_viewed", props: { from: "xhs" } } });
    expect(r.status).toBe(204);
    expect(await r.res.text()).toBe("");
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    const setCookie = r.res.headers.get("set-cookie")!;
    const m = /^fde_vid=([A-Za-z0-9_-]{22});/.exec(setCookie);
    expect(m, setCookie).not.toBeNull();
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=31536000");
    expect(setCookie).not.toContain("Secure"); // 测试环境不是生产

    const stored = await eventsOf(m![1]!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ type: "landing_viewed", userId: null, sessionId: null, visitorId: m![1], props: { from: "xhs" } });
    expect(Date.now() - Date.parse(stored[0]!.at)).toBeLessThan(10_000);
  });

  it("带合法 cookie:沿用,不再 set-cookie", async () => {
    const r = await withVisitor(vid(1)).post(events.POST, { body: { type: "waitlist_viewed" } });
    expect(r.status).toBe(204);
    expect(r.res.headers.get("set-cookie")).toBeNull();
    expect(await eventsOf(vid(1))).toMatchObject([{ type: "waitlist_viewed", visitorId: vid(1), props: {} }]);
  });

  it("cookie 不合法(太短、有非法字符):换一个新的,不用原来的值", async () => {
    for (const bad of ["short", "has space in it 12345", "a".repeat(65)]) {
      const r = await new Client(`${VISITOR_COOKIE}=${encodeURIComponent(bad)}`).post(events.POST, { body: { type: "landing_viewed" } });
      expect(r.status).toBe(204);
      const fresh = /^fde_vid=([^;]+);/.exec(r.res.headers.get("set-cookie") ?? "")?.[1];
      expect(fresh).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(fresh).not.toBe(bad);
      expect(await eventsOf(bad)).toHaveLength(0);
      expect(await eventsOf(fresh!)).toHaveLength(1);
    }
  });
});

describe("用户与对局的归属", () => {
  let player: Client;
  let other: Client;
  let mine = "";
  let theirs = "";

  beforeAll(async () => {
    player = await login("player@example.com");
    other = await login("other@example.com");
    mine = await startSession(player);
    theirs = await startSession(other);
  });

  it("登录了记 userId;sessionId 是自己的对局才记", async () => {
    const store = await getStore();
    const me = (await store.getUserByEmail("player@example.com"))!;
    const r = await withVisitor(vid(10), player).post(events.POST, { body: { type: "report_viewed", sessionId: mine } });
    expect(r.status).toBe(204);
    expect(await eventsOf(vid(10))).toMatchObject([{ type: "report_viewed", userId: me.id, sessionId: mine, visitorId: vid(10) }]);
  });

  it("别人的对局、不存在的对局:丢掉 sessionId(不报错),事件照记", async () => {
    const store = await getStore();
    const me = (await store.getUserByEmail("player@example.com"))!;
    const c = withVisitor(vid(11), player);
    expect((await c.post(events.POST, { body: { type: "share_card_saved", sessionId: theirs } })).status).toBe(204);
    expect((await c.post(events.POST, { body: { type: "share_text_copied", sessionId: "no-such-session" } })).status).toBe(204);
    const stored = await eventsOf(vid(11));
    expect(stored).toHaveLength(2);
    for (const e of stored) expect(e).toMatchObject({ userId: me.id, sessionId: null });
    // 别人的对局里不会因此多出分享事件
    expect(await store.listEvents({ sessionId: theirs, types: ["share_card_saved"] })).toHaveLength(0);
  });

  it("没登录带 sessionId:丢掉;登录 cookie 失效也按没登录算", async () => {
    expect((await withVisitor(vid(12)).post(events.POST, { body: { type: "report_viewed", sessionId: mine } })).status).toBe(204);
    const stale = new Client(`fde_session=not-a-real-token; ${VISITOR_COOKIE}=${vid(12)}`);
    expect((await stale.post(events.POST, { body: { type: "report_viewed", sessionId: mine } })).status).toBe(204);
    const stored = await eventsOf(vid(12));
    expect(stored).toHaveLength(2);
    for (const e of stored) expect(e).toMatchObject({ userId: null, sessionId: null, visitorId: vid(12) });
  });
});

describe("请求体校验", () => {
  it("不在白名单的类型(含服务端事件)、props 超过 10 个键、值类型不对、非法 JSON → 400,什么都不记", async () => {
    const c = withVisitor(vid(20));
    const tooMany = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
    for (const body of [
      { type: "login" },
      { type: "session_finished" },
      { type: "clicked_something" },
      {},
      { type: "landing_viewed", props: tooMany },
      { type: "landing_viewed", props: { nested: { a: 1 } } },
      { type: "landing_viewed", sessionId: "" },
    ]) {
      const r = await c.post(events.POST, { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(r)).toBe("bad_request");
    }
    const raw = await c.post(events.POST, { rawBody: "{oops" });
    expect(raw.status).toBe(400);
    expect(await eventsOf(vid(20))).toHaveLength(0);
  });

  it("props 最多 10 个键,值可以是短字符串、数字、布尔", async () => {
    const props = { a: "x", b: 1, c: true, d: 2.5, e: "", f: false, g: "y", h: 0, i: -1, j: "z" };
    expect((await withVisitor(vid(21)).post(events.POST, { body: { type: "presale_viewed", props } })).status).toBe(204);
    expect(await eventsOf(vid(21))).toMatchObject([{ type: "presale_viewed", props }]);
  });
});

describe("限频", () => {
  it(`同一访客一分钟内最多 ${EVENTS_PER_MINUTE} 条:之后照样 204 但不入库;别的访客不受影响`, async () => {
    const c = withVisitor(vid(30));
    for (let i = 0; i < EVENTS_PER_MINUTE + 5; i++) {
      const r = await c.post(events.POST, { body: { type: "landing_viewed", props: { i } } });
      expect(r.status).toBe(204);
    }
    const stored = await eventsOf(vid(30));
    expect(stored).toHaveLength(EVENTS_PER_MINUTE);
    expect(stored.map((e) => e.props.i)).toEqual(Array.from({ length: EVENTS_PER_MINUTE }, (_, i) => i));

    expect((await withVisitor(vid(31)).post(events.POST, { body: { type: "landing_viewed" } })).status).toBe(204);
    expect(await eventsOf(vid(31))).toHaveLength(1);
  });

  it("没带访客 cookie 的请求按 IP 头第一段限频(每次发新 cookie 也绕不过去)", async () => {
    const send = (ip: string) =>
      events.POST(
        new Request("http://localhost/api/events", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ type: "landing_viewed", props: { probe: "ip-limit" } }),
        }),
      );
    const store = await getStore();
    const count = async () => (await store.listEvents({ types: ["landing_viewed"] })).filter((e) => e.props.probe === "ip-limit").length;
    for (let i = 0; i < EVENTS_PER_MINUTE + 3; i++) {
      const r = await send("203.0.113.7, 10.0.0.1");
      expect(r.status).toBe(204);
      expect(r.headers.get("set-cookie")).toMatch(/^fde_vid=/);
    }
    expect(await count()).toBe(EVENTS_PER_MINUTE);
    expect((await send("198.51.100.2")).status).toBe(204);
    expect(await count()).toBe(EVENTS_PER_MINUTE + 1);
  });

  it("窗口是滑动的一分钟:最早的一条满 60 秒后腾出一个名额", () => {
    const t0 = Date.parse("2026-10-05T08:00:00Z");
    for (let i = 0; i < EVENTS_PER_MINUTE; i++) expect(takeEventQuota("k", t0 + i * 100)).toBe(true);
    expect(takeEventQuota("k", t0 + 30_000)).toBe(false);
    expect(takeEventQuota("k", t0 + 59_999)).toBe(false);
    expect(takeEventQuota("k", t0 + 60_000)).toBe(true); // 第一条(t0)过期
    expect(takeEventQuota("k", t0 + 60_050)).toBe(false);
    expect(takeEventQuota("k", t0 + 60_100)).toBe(true); // 第二条(t0+100)过期
    expect(takeEventQuota("other", t0 + 60_100)).toBe(true);
    // 过了很久:全部腾出来
    for (let i = 0; i < EVENTS_PER_MINUTE; i++) expect(takeEventQuota("k", t0 + 10 * 60_000)).toBe(true);
  });
});
