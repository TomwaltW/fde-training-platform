// 手机号登录(F4):开关、手机号规范化、新手机号要邀请码(核对不消耗,验证通过才消耗)、各项限频、devCode、
// 配置了短信时真发(本地假服务)、发送失败退回 60 秒名额并返回 500、日志脱敏、verify 发 cookie 并记 login 事件。
// 验证码接口有按 IP 的限频:这里每个请求默认用不同的 x-forwarded-for,互不影响。
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, MeResponse, RequestCodeResponse, SiteInfo, VerifyResponse } from "@fde/contracts";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import * as me from "../app/api/me/route.ts";
import * as site from "../app/api/site/route.ts";
import { LIMITS } from "../lib/server/ratelimit.ts";
import { resetForTests, runtime } from "../lib/server/runtime.ts";
import { getStore } from "../lib/server/store.ts";

const PHONE = "+8613812345678";
const SECRET = "sms-secret-DO-NOT-LOG";

// ---------------------------------------------------------------- 请求工具

type Handler = (req: Request) => Promise<Response>;
interface Result<T> {
  status: number;
  body: T;
  res: Response;
}

let ipSeq = 0;
/** POST 一个 JSON 请求体;默认每次换一个 IP。 */
async function post<T = unknown>(handler: Handler, body: unknown, opts: { ip?: string; cookie?: string } = {}): Promise<Result<T>> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": opts.ip ?? `198.51.100.${++ipSeq % 250}, 10.0.0.1` };
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await handler(new Request("http://localhost/api/test", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.clone().json()) as T, res };
}

async function get<T = unknown>(handler: Handler, cookie?: string): Promise<Result<T>> {
  const res = await handler(new Request("http://localhost/api/test", { headers: cookie ? { cookie } : {} }));
  return { status: res.status, body: (await res.clone().json()) as T, res };
}

const errorOf = (r: Result<unknown>) => (r.body as ApiError).error;
const sessionCookieOf = (r: Result<unknown>) => /^fde_session=([^;]+)/.exec(r.res.headers.get("set-cookie") ?? "")?.[1];

/** 模拟过了一分钟:清掉"同一地址 60 秒一次"的计时。 */
function forgetCodeRequests() {
  runtime().codeRequests.clear();
}

async function newInvite(): Promise<string> {
  const [code] = await (await getStore()).createInvites(1, 1, "手机号登录测试");
  return code!;
}

// ---------------------------------------------------------------- 假的阿里云短信服务

type SmsReply = { code: string; message: string; status?: number };
let smsServer: Server;
let smsEndpoint = "";
let smsReply: SmsReply = { code: "OK", message: "OK" };
let smsReceived: URLSearchParams[] = [];

