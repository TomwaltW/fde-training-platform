// 兑换码与权益:兑换成功与两种失败文案、失败限频、我的权益与每日限额、付费场景开局 403 与兑换后能开、
// 管理页生成与列表。付费场景用临时商品配置(FDE_PRODUCTS_CONFIG)造出来:仓库里的默认配置让所有场景免费。
// 每个用例一个新的内存库,登录的请求次数不会碰到验证码接口的按 IP 限频。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdminRedeemCodesResponse,
  ApiError,
  CreateInvitesResponse,
  CreateRedeemCodesResponse,
  CreateSessionResponse,
  EntitlementsResponse,
  RedeemResponse,
  RequestCodeResponse,
  VerifyResponse,
} from "@fde/contracts";
import * as adminInvites from "../app/api/admin/invites/route.ts";
import * as adminRedeemCodes from "../app/api/admin/redeem-codes/route.ts";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import * as consent from "../app/api/me/consent/route.ts";
import * as myData from "../app/api/me/data/route.ts";
import * as entitlements from "../app/api/me/entitlements/route.ts";
import * as redeem from "../app/api/redeem/route.ts";
import * as sessions from "../app/api/sessions/route.ts";
import { REDEEM_FAILURE_LIMIT, redeemBlocked } from "../lib/server/entitlements.ts";
import { resetForTests } from "../lib/server/runtime.ts";
import { getStore } from "../lib/server/store.ts";
import { Client, errorCode, type CallResult } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const ADMIN = "admin@example.com";
const SCENARIO = "freight-docs";
const tmp = mkdtempSync(join(tmpdir(), "fde-redeem-test-"));
let seq = 0;

const ENV_KEYS = [
  "FDE_ROOT",
  "FDE_ENGINE_MODE",
  "FDE_DEV_LOGIN_CODES",
  "FDE_MEMORY_STORE_FILE",
  "FDE_PRODUCTS_CONFIG",
  "FDE_DAILY_SESSION_LIMIT",
  "ADMIN_EMAILS",
  "FDE_AUTH_SECRET",
  "DATABASE_URL",
  "SMTP_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

/** 场景包排在前面但没上架;求职冲刺包上架。唯一的场景 freight-docs 不免费。 */
const CONFIG = `
free_scenarios: []
human_review_how_to: 加微信 **fde-sim**,备注兑换码预约。
products:
  - id: pack
    name: 场景包
    price_text: "【待定】"
    description: 单个场景。
    includes: {scenarios: [freight-docs], extra_daily_sessions: 2}
    available: false
  - id: sprint
    name: 求职冲刺包
    price_text: 早鸟价 ¥399
    description: 全部场景,外加一次真人复盘。
    includes: {scenarios: all, extra_daily_sessions: 5, human_review: true}
    buy_note: 加微信 fde-sim 购买
    available: true
  - id: empty
    name: 什么都不含
    price_text: "【待定】"
    description: 测试用。
    includes: {scenarios: []}
    available: false
`;

function useConfig(text: string) {
  const file = join(tmp, `products-${++seq}.yaml`);
  writeFileSync(file, text);
  process.env.FDE_PRODUCTS_CONFIG = file;
}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    FDE_ROOT: ROOT,
    FDE_ENGINE_MODE: "offline",
    FDE_DEV_LOGIN_CODES: "1",
    FDE_MEMORY_STORE_FILE: join(tmp, `store-${++seq}.json`),
    ADMIN_EMAILS: ADMIN,
    FDE_AUTH_SECRET: "test-secret",
    FDE_DAILY_SESSION_LIMIT: "2",
  });
  useConfig(CONFIG);
  await resetForTests();
});

