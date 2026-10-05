// 评审修复的回归测试:回跳地址、请求体上限与怪字符、验证码接口限频、生产环境的开发模式开关。
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import * as events from "../app/api/events/route.ts";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as waitlist from "../app/api/waitlist/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import { HttpError, MAX_BODY_BYTES, cleanStrings, readJson } from "../lib/server/http.ts";
import { LIMITS, allow, clientIp } from "../lib/server/ratelimit.ts";
import { authSecret, devLoginCodes } from "../lib/server/env.ts";
import { resetForTests } from "../lib/server/runtime.ts";
import { getStore } from "../lib/server/store.ts";
import { safeNext } from "../lib/client/api.ts";

describe("safeNext:只放行站内路径", () => {
  it.each([
    ["/", "/"],
    ["/me", "/me"],
    ["/play/abc?x=1#t", "/play/abc?x=1#t"],
  ])("%s → %s", (input, out) => expect(safeNext(input)).toBe(out));

  it.each([null, undefined, "", "me", "https://evil.com", "//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "/\r//evil.com", "\\/evil.com", "/%0A/x\u0000"])(
    "拒绝 %j",
    (input) => expect(safeNext(input as string | null | undefined, "/fallback")).toBe("/fallback"),
  );
});

describe("readJson:请求体上限与清洗", () => {
  const schema = z.object({ text: z.string() });
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://x/api", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

  it("超过上限 → 400(按声明的长度,也按实际读到的长度)", async () => {
    const big = JSON.stringify({ text: "字".repeat(MAX_BODY_BYTES) });
    await expect(readJson(req(big), schema)).rejects.toMatchObject({ code: "bad_request", message: "请求体太大" });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = new Request("http://x/api", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readJson(chunked, schema)).rejects.toBeInstanceOf(HttpError);
  });

  it("NUL 去掉、落单的代理项换成 U+FFFD,正常的 emoji 不动", async () => {
    const body = JSON.stringify({ text: "a\u0000b\uD800c🚢" });
    expect(await readJson(req(body), schema)).toEqual({ text: "ab�c🚢" });
  });

  it("键名 __proto__ 只是普通的自有属性", () => {
    const out = cleanStrings(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual(["__proto__", "a"]);
  });

  it("不是 JSON → 400", async () => {
    await expect(readJson(req("{"), schema)).rejects.toMatchObject({ code: "bad_request" });
  });
});

// ---------------------------------------------------------------- 登录相关

const env = process.env as Record<string, string | undefined>;
const KEYS = ["NODE_ENV", "FDE_DEV_LOGIN_CODES", "FDE_DEV_LOGIN_CODES_IN_PRODUCTION", "FDE_AUTH_SECRET", "FDE_ROOT", "FDE_MEMORY_STORE_FILE", "ADMIN_EMAILS", "DATABASE_URL"];
let saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
  delete env.DATABASE_URL;
  Object.assign(env, {
    FDE_ROOT: resolve(import.meta.dirname, "../../.."),
    FDE_MEMORY_STORE_FILE: join(mkdtempSync(join(tmpdir(), "fde-hardening-")), "store.json"),
    ADMIN_EMAILS: "admin@example.com",
    FDE_DEV_LOGIN_CODES: "1",
  });
  await resetForTests();
});
afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  await resetForTests();
});

describe("开发模式验证码不能在生产环境误开", () => {
  it("生产环境只设 FDE_DEV_LOGIN_CODES=1 不生效,还要 FDE_DEV_LOGIN_CODES_IN_PRODUCTION=1", () => {
    env.NODE_ENV = "production";
    delete env.FDE_DEV_LOGIN_CODES_IN_PRODUCTION;
    expect(devLoginCodes()).toBe(false);
    env.FDE_DEV_LOGIN_CODES_IN_PRODUCTION = "1";
    expect(devLoginCodes()).toBe(true);
    env.NODE_ENV = "test";
    delete env.FDE_DEV_LOGIN_CODES_IN_PRODUCTION;
    expect(devLoginCodes()).toBe(true);
  });

  it("生产环境没有 FDE_AUTH_SECRET 一律报错(开发模式也不例外)", () => {
    env.NODE_ENV = "production";
    env.FDE_DEV_LOGIN_CODES_IN_PRODUCTION = "1";
    delete env.FDE_AUTH_SECRET;
    expect(() => authSecret()).toThrow(/FDE_AUTH_SECRET/);
  });
});

describe("验证码接口按 IP 限频", () => {
  const post = (handler: (req: Request) => Promise<Response>, body: unknown, ip: string) =>
    handler(new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` } }));

  it("同一 IP 第 21 次请求验证码 → 429;别的 IP 不受影响", async () => {
    for (let i = 0; i < LIMITS.requestCodePerIp.limit; i++) {
      const r = await post(requestCode.POST, { email: `u${i}@example.com`, inviteCode: "NOPE2345" }, "1.2.3.4");
      expect(r.status).toBe(400); // 邀请码无效,但计数
    }
    const blocked = await post(requestCode.POST, { email: "admin@example.com" }, "1.2.3.4");
    expect(blocked.status).toBe(429);
    const other = await post(requestCode.POST, { email: "admin@example.com" }, "5.6.7.8");
    expect(other.status).toBe(200);
  });

  it("同一 IP 第 31 次校验 → 429", async () => {
    for (let i = 0; i < LIMITS.verifyPerIp.limit; i++) {
      const r = await post(verify.POST, { email: `v${i}@example.com`, code: "000000" }, "9.9.9.9");
      expect(r.status).toBe(400);
    }
    expect((await post(verify.POST, { email: "v@example.com", code: "000000" }, "9.9.9.9")).status).toBe(429);
  });

  it("clientIp 取 X-Forwarded-For 第一段;allow 按窗口计数", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" } }))).toBe("203.0.113.7");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
    expect(allow("t", "k", 2, 1000, 0)).toBe(true);
    expect(allow("t", "k", 2, 1000, 10)).toBe(true);
    expect(allow("t", "k", 2, 1000, 20)).toBe(false);
    expect(allow("t", "k", 2, 1000, 1001)).toBe(true);
  });
});

describe("换着访客 cookie 也绕不过限频(同一 IP 有总额度)", () => {
  const send = (handler: (req: Request) => Promise<Response>, body: unknown, i: number) =>
    handler(
      new Request("http://x/api", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9", cookie: `fde_vid=rotating-visitor-${String(i).padStart(6, "0")}` },
      }),
    );

  it("埋点:每次换一个 cookie,同一 IP 每分钟最多入库 600 条", async () => {
    for (let i = 0; i < LIMITS.eventsPerIp.limit + 50; i++) expect((await send(events.POST, { type: "landing_viewed" }, i)).status).toBe(204);
    expect(await (await getStore()).listEvents({ types: ["landing_viewed"] })).toHaveLength(LIMITS.eventsPerIp.limit);
  });

  it("候补名单:每次换一个 cookie,同一 IP 10 分钟最多 30 次", async () => {
    for (let i = 0; i < LIMITS.waitlistPerIp.limit; i++) expect((await send(waitlist.POST, { email: `w${i}@example.com` }, i)).status).toBe(201);
    expect((await send(waitlist.POST, { email: "late@example.com" }, 999)).status).toBe(429);
  });
});