beforeAll(async () => {
  smsServer = createServer((req, res) => {
    smsReceived.push(new URL(req.url ?? "/", "http://fake").searchParams);
    res.writeHead(smsReply.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Code: smsReply.code, Message: smsReply.message, RequestId: "REQ-T", BizId: "BIZ-T" }));
  });
  await new Promise<void>((r) => smsServer.listen(0, "127.0.0.1", r));
  smsEndpoint = `http://127.0.0.1:${(smsServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  smsServer.closeAllConnections();
  await new Promise<void>((r) => smsServer.close(() => r()));
});

/** 收到的最后一条短信里的验证码。 */
function lastSmsCode(): string | undefined {
  const p = smsReceived.at(-1)?.get("TemplateParam");
  return p ? (JSON.parse(p) as { code: string }).code : undefined;
}

// ---------------------------------------------------------------- 环境

const env = process.env as Record<string, string | undefined>;
const KEYS = [
  "NODE_ENV",
  "FDE_ROOT",
  "FDE_MEMORY_STORE_FILE",
  "FDE_AUTH_SECRET",
  "ADMIN_EMAILS",
  "DATABASE_URL",
  "SMTP_URL",
  "FDE_DEV_LOGIN_CODES",
  "FDE_DEV_LOGIN_CODES_IN_PRODUCTION",
  "FDE_DEV_SMS_LOGIN",
  "ALIYUN_SMS_ACCESS_KEY_ID",
  "ALIYUN_SMS_ACCESS_KEY_SECRET",
  "ALIYUN_SMS_SIGN_NAME",
  "ALIYUN_SMS_TEMPLATE_CODE",
  "ALIYUN_SMS_ENDPOINT",
  "SMS_HOURLY_LIMIT",
  "SMS_DAILY_PER_PHONE",
  "SITE_MODEL_DISCLOSURE",
];
let saved: Record<string, string | undefined> = {};
/** 测试期间所有 console 输出(用来检查日志脱敏)。 */
let logs: string[] = [];

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
  for (const k of KEYS) if (k !== "NODE_ENV") delete env[k];
  Object.assign(env, {
    FDE_ROOT: resolve(import.meta.dirname, "../../.."),
    FDE_MEMORY_STORE_FILE: join(mkdtempSync(join(tmpdir(), "fde-login-phone-")), "store.json"),
    FDE_AUTH_SECRET: "test-secret",
    ADMIN_EMAILS: "admin@example.com",
    // 默认:开发模式下打开手机号登录(不配短信,验证码在响应里回显)
    FDE_DEV_LOGIN_CODES: "1",
    FDE_DEV_SMS_LOGIN: "1",
  });
  smsReply = { code: "OK", message: "OK" };
  smsReceived = [];
  logs = [];
  for (const level of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "));
    });
  }
  await resetForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  await resetForTests();
});

/** 配置阿里云短信(指向本地假服务);dev=false 时关掉开发模式。 */
function configureSms(dev: boolean) {
  Object.assign(env, {
    ALIYUN_SMS_ACCESS_KEY_ID: "LTAI-test-id",
    ALIYUN_SMS_ACCESS_KEY_SECRET: SECRET,
    ALIYUN_SMS_SIGN_NAME: "FDE训练场",
    ALIYUN_SMS_TEMPLATE_CODE: "SMS_123456789",
    ALIYUN_SMS_ENDPOINT: smsEndpoint,
  });
  if (!dev) {
    delete env.FDE_DEV_LOGIN_CODES;
    delete env.FDE_DEV_SMS_LOGIN;
  }
}

/** 手机号登录一遍(请求验证码 → 校验),返回 cookie。 */
async function phoneLogin(phone: string, inviteCode?: string): Promise<{ cookie: string; user: VerifyResponse["user"] }> {
  const r1 = await post<RequestCodeResponse>(requestCode.POST, { phone, ...(inviteCode && { inviteCode }) });
  expect(r1.status, JSON.stringify(r1.body)).toBe(200);
  const code = r1.body.devCode ?? lastSmsCode();
  const r2 = await post<VerifyResponse>(verify.POST, { phone, code, ...(inviteCode && { inviteCode }) });
  expect(r2.status, JSON.stringify(r2.body)).toBe(200);
  return { cookie: `fde_session=${sessionCookieOf(r2)}`, user: r2.body.user };
}

// ================================================================ 开关

describe("开关 smsLoginEnabled()", () => {
  it("没配短信、没开 FDE_DEV_SMS_LOGIN:site.smsLogin 为 false,带 phone 的 request-code / verify 都是 400「暂不支持手机号登录」,邮箱照常", async () => {
    delete env.FDE_DEV_SMS_LOGIN;
    expect((await get<SiteInfo>(site.GET)).body.smsLogin).toBe(false);
    const r1 = await post(requestCode.POST, { phone: "13812345678", inviteCode: await newInvite() });
    expect(r1.status).toBe(400);
    expect(errorOf(r1)).toEqual({ code: "bad_request", message: "暂不支持手机号登录" });
    const r2 = await post(verify.POST, { phone: "13812345678", code: "123456" });
    expect(r2.status).toBe(400);
    expect(errorOf(r2)).toEqual({ code: "bad_request", message: "暂不支持手机号登录" });
    expect(runtime().codeRequests.size).toBe(0);
    // 邮箱登录不受影响
    const r3 = await post<RequestCodeResponse>(requestCode.POST, { email: "admin@example.com" });
    expect(r3.status).toBe(200);
    expect(r3.body.devCode).toMatch(/^\d{6}$/);
  });

  it("开发模式 + FDE_DEV_SMS_LOGIN=1 打开;生产环境少了 FDE_DEV_LOGIN_CODES_IN_PRODUCTION 就不算;配置了阿里云短信就打开", async () => {
    expect((await get<SiteInfo>(site.GET)).body.smsLogin).toBe(true);
    env.NODE_ENV = "production";
    expect((await get<SiteInfo>(site.GET)).body.smsLogin).toBe(false);
    expect((await post(requestCode.POST, { phone: "13812345678" })).status).toBe(400);
    env.NODE_ENV = saved.NODE_ENV ?? "test";
    configureSms(false);
    expect((await get<SiteInfo>(site.GET)).body.smsLogin).toBe(true);
    // 四个变量少一个都不算配置了
    delete env.ALIYUN_SMS_TEMPLATE_CODE;
    expect((await get<SiteInfo>(site.GET)).body.smsLogin).toBe(false);
  });
});

// ================================================================ 规范化

describe("手机号规范化", () => {
  it("+86、86、0086 前缀和空格、短横线都算同一个号码(存成 +86 开头),共用 60 秒限频", async () => {
    const invite = await newInvite();
    const r1 = await post<RequestCodeResponse>(requestCode.POST, { phone: "+86 138-1234-5678", inviteCode: invite });
    expect(r1.status).toBe(200);
    expect(runtime().codeRequests.has(PHONE)).toBe(true);
    // 换一种写法再请求:还是同一个地址,60 秒内 429
    const again = await post(requestCode.POST, { phone: "0086 13812345678", inviteCode: invite });
    expect(again.status).toBe(429);
    expect(errorOf(again).message).toMatch(/秒后再试/);
    // 用另一种写法校验也能通过
    const r2 = await post<VerifyResponse>(verify.POST, { phone: "8613812345678", code: r1.body.devCode, inviteCode: invite });
    expect(r2.status).toBe(200);
    expect(r2.body.user).toMatchObject({ email: null, phone: PHONE, isAdmin: false, consentAt: null });
    expect(await (await getStore()).getUserByPhone(PHONE)).not.toBeNull();
  });

  it.each([["12345678901"], ["1381234567"], ["138123456789"], ["+1 4155550100"], ["abc"]])("不是大陆手机号 %j → 400「手机号格式不对」", async (phone) => {
    const r = await post(requestCode.POST, { phone, inviteCode: await newInvite() });
    expect(r.status).toBe(400);
    expect(errorOf(r).code).toBe("bad_request");
    expect(errorOf(r).message).toContain("手机号格式不对");
  });

  it("邮箱和手机号必须且只能给一个", async () => {
    expect((await post(requestCode.POST, { email: "a@example.com", phone: "13812345678" })).status).toBe(400);
    expect((await post(requestCode.POST, { inviteCode: "X" })).status).toBe(400);
    expect((await post(verify.POST, { email: "a@example.com", phone: "13812345678", code: "123456" })).status).toBe(400);
  });
});

// ================================================================ 邀请码

describe("新手机号要邀请码", () => {
  it("没带或带错 → 400 invite_invalid,并且退回 60 秒名额;带对了只核对不消耗,验证通过才消耗并建用户", async () => {
    const store = await getStore();
    const invite = await newInvite();
    const none = await post(requestCode.POST, { phone: PHONE });
    expect(none.status).toBe(400);
    expect(errorOf(none).code).toBe("invite_invalid");
    const wrong = await post(requestCode.POST, { phone: PHONE, inviteCode: "NOPE2345" });
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).code).toBe("invite_invalid");
    // 名额退回了:马上用对的邀请码再请求不会 429
    const r = await post<RequestCodeResponse>(requestCode.POST, { phone: PHONE, inviteCode: ` ${invite.toLowerCase()} ` });
    expect(r.status).toBe(200);
    expect(await store.inviteAvailable(invite)).toBe(true);
    expect(await store.getUserByPhone(PHONE)).toBeNull();

    // 校验时没带邀请码:验证码对了也不建用户
    const noInvite = await post(verify.POST, { phone: PHONE, code: r.body.devCode });
    expect(noInvite.status).toBe(400);
    expect(errorOf(noInvite).code).toBe("invite_invalid");
    expect(await store.getUserByPhone(PHONE)).toBeNull();

    // 重新请求,这次带着邀请码校验:消耗邀请码、建用户
    forgetCodeRequests();
    const r2 = await post<RequestCodeResponse>(requestCode.POST, { phone: PHONE, inviteCode: invite });
    const ok = await post<VerifyResponse>(verify.POST, { phone: PHONE, code: r2.body.devCode, inviteCode: invite });
    expect(ok.status).toBe(200);
    expect(await store.inviteAvailable(invite)).toBe(false);
    expect(ok.body.user.phone).toBe(PHONE);

    // 一次性邀请码已经用掉:别的新手机号再用就不行了
    const other = await post(requestCode.POST, { phone: "13900001111", inviteCode: invite });
    expect(errorOf(other).code).toBe("invite_invalid");
  });

  it("老用户不用邀请码;请求和校验之间邀请码被别人用掉 → 校验时 invite_invalid", async () => {
    const invite = await newInvite();
    await phoneLogin(PHONE, invite);
    forgetCodeRequests();
    const old = await post<RequestCodeResponse>(requestCode.POST, { phone: PHONE });
    expect(old.status).toBe(200);
    expect((await post(verify.POST, { phone: PHONE, code: old.body.devCode })).status).toBe(200);

    const shared = await newInvite();
    const r = await post<RequestCodeResponse>(requestCode.POST, { phone: "13900001111", inviteCode: shared });
    expect(r.status).toBe(200);
    await (await getStore()).redeemInvite(shared);
    const late = await post(verify.POST, { phone: "13900001111", code: r.body.devCode, inviteCode: shared });
    expect(late.status).toBe(400);
    expect(errorOf(late).code).toBe("invite_invalid");
  });

  it("手机号没有管理员豁免,也不会是管理员", async () => {
    env.ADMIN_EMAILS = "admin@example.com,13812345678,+8613812345678";
    const r = await post(requestCode.POST, { phone: PHONE });
    expect(errorOf(r).code).toBe("invite_invalid");
    const { user } = await phoneLogin(PHONE, await newInvite());
    expect(user.isAdmin).toBe(false);
  });
});

// ================================================================ 限频

describe("限频", () => {
  it("同一手机号 60 秒一次(429 并给出秒数);别的手机号不受影响", async () => {
    const invite = await newInvite();
    expect((await post(requestCode.POST, { phone: PHONE, inviteCode: invite })).status).toBe(200);
    const again = await post(requestCode.POST, { phone: PHONE, inviteCode: invite });
    expect(again.status).toBe(429);
    expect(errorOf(again)).toEqual({ code: "rate_limited", message: expect.stringMatching(/请 \d+ 秒后再试/) });
    expect((await post(requestCode.POST, { phone: "13900001111", inviteCode: invite })).status).toBe(200);
  });

  it("同一手机号每个北京时间自然日最多 SMS_DAILY_PER_PHONE 条,过了零点重新算;邀请码无效的请求不计数", async () => {
    env.SMS_DAILY_PER_PHONE = "2";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T15:50:00Z")); // 北京时间 23:50
    const invite = await newInvite();
    expect((await post(requestCode.POST, { phone: PHONE })).status).toBe(400); // 没邀请码,不计数
    for (let i = 0; i < 2; i++) {
      forgetCodeRequests();
      expect((await post(requestCode.POST, { phone: PHONE, inviteCode: invite })).status).toBe(200);
    }
    forgetCodeRequests();
    const blocked = await post(requestCode.POST, { phone: PHONE, inviteCode: invite });
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked).message).toContain("今天");
    // 别的号码不受影响
    expect((await post(requestCode.POST, { phone: "13900001111", inviteCode: invite })).status).toBe(200);
    // 被挡住的那次退回了 60 秒名额,但当天条数还是用完了
    expect((await post(requestCode.POST, { phone: PHONE, inviteCode: invite })).status).toBe(429);

    vi.setSystemTime(new Date("2026-10-05T16:00:30Z")); // 北京时间第二天 00:00:30
    forgetCodeRequests();
    expect((await post(requestCode.POST, { phone: PHONE, inviteCode: invite })).status).toBe(200);
  });

  it("全站每小时最多 SMS_HOURLY_LIMIT 条短信,超了 429;邮箱不受影响;一小时后恢复", async () => {
    env.SMS_HOURLY_LIMIT = "3";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T02:00:00Z"));
    const invite = await newInvite();
    for (const p of ["13900000001", "13900000002", "13900000003"]) expect((await post(requestCode.POST, { phone: p, inviteCode: invite })).status).toBe(200);
    const blocked = await post(requestCode.POST, { phone: "13900000004", inviteCode: invite });
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked)).toEqual({ code: "rate_limited", message: expect.stringContaining("改用邮箱登录") });
    expect(runtime().codeRequests.has("+8613900000004")).toBe(false); // 退回了 60 秒名额
    expect((await post(requestCode.POST, { email: "admin@example.com" })).status).toBe(200);

    vi.setSystemTime(new Date("2026-10-05T03:00:01Z"));
    expect((await post(requestCode.POST, { phone: "13900000004", inviteCode: invite })).status).toBe(200);
  });

  it("按 IP 的限频对手机号同样有效", async () => {
    const ip = "203.0.113.9";
    for (let i = 0; i < LIMITS.requestCodePerIp.limit; i++) {
      const r = await post(requestCode.POST, { phone: `139000000${String(i).padStart(2, "0")}`, inviteCode: "NOPE2345" }, { ip });
      expect(r.status).toBe(400);
    }
    expect((await post(requestCode.POST, { phone: PHONE, inviteCode: await newInvite() }, { ip })).status).toBe(429);
    expect((await post(requestCode.POST, { phone: PHONE, inviteCode: await newInvite() })).status).toBe(200);
  });
});

// ================================================================ 发短信与 devCode

describe("发送验证码", () => {
  it("开发模式没配短信:不发短信,响应里回显 devCode;日志里的手机号脱敏", async () => {
    const r = await post<RequestCodeResponse>(requestCode.POST, { phone: PHONE, inviteCode: await newInvite() });
    expect(r.status).toBe(200);
    expect(r.body.devCode).toMatch(/^\d{6}$/);
    expect(smsReceived).toHaveLength(0);
    expect(logs.join("\n")).toContain(`138****5678 的登录验证码:${r.body.devCode}`);
    expect(logs.join("\n")).not.toContain("13812345678");
  });

  it("配置了短信(非开发模式):真发到阿里云(假服务),响应里没有 devCode,用短信里的验证码能登录", async () => {
    configureSms(false);
    const invite = await newInvite();
    const r = await post<RequestCodeResponse>(requestCode.POST, { phone: "+86 138 1234 5678", inviteCode: invite });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(smsReceived).toHaveLength(1);
    const q = smsReceived[0]!;
    expect(q.get("Action")).toBe("SendSms");
    expect(q.get("PhoneNumbers")).toBe("13812345678");
    expect(q.get("SignName")).toBe("FDE训练场");
    expect(q.get("TemplateCode")).toBe("SMS_123456789");
    expect(q.get("Signature")).toBeTruthy();
    const code = lastSmsCode();
    expect(code).toMatch(/^\d{6}$/);
    const ok = await post<VerifyResponse>(verify.POST, { phone: PHONE, code, inviteCode: invite });
    expect(ok.status).toBe(200);
    expect(logs.join("\n")).not.toContain("13812345678");
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("配置了短信又开着开发模式:照样发短信,同时回显 devCode", async () => {
    configureSms(true);
    const r = await post<RequestCodeResponse>(requestCode.POST, { phone: PHONE, inviteCode: await newInvite() });
    expect(r.status).toBe(200);
    expect(smsReceived).toHaveLength(1);
    expect(r.body.devCode).toBe(lastSmsCode());
  });

  it("发送失败:500 internal、退回 60 秒名额;响应和日志里没有 Secret 和完整手机号,日志里有阿里云的 Code", async () => {
    configureSms(false);
    smsReply = {
      code: "SignatureDoesNotMatch",
      message: `Specified signature is not matched with our calculation. server string to sign is:GET&%2F&PhoneNumbers%3D13812345678 ${SECRET}`,
      status: 400,
    };
    const invite = await newInvite();
    const r = await post(requestCode.POST, { phone: PHONE, inviteCode: invite });
    expect(r.status).toBe(500);
    expect(errorOf(r).code).toBe("internal");
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect(runtime().codeRequests.has(PHONE)).toBe(false);
    const all = logs.join("\n");
    expect(all).toContain("SignatureDoesNotMatch");
    expect(all).toContain("138****5678");
    expect(all).not.toContain("13812345678");
    expect(all).not.toContain(SECRET);

    // 名额退回了:马上重试会再发一次(这次成功)
    smsReply = { code: "OK", message: "OK" };
    const retry = await post(requestCode.POST, { phone: PHONE, inviteCode: invite });
    expect(retry.status).toBe(200);
    expect(smsReceived).toHaveLength(2);
  });

  it("阿里云返回业务错误(Code 不是 OK,HTTP 200)也算失败", async () => {
    configureSms(false);
    smsReply = { code: "isv.BUSINESS_LIMIT_CONTROL", message: "触发天级流控Permits:10" };
    const r = await post(requestCode.POST, { phone: PHONE, inviteCode: await newInvite() });
    expect(r.status).toBe(500);
    expect(errorOf(r).message).toContain("改用邮箱登录");
    expect(logs.join("\n")).toContain("isv.BUSINESS_LIMIT_CONTROL");
  });
});

// ================================================================ verify

describe("verify(手机号)", () => {
  it("成功:发 httpOnly cookie,/api/me 是手机号用户;记 login 事件(method=phone,带访客 id);邮箱登录仍记 method=email", async () => {
    const invite = await newInvite();
    const r1 = await post<RequestCodeResponse>(requestCode.POST, { phone: PHONE, inviteCode: invite });
    const wrong = await post(verify.POST, { phone: PHONE, code: r1.body.devCode === "000000" ? "111111" : "000000", inviteCode: invite });
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).code).toBe("code_invalid");

    const visitor = "visitor_abcdefghijklmnop";
    const r2 = await post<VerifyResponse>(verify.POST, { phone: PHONE, code: r1.body.devCode, inviteCode: invite }, { cookie: `fde_vid=${visitor}` });
    expect(r2.status).toBe(200);
    const setCookie = r2.res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^fde_session=[^;]+;/);
    expect(setCookie).toContain("HttpOnly");
    const meRes = await get<MeResponse>(me.GET, `fde_session=${sessionCookieOf(r2)}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user).toMatchObject({ email: null, phone: PHONE, isAdmin: false });

    // 邮箱登录
    const e1 = await post<RequestCodeResponse>(requestCode.POST, { email: "admin@example.com" });
    expect((await post(verify.POST, { email: "admin@example.com", code: e1.body.devCode })).status).toBe(200);

    const events = await (await getStore()).listEvents({ types: ["login"] });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "login", userId: r2.body.user.id, visitorId: visitor, props: { method: "phone" } });
    expect(events[1]!.props).toEqual({ method: "email" });
  });

  it("同一个用户:手机号和邮箱是两个账号,验证码互不通用", async () => {
    const r = await post<RequestCodeResponse>(requestCode.POST, { phone: PHONE, inviteCode: await newInvite() });
    const cross = await post(verify.POST, { email: "admin@example.com", code: r.body.devCode });
    expect(cross.status).toBe(400);
    expect(errorOf(cross).code).toBe("code_invalid");
  });
});