afterEach(async () => {
  await resetForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** 登录(新用户要带邀请码,请求验证码和验证时都带上);consent 为 true 时顺便同意协议。 */
async function login(email: string, opts: { inviteCode?: string; consent?: boolean } = {}): Promise<Client> {
  const c = new Client();
  const invite = opts.inviteCode ? { inviteCode: opts.inviteCode } : {};
  const r1 = await c.post<RequestCodeResponse>(requestCode.POST, { body: { email, ...invite } });
  expect(r1.status, JSON.stringify(r1.body)).toBe(200);
  const r2 = await c.post<VerifyResponse>(verify.POST, { body: { email, code: r1.body.devCode, ...invite } });
  expect(r2.status, JSON.stringify(r2.body)).toBe(200);
  if (opts.consent !== false) expect((await c.post(consent.POST, { body: {} })).status).toBe(200);
  return c;
}

async function loginAdmin(): Promise<Client> {
  return login(ADMIN);
}

/** 管理员发一个邀请码,新用户用它登录。 */
async function loginUser(admin: Client, email: string, opts: { consent?: boolean } = {}): Promise<Client> {
  const inv = await admin.post<CreateInvitesResponse>(adminInvites.POST, { body: { count: 1 } });
  expect(inv.status).toBe(201);
  return login(email, { inviteCode: inv.body.codes[0]!, ...opts });
}

async function makeCodes(admin: Client, productId: string, count: number, note?: string): Promise<string[]> {
  const r = await admin.post<CreateRedeemCodesResponse>(adminRedeemCodes.POST, { body: { productId, count, ...(note && { note }) } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.codes;
}

function message(r: CallResult<unknown>): string | undefined {
  return (r.body as ApiError | undefined)?.error?.message;
}

const start = (c: Client) => c.post<CreateSessionResponse>(sessions.POST, { body: { scenarioId: SCENARIO } });

describe("管理员生成与查看兑换码", () => {
  it("只有管理员能用;商品必须在配置里(未上架的也行);数量 1–500", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    expect((await new Client().post(adminRedeemCodes.POST, { body: { productId: "sprint", count: 1 } })).status).toBe(401);
    const forbidden = await user.post(adminRedeemCodes.POST, { body: { productId: "sprint", count: 1 } });
    expect(forbidden.status).toBe(403);
    expect(errorCode(forbidden)).toBe("forbidden");
    expect((await user.get(adminRedeemCodes.GET, { path: "/api/admin/redeem-codes" })).status).toBe(403);

    const unknown = await admin.post(adminRedeemCodes.POST, { body: { productId: "nope", count: 1 } });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown)).toBe("bad_request");
    expect(message(unknown)).toContain("nope");
    expect((await admin.post(adminRedeemCodes.POST, { body: { productId: "sprint", count: 0 } })).status).toBe(400);
    expect((await admin.post(adminRedeemCodes.POST, { body: { productId: "sprint", count: 501 } })).status).toBe(400);

    const codes = await makeCodes(admin, "pack", 3, "企业试点");
    expect(codes).toHaveLength(3);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(new Set(codes).size).toBe(3);
  });

  it("列表新的在前,显示兑换人;byProduct 列出配置里全部商品(含 0 个码的)和库里有、配置里没有的商品", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    const [first] = await makeCodes(admin, "sprint", 2, "早鸟第一批");
    // 库里有一个配置里已经删掉的商品
    await (await getStore()).createRedeemCodes("legacy", 1, "老商品");
    expect((await user.post(redeem.POST, { body: { code: first } })).status).toBe(200);

    const r = await admin.get<AdminRedeemCodesResponse>(adminRedeemCodes.GET, { path: "/api/admin/redeem-codes" });
    expect(r.status).toBe(200);
    expect(r.body.byProduct).toEqual([
      { productId: "pack", productName: "场景包", created: 0, redeemed: 0 },
      { productId: "sprint", productName: "求职冲刺包", created: 2, redeemed: 1 },
      { productId: "empty", productName: "什么都不含", created: 0, redeemed: 0 },
      { productId: "legacy", productName: "legacy", created: 1, redeemed: 0 },
    ]);
    expect(r.body.rows).toHaveLength(3);
    const times = r.body.rows.map((x) => x.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    const used = r.body.rows.find((x) => x.code === first);
    expect(used).toMatchObject({ productId: "sprint", note: "早鸟第一批", redeemedBy: "player@example.com" });
    expect(used?.redeemedAt).toBeTruthy();
    expect(r.body.rows.filter((x) => x.redeemedAt === null && x.redeemedBy === null)).toHaveLength(2);

    // 按商品筛、limit
    const sprintOnly = await admin.get<AdminRedeemCodesResponse>(adminRedeemCodes.GET, { path: "/api/admin/redeem-codes?productId=sprint&limit=1" });
    expect(sprintOnly.body.rows).toHaveLength(1);
    expect(sprintOnly.body.rows[0]?.productId).toBe("sprint");
    expect(sprintOnly.body.byProduct).toHaveLength(4);
    expect((await admin.get(adminRedeemCodes.GET, { path: "/api/admin/redeem-codes?limit=0" })).status).toBe(400);
  });
});

describe("兑换", () => {
  it("需要登录且同意了协议", async () => {
    const admin = await loginAdmin();
    const [code] = await makeCodes(admin, "sprint", 1);
    const anon = await new Client().post(redeem.POST, { body: { code } });
    expect(anon.status).toBe(401);
    const pending = await loginUser(admin, "pending@example.com", { consent: false });
    const r = await pending.post(redeem.POST, { body: { code } });
    expect(r.status).toBe(403);
    expect(errorCode(r)).toBe("consent_required");
    expect((await new Client(pending.cookie).post(redeem.POST, { body: {} })).status).toBe(400);
  });

  it("成功:不区分大小写、忽略空格和短横线;返回权益并记 code_redeemed 事件", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    const [code] = await makeCodes(admin, "sprint", 1);
    const messy = ` ${code!.toLowerCase().replace(/-/g, " ")} `;
    const r = await user.post<RedeemResponse>(redeem.POST, { body: { code: messy } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.entitlement).toMatchObject({
      productId: "sprint",
      productName: "求职冲刺包",
      code,
      includes: { scenarios: "all", extraDailySessions: 5, humanReview: true },
    });
    expect(r.body.entitlements.entitlements).toHaveLength(1);
    expect(r.body.entitlements.dailySessionLimit).toBe(7);

    const store = await getStore();
    const me = await store.getUserByEmail("player@example.com");
    const events = await store.listEvents({ types: ["code_redeemed"] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: me!.id, props: { productId: "sprint" } });
  });

  it("两种失败:兑换码不存在;已被使用(自己再兑一次、别人来兑都一样)", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    const other = await loginUser(admin, "other@example.com");
    const [code] = await makeCodes(admin, "sprint", 1);

    const missing = await user.post(redeem.POST, { body: { code: "ZZZZ-ZZZZ-ZZZZ" } });
    expect(missing.status).toBe(400);
    expect(errorCode(missing)).toBe("redeem_invalid");
    expect(message(missing)).toBe("兑换码不存在");

    expect((await user.post(redeem.POST, { body: { code } })).status).toBe(200);
    for (const c of [user, other]) {
      const again = await c.post(redeem.POST, { body: { code } });
      expect(again.status).toBe(400);
      expect(errorCode(again)).toBe("redeem_invalid");
      expect(message(again)).toBe("这个兑换码已经被使用");
    }
    // 失败不记事件,别人的权益不受影响
    expect(await (await getStore()).listEvents({ types: ["code_redeemed"] })).toHaveLength(1);
    expect((await other.get<EntitlementsResponse>(entitlements.GET)).body.entitlements).toEqual([]);
  });

  it("同一用户 1 小时内失败 10 次后 429(码对了也不行);别的用户不受影响;一小时后恢复", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "guess@example.com");
    const other = await loginUser(admin, "other@example.com");
    const [good] = await makeCodes(admin, "sprint", 1);
    for (let i = 0; i < REDEEM_FAILURE_LIMIT.limit; i++) {
      const r = await user.post(redeem.POST, { body: { code: `WRONG-${String(i).padStart(4, "0")}-XXXX` } });
      expect(r.status, `第 ${i + 1} 次`).toBe(400);
    }
    const blocked = await user.post(redeem.POST, { body: { code: good } });
    expect(blocked.status).toBe(429);
    expect(errorCode(blocked)).toBe("rate_limited");
    // 被挡住的请求没有用掉兑换码
    expect((await other.post(redeem.POST, { body: { code: good } })).status).toBe(200);

    const store = await getStore();
    const me = await store.getUserByEmail("guess@example.com");
    expect(redeemBlocked(me!.id)).toBe(true);
    expect(redeemBlocked(me!.id, Date.now() + REDEEM_FAILURE_LIMIT.windowMs + 1000)).toBe(false);
  });

  it("成功的兑换不计入失败次数", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    const codes = await makeCodes(admin, "pack", 12);
    for (let i = 0; i < 9; i++) expect((await user.post(redeem.POST, { body: { code: `BAD${i}` } })).status).toBe(400);
    for (const code of codes.slice(0, 3)) expect((await user.post(redeem.POST, { body: { code } })).status).toBe(200);
    expect((await user.post(redeem.POST, { body: { code: "BAD9" } })).status).toBe(400);
    expect((await user.post(redeem.POST, { body: { code: codes[3] } })).status).toBe(429);
  });
});

describe("我的权益与每日限额", () => {
  it("没兑换过:基础限额,只有免费场景;兑换后叠加商品的权益(同一商品兑多次只算一次)", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    expect((await new Client().get(entitlements.GET)).status).toBe(401);

    const empty = await user.get<EntitlementsResponse>(entitlements.GET);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ entitlements: [], dailySessionLimit: 2, scenarios: [], humanReview: false, humanReviewHowTo: null });

    const [p1, p2] = await makeCodes(admin, "pack", 2);
    await user.post(redeem.POST, { body: { code: p1 } });
    const pack = (await user.get<EntitlementsResponse>(entitlements.GET)).body;
    expect(pack.dailySessionLimit).toBe(4);
    expect(pack.scenarios).toEqual([SCENARIO]);
    expect(pack.humanReview).toBe(false);
    expect(pack.humanReviewHowTo).toBeNull();
    await user.post(redeem.POST, { body: { code: p2 } });
    expect((await user.get<EntitlementsResponse>(entitlements.GET)).body.dailySessionLimit).toBe(4);

    const [s1] = await makeCodes(admin, "sprint", 1);
    await user.post(redeem.POST, { body: { code: s1 } });
    const all = (await user.get<EntitlementsResponse>(entitlements.GET)).body;
    expect(all.entitlements.map((e) => e.productId).sort()).toEqual(["pack", "pack", "sprint"]);
    expect(all.dailySessionLimit).toBe(2 + 2 + 5);
    expect(all.scenarios).toBe("all");
    expect(all.humanReview).toBe(true);
    expect(all.humanReviewHowTo).toBe("加微信 **fde-sim**,备注兑换码预约。");
  });

  it("配置里已经没有的商品照样列出来(名称用 id,不再附带权益)", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    const [code] = await makeCodes(admin, "sprint", 1);
    await user.post(redeem.POST, { body: { code } });
    // 作者把冲刺包从配置里删了
    useConfig(CONFIG.replace(/  - id: sprint[\s\S]*?available: true\n/, ""));
    const r = (await user.get<EntitlementsResponse>(entitlements.GET)).body;
    expect(r.entitlements).toEqual([
      { productId: "sprint", productName: "sprint", code, redeemedAt: expect.any(String), includes: { scenarios: [], extraDailySessions: 0, humanReview: false } },
    ]);
    expect(r.dailySessionLimit).toBe(2);
    expect(r.scenarios).toEqual([]);
    expect(r.humanReview).toBe(false);
  });
});

describe("付费场景开局", () => {
  it("没有权益 403 entitlement_required,提示第一个上架的商品;兑换后能开", async () => {
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    const denied = await start(user);
    expect(denied.status).toBe(403);
    expect(errorCode(denied)).toBe("entitlement_required");
    expect(message(denied)).toBe("这个场景需要兑换「求职冲刺包」后才能玩");
    // 不含这个场景的商品没用
    const [e] = await makeCodes(admin, "empty", 1);
    await user.post(redeem.POST, { body: { code: e } });
    expect((await start(user)).status).toBe(403);

    const [code] = await makeCodes(admin, "sprint", 1);
    expect((await user.post(redeem.POST, { body: { code } })).status).toBe(200);
    const ok = await start(user);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.sessionId).toBeTruthy();
  });

  it("只列了这个场景的商品(未上架)也能解锁;没有上架商品时提示里列未上架的那个", async () => {
    useConfig(CONFIG.replace("available: true", "available: false"));
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    expect(message(await start(user))).toBe("这个场景需要兑换「场景包」后才能玩");
    const [code] = await makeCodes(admin, "pack", 1);
    await user.post(redeem.POST, { body: { code } });
    expect((await start(user)).status).toBe(201);
  });

  it("免费场景不需要兑换;没有商品配置时所有场景免费", async () => {
    useConfig(CONFIG.replace("free_scenarios: []", `free_scenarios: [${SCENARIO}]`));
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    expect((await start(user)).status).toBe(201);
    process.env.FDE_PRODUCTS_CONFIG = join(tmp, "missing-products.yaml");
    expect((await start(user)).status).toBe(201);
    expect((await user.get<EntitlementsResponse>(entitlements.GET)).body.scenarios).toBe("all");
  });

  it("每日限额 = 基础限额 + 商品多给的局数;删掉的对局照样计数", async () => {
    process.env.FDE_DAILY_SESSION_LIMIT = "1";
    const admin = await loginAdmin();
    const user = await loginUser(admin, "player@example.com");
    const [code] = await makeCodes(admin, "pack", 1);
    await user.post(redeem.POST, { body: { code } });
    for (let i = 0; i < 3; i++) expect((await start(user)).status, `第 ${i + 1} 局`).toBe(201);
    const over = await start(user);
    expect(over.status).toBe(429);
    expect(message(over)).toBe("今天的 3 局已经用完了,明天再来");
    // session_created 事件照常记
    expect(await (await getStore()).listEvents({ types: ["session_created"] })).toHaveLength(3);
    expect((await user.del(myData.DELETE)).status).toBe(200);
    expect((await start(user)).status).toBe(429);
  });
});
