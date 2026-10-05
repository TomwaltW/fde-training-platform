// 后端接口测试:直接调用 route handler(离线引擎 + 落盘的 MemoryStore),从登录走到复盘,
// 并覆盖权限、限额、并发、资料鉴权、收工幂等、删除数据、管理接口。
// 约定:别人的对局统一返回 403 forbidden(spec 3.3 二选一,这里固定)。
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AdminFeedbackResponse,
  AdminSessionDetail,
  AdminSessionsResponse,
  AdminStats,
  ArtifactResponse,
  CreateInvitesResponse,
  CreateSessionResponse,
  DeleteMyDataResponse,
  FinishResponse,
  MeResponse,
  ReportResponse,
  RequestCodeResponse,
  ScenariosResponse,
  SessionResponse,
  SessionsResponse,
  SiteInfo,
  TurnResponse,
  VerifyResponse,
} from "@fde/contracts";
import * as adminFeedback from "../app/api/admin/feedback/route.ts";
import * as adminInvites from "../app/api/admin/invites/route.ts";
import * as adminSession from "../app/api/admin/sessions/[id]/route.ts";
import * as adminSessions from "../app/api/admin/sessions/route.ts";
import * as adminStats from "../app/api/admin/stats/route.ts";
import * as logout from "../app/api/auth/logout/route.ts";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import * as consent from "../app/api/me/consent/route.ts";
import * as myData from "../app/api/me/data/route.ts";
import * as me from "../app/api/me/route.ts";
import * as feedback from "../app/api/reports/[id]/feedback/route.ts";
import * as report from "../app/api/reports/[id]/route.ts";
import * as scenarios from "../app/api/scenarios/route.ts";
import * as actions from "../app/api/sessions/[id]/actions/route.ts";
import * as artifactFile from "../app/api/sessions/[id]/artifacts/[aid]/files/[name]/route.ts";
import * as artifact from "../app/api/sessions/[id]/artifacts/[aid]/route.ts";
import * as finish from "../app/api/sessions/[id]/finish/route.ts";
import * as session from "../app/api/sessions/[id]/route.ts";
import * as turns from "../app/api/sessions/[id]/turns/route.ts";
import * as sessions from "../app/api/sessions/route.ts";
import * as site from "../app/api/site/route.ts";
import { resetForTests, runtime } from "../lib/server/runtime.ts";
import { startOfDayUtc8 } from "../lib/server/sessions.ts";
import { getStore } from "../lib/server/store.ts";
import { Client, errorCode } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const ADMIN = "admin@example.com";
const tmp = mkdtempSync(join(tmpdir(), "fde-web-test-"));
const storeFile = join(tmp, "store.json");

const ENV_KEYS = [
  "FDE_ROOT",
  "FDE_ENGINE_MODE",
  "FDE_DEV_LOGIN_CODES",
  "FDE_MEMORY_STORE_FILE",
  "ADMIN_EMAILS",
  "FDE_AUTH_SECRET",
  "DATABASE_URL",
  "SMTP_URL",
  "FDE_DAILY_SESSION_LIMIT",
  "FDE_COOKIE_SECURE",
  "SITE_MODEL_DISCLOSURE",
  "SITE_ICP_NUMBER",
  "SITE_PUBLIC_SECURITY_NUMBER",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    FDE_ROOT: ROOT,
    FDE_ENGINE_MODE: "offline",
    FDE_DEV_LOGIN_CODES: "1",
    FDE_MEMORY_STORE_FILE: storeFile,
    ADMIN_EMAILS: ` Admin@Example.com , boss@example.com`,
    FDE_AUTH_SECRET: "test-secret",
    SITE_MODEL_DISCLOSURE: "通义千问 qwen-plus(备案号:测试)",
  });
  await resetForTests();
});

afterAll(async () => {
  await resetForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** 让"60 秒内只能请求一次"的计时器过期(模拟过了一分钟)。 */
function forgetCodeRequests() {
  runtime().codeRequests.clear();
}

async function login(email: string, inviteCode?: string): Promise<Client> {
  const c = new Client();
  const r1 = await c.post<RequestCodeResponse>(requestCode.POST, { body: { email, ...(inviteCode && { inviteCode }) } });
  expect(r1.status, JSON.stringify(r1.body)).toBe(200);
  expect(r1.body.devCode).toMatch(/^\d{6}$/);
  const r2 = await c.post<VerifyResponse>(verify.POST, { body: { email, code: r1.body.devCode, ...(inviteCode && { inviteCode }) } });
  expect(r2.status).toBe(200);
  expect(c.cookie).toBeTruthy();
  return c;
}

const sid = (id: string) => ({ params: { id } });

describe("公开接口", () => {
  it("GET /api/site 返回 SiteInfo", async () => {
    const r = await new Client().get<SiteInfo>(site.GET);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      aiNotice: "对话内容由 AI 生成",
      modelDisclosure: "通义千问 qwen-plus(备案号:测试)",
      icpNumber: null,
      publicSecurityNumber: null,
      inviteOnly: true,
      smsLogin: false,
      presaleOpen: false,
    });
  });

  it("GET /api/scenarios 返回场景一", async () => {
    const r = await new Client().get<ScenariosResponse>(scenarios.GET);
    expect(r.status).toBe(200);
    const s = r.body.scenarios.find((x) => x.id === "freight-docs");
    expect(s).toBeDefined();
    expect(s!.title).toContain("单据识别");
    expect(s!.opening.speakerName).toBeTruthy();
    expect(s!.opening.text).toContain("单据");
  });

  it("未登录访问需要登录的接口 → 401 unauthorized", async () => {
    const anon = new Client();
    for (const [method, handler, opts] of [
      ["GET", me.GET, {}],
      ["GET", sessions.GET, {}],
      ["POST", sessions.POST, { body: { scenarioId: "freight-docs" } }],
      ["POST", consent.POST, {}],
      ["DELETE", myData.DELETE, {}],
      ["POST", logout.POST, {}],
      ["GET", adminStats.GET, {}],
      ["GET", session.GET, sid("whatever")],
    ] as const) {
      const r = await anon.call(method, handler, opts);
      expect(r.status, `${method} ${String(handler.name)}`).toBe(401);
      expect(errorCode(r)).toBe("unauthorized");
    }
    // 伪造的 cookie 也一样
    const fake = new Client("fde_session=not-a-real-token");
    const r = await fake.get(me.GET);
    expect(r.status).toBe(401);
  });
});

describe("登录与完整一局", () => {
  let admin: Client;
  let player: Client;
  let other: Client;
  let invites: string[] = [];
  let sessionId = "";

  it("新邮箱没有邀请码或邀请码无效 → 400 invite_invalid,且不创建用户", async () => {
    const c = new Client();
    const r1 = await c.post(requestCode.POST, { body: { email: "nobody@example.com" } });
    expect(r1.status).toBe(400);
    expect(errorCode(r1)).toBe("invite_invalid");
    const r2 = await c.post(requestCode.POST, { body: { email: "nobody@example.com", inviteCode: "NOPE2345" } });
    expect(r2.status).toBe(400);
    expect(errorCode(r2)).toBe("invite_invalid");
    expect(await (await getStore()).getUserByEmail("nobody@example.com")).toBeNull();
  });

  it("请求体不合法 → 400 bad_request", async () => {
    const c = new Client();
    const r1 = await c.post(requestCode.POST, { body: { email: "not-an-email" } });
    expect(r1.status).toBe(400);
    expect(errorCode(r1)).toBe("bad_request");
    const r2 = await c.post(requestCode.POST, { rawBody: "{oops" });
    expect(r2.status).toBe(400);
    expect(errorCode(r2)).toBe("bad_request");
  });

  it("管理员邮箱首次登录不需要邀请码,能生成邀请码", async () => {
    admin = await login("ADMIN@example.com");
    const r = await admin.get<MeResponse>(me.GET);
    expect(r.body.user).toMatchObject({ email: ADMIN, isAdmin: true, consentAt: null });
    const inv = await admin.post<CreateInvitesResponse>(adminInvites.POST, { body: { count: 3, note: "测试" } });
    expect(inv.status).toBe(201);
    expect(inv.body.codes).toHaveLength(3);
    for (const code of inv.body.codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    invites = inv.body.codes;
  });

  it("新用户:带邀请码请求验证码(只核对不消耗)→ 验证通过时才消耗邀请码并创建用户;60 秒内重复请求 429", async () => {
    const c = new Client();
    const store = await getStore();
    // 邀请码大小写、空白都不影响
    const r = await c.post<RequestCodeResponse>(requestCode.POST, { body: { email: " Player@Example.com ", inviteCode: ` ${invites[0]!.toLowerCase()} ` } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.devCode).toMatch(/^\d{6}$/);
    // 还没验证:不建用户、不消耗邀请码(输错邮箱不会白白用掉一次性邀请码)
    expect(await store.getUserByEmail("player@example.com")).toBeNull();
    expect(await store.inviteAvailable(invites[0]!)).toBe(true);

    const again = await c.post(requestCode.POST, { body: { email: "player@example.com" } });
    expect(again.status).toBe(429);
    expect(errorCode(again)).toBe("rate_limited");

    // 同一个邀请码别人也能先请求验证码,谁先验证通过谁用掉
    const other = new Client();
    const r2 = await other.post<RequestCodeResponse>(requestCode.POST, { body: { email: "someone@example.com", inviteCode: invites[0] } });
    expect(r2.status).toBe(200);

    // 错误验证码 → 400 code_invalid
    const wrongCode = r.body.devCode === "000000" ? "111111" : "000000";
    const bad = await c.post(verify.POST, { body: { email: "player@example.com", code: wrongCode, inviteCode: invites[0] } });
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe("code_invalid");
    expect(c.cookie).toBeUndefined();

    // 正确验证码 → 消耗邀请码、建用户、设置 cookie
    const ok = await c.post<VerifyResponse>(verify.POST, { body: { email: "PLAYER@example.com", code: r.body.devCode, inviteCode: invites[0] } });
    expect(ok.status).toBe(200);
    expect(await store.getUserByEmail("player@example.com")).toMatchObject({ email: "player@example.com", consentAt: null });
    expect(await store.inviteAvailable(invites[0]!)).toBe(false);

    // 邀请码只能用一次:后验证的人 → 400 invite_invalid,不建用户;再请求验证码也不行
    const late = await other.post(verify.POST, { body: { email: "someone@example.com", code: r2.body.devCode, inviteCode: invites[0] } });
    expect(late.status).toBe(400);
    expect(errorCode(late)).toBe("invite_invalid");
    expect(await store.getUserByEmail("someone@example.com")).toBeNull();
    forgetCodeRequests();
    const reuse = await other.post(requestCode.POST, { body: { email: "someone@example.com", inviteCode: invites[0] } });
    expect(reuse.status).toBe(400);
    expect(errorCode(reuse)).toBe("invite_invalid");
    expect(ok.body.user).toMatchObject({ email: "player@example.com", isAdmin: false, consentAt: null });
    const setCookie = ok.res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^fde_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).not.toContain("Secure"); // 测试环境不是生产

    // 验证码用过即作废
    const replay = await new Client().post(verify.POST, { body: { email: "player@example.com", code: r.body.devCode } });
    expect(replay.status).toBe(400);
    expect(errorCode(replay)).toBe("code_invalid");
    player = c;
  });

  it("老用户再次登录不需要邀请码", async () => {
    forgetCodeRequests();
    const c = await login("player@example.com");
    const r = await c.get<MeResponse>(me.GET);
    expect(r.body.user.email).toBe("player@example.com");
  });

  it("库里只存验证码和 token 的哈希", () => {
    const raw = readFileSync(storeFile, "utf8");
    const token = player.cookie!.split("=")[1]!;
    expect(raw).not.toContain(token);
    const data = JSON.parse(raw) as { authTokens: Record<string, unknown> };
    for (const h of Object.keys(data.authTokens)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("未同意协议开局 → 403 consent_required;同意后可以开局", async () => {
    const r1 = await player.post(sessions.POST, { body: { scenarioId: "freight-docs" } });
    expect(r1.status).toBe(403);
    expect(errorCode(r1)).toBe("consent_required");

    const c = await player.post<MeResponse>(consent.POST);
    expect(c.status).toBe(200);
    expect(c.body.user.consentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await player.get<MeResponse>(me.GET)).body.user.consentAt).toBe(c.body.user.consentAt);

    const missing = await player.post(sessions.POST, { body: { scenarioId: "no-such-scenario" } });
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe("not_found");

    const bad = await player.post(sessions.POST, { body: {} });
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe("bad_request");

    const r2 = await player.post<CreateSessionResponse>(sessions.POST, { body: { scenarioId: "freight-docs" } });
    expect(r2.status).toBe(201);
    expect(r2.body.sessionId).toBeTruthy();
    expect(r2.body.view.sessionId).toBe(r2.body.sessionId);
    expect(r2.body.view.phase).toBe("kickoff");
    expect(r2.body.view.transcript).toHaveLength(1);
    expect(r2.body.view.aiNotice).toBe("对话内容由 AI 生成");
    sessionId = r2.body.sessionId;
  });

  it("说话:返回角色回复和新视图;视图里没有内部状态", async () => {
    const r = await player.post<TurnResponse>(turns.POST, { ...sid(sessionId), body: { text: "周总您好。为什么现在想做这件事?最近出过什么事吗?" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result.reply?.text).toBeTruthy();
    expect(r.body.result.reply?.roleName).toBeTruthy();
    expect(r.body.view.transcript.filter((l) => l.speaker === "user")).toHaveLength(1);
    const json = JSON.stringify(r.body);
    for (const secret of ["trust", "ledger", "directive", "guardFlags", "truth"]) expect(json).not.toContain(`"${secret}"`);

    const view = await player.get<SessionResponse>(session.GET, sid(sessionId));
    expect(view.status).toBe(200);
    expect(view.body.view.transcript).toEqual(r.body.view.transcript);

    const bad = await player.post(turns.POST, { ...sid(sessionId), body: { words: "x" } });
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe("bad_request");
    const missing = await player.post(turns.POST, { ...sid("no-such-session"), body: { text: "你好" } });
    expect(missing.status).toBe(404);
  });

  it("动作:换人到没出现的人失败;非法动作 400", async () => {
    const r = await player.post<TurnResponse>(actions.POST, { ...sid(sessionId), body: { type: "switch_role", role: "chen" } });
    expect(r.status).toBe(200);
    expect(r.body.result.ok).toBe(false);
    const bad = await player.post(actions.POST, { ...sid(sessionId), body: { type: "teleport" } });
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe("bad_request");
  });

  it("看资料:没拿到 403,不存在 404;拿到后能看、能下载;文件名穿越 404", async () => {
    const notYet = await player.get(artifact.GET, { params: { id: sessionId, aid: "A2" } });
    expect(notYet.status).toBe(403);
    expect(errorCode(notYet)).toBe("forbidden");
    const notYetFile = await player.get(artifactFile.GET, { params: { id: sessionId, aid: "A2", name: "exceptions_q3.xlsx" } });
    expect(notYetFile.status).toBe(403);
    const unknown = await player.get(artifact.GET, { params: { id: sessionId, aid: "ZZ" } });
    expect(unknown.status).toBe(404);

    // 模拟在对话里拿到了 A2(刘姐的异常登记表):直接改库里的状态
    const store = await getStore();
    const s = (await store.getSession(sessionId))!;
    s.state.artifacts.A2 = { obtainedTurn: s.state.turn };
    await store.saveSession(sessionId, s.state, s.version);

    const got = await player.get<ArtifactResponse>(artifact.GET, { params: { id: sessionId, aid: "A2" } });
    expect(got.status).toBe(200);
    expect(got.body.artifact).toMatchObject({ id: "A2", opened: false });
    const xlsx = join(ROOT, "scenarios/freight-docs/artifacts/A2/exceptions_q3.xlsx");
    expect(got.body.artifact.files).toEqual([{ name: "exceptions_q3.xlsx", kind: "xlsx", bytes: statSync(xlsx).size }]);
    expect(JSON.stringify(got.body)).not.toContain(ROOT); // 不暴露服务器路径

    const open = await player.post<TurnResponse>(actions.POST, { ...sid(sessionId), body: { type: "open_artifact", artifact: "A2" } });
    expect(open.status).toBe(200);
    expect(open.body.result.ok).toBe(true);
    expect(open.body.view.artifacts.find((a) => a.id === "A2")?.opened).toBe(true);

    const file = await player.get(artifactFile.GET, { params: { id: sessionId, aid: "A2", name: "exceptions_q3.xlsx" } });
    expect(file.status).toBe(200);
    expect(file.res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(file.res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(file.res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await file.res.arrayBuffer());
    expect(bytes.equals(readFileSync(xlsx))).toBe(true);

    for (const name of ["../../scenario.yaml", "..%2F..%2Fscenario.yaml", "../A4/loss_q3.xlsx", "exceptions_q3.xlsx/../../../scenario.yaml", "/etc/passwd", "", "."]) {
      const r = await player.get(artifactFile.GET, { params: { id: sessionId, aid: "A2", name } });
      expect(r.status, name).toBe(404);
      expect(errorCode(r)).toBe("not_found");
    }
    // 别的资料的文件也不能借道下载
    const other = await player.get(artifactFile.GET, { params: { id: sessionId, aid: "A4", name: "loss_q3.xlsx" } });
    expect(other.status).toBe(403);
  });

  it("别人的对局:看、说话、看资料、收工都被拒(403);管理员可以看", async () => {
    other = await login("other@example.com", invites[1]);
    await other.post(consent.POST);
    for (const [method, handler, opts] of [
      ["GET", session.GET, sid(sessionId)],
      ["POST", turns.POST, { ...sid(sessionId), body: { text: "你好" } }],
      ["POST", actions.POST, { ...sid(sessionId), body: { type: "end" } }],
      ["POST", finish.POST, sid(sessionId)],
      ["GET", artifact.GET, { params: { id: sessionId, aid: "A2" } }],
      ["GET", artifactFile.GET, { params: { id: sessionId, aid: "A2", name: "exceptions_q3.xlsx" } }],
      ["GET", report.GET, sid(sessionId)],
      ["POST", feedback.POST, { ...sid(sessionId), body: { rating: 1 } }],
    ] as const) {
      const r = await other.call(method, handler, opts);
      expect(r.status, `${method} ${JSON.stringify(opts)}`).toBe(403);
      expect(errorCode(r)).toBe("forbidden");
    }
    const asAdmin = await admin.get<SessionResponse>(session.GET, sid(sessionId));
    expect(asAdmin.status).toBe(200);
    const adminFile = await admin.get(artifactFile.GET, { params: { id: sessionId, aid: "A2", name: "exceptions_q3.xlsx" } });
    expect(adminFile.status).toBe(200);
    // 管理员也不能替别人说话
    const adminTurn = await admin.post(turns.POST, { ...sid(sessionId), body: { text: "你好" } });
    expect(adminTurn.status).toBe(403);
  });

  it("同一局并发两个请求:一个成功,一个 409 session_busy", async () => {
    const [a, b] = await Promise.all([
      player.post<TurnResponse>(turns.POST, { ...sid(sessionId), body: { text: "出错的记录在谁那儿?" } }),
      player.post<TurnResponse>(turns.POST, { ...sid(sessionId), body: { text: "能给我看看出错的单子吗?" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(errorCode(a.status === 409 ? a : b)).toBe("session_busy");
    // 锁已经释放,下一句正常
    const next = await player.post<TurnResponse>(turns.POST, { ...sid(sessionId), body: { text: "好的,谢谢周总。" } });
    expect(next.status).toBe(200);
    expect(next.body.view.transcript.filter((l) => l.speaker === "user")).toHaveLength(3);
  });

  it("还没收工:复盘 404", async () => {
    const r = await player.get(report.GET, sid(sessionId));
    expect(r.status).toBe(404);
    const fb = await player.post(feedback.POST, { ...sid(sessionId), body: { rating: 5 } });
    expect(fb.status).toBe(404);
  });

  it("结束后说话、做动作 → 409 session_ended", async () => {
    const end = await player.post<TurnResponse>(actions.POST, { ...sid(sessionId), body: { type: "end" } });
    expect(end.status).toBe(200);
    expect(end.body.view.ended).toBe(true);
    expect(end.body.view.phase).toBe("debrief");
    const stored = (await (await getStore()).getSession(sessionId))!;
    expect(stored.status).toBe("ended");
    expect(stored.endedAt).toBeTruthy();

    const t = await player.post(turns.POST, { ...sid(sessionId), body: { text: "再问一句" } });
    expect(t.status).toBe(409);
    expect(errorCode(t)).toBe("session_ended");
    const a = await player.post(actions.POST, { ...sid(sessionId), body: { type: "switch_role", role: "lin" } });
    expect(a.status).toBe(409);
    expect(errorCode(a)).toBe("session_ended");
  });

  it("收工出复盘,幂等;复盘能再取", async () => {
    const r1 = await player.post<FinishResponse>(finish.POST, sid(sessionId));
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.reportId).toBe(sessionId);
    expect(r1.body.report.sessionId).toBe(sessionId);
    expect(typeof r1.body.report.total).toBe("number");
    expect(r1.body.report.dimensions.length).toBeGreaterThan(0);
    expect(r1.body.report.markdown).toBeTruthy();
    expect(r1.body.report.shareCard.title).toBeTruthy();

    const r2 = await player.post<FinishResponse>(finish.POST, sid(sessionId));
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);

    const got = await player.get<ReportResponse>(report.GET, sid(sessionId));
    expect(got.status).toBe(200);
    expect(got.body.report).toEqual(r1.body.report);
    expect((await admin.get(report.GET, sid(sessionId))).status).toBe(200);

    const list = await player.get<SessionsResponse>(sessions.GET);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0]).toMatchObject({ id: sessionId, scenarioId: "freight-docs", phase: "debrief", total: r1.body.report.total });
    expect(list.body.sessions[0]!.endedAt).toBeTruthy();
  });

  it("反馈:至少一项、rating 0–10;推荐意愿和申诉都能提交", async () => {
    const empty = await player.post(feedback.POST, { ...sid(sessionId), body: {} });
    expect(empty.status).toBe(400);
    expect(errorCode(empty)).toBe("bad_request");
    const tooHigh = await player.post(feedback.POST, { ...sid(sessionId), body: { rating: 11 } });
    expect(tooHigh.status).toBe(400);
    const ok1 = await player.post(feedback.POST, { ...sid(sessionId), body: { rating: 9, text: "周总记账那段很真实" } });
    expect(ok1.status).toBe(201);
    const ok2 = await player.post(feedback.POST, { ...sid(sessionId), body: { dispute: { dimension: "D3", reason: "我问了很多量化问题" } } });
    expect(ok2.status).toBe(201);
    const fb = await (await getStore()).listFeedback({ sessionId });
    expect(fb).toHaveLength(2);
    expect(fb.find((f) => f.dispute)?.dispute).toEqual({ dimension: "D3", reason: "我问了很多量化问题" });
  });

  it("每天最多 3 局(UTC+8 自然日):第 4 局 429", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await player.post<CreateSessionResponse>(sessions.POST, { body: { scenarioId: "freight-docs" } });
      expect(r.status).toBe(201);
    }
    const fourth = await player.post(sessions.POST, { body: { scenarioId: "freight-docs" } });
    expect(fourth.status).toBe(429);
    expect(errorCode(fourth)).toBe("rate_limited");
    // 别人不受影响
    const r = await other.post<CreateSessionResponse>(sessions.POST, { body: { scenarioId: "freight-docs" } });
    expect(r.status).toBe(201);
    const list = await player.get<SessionsResponse>(sessions.GET);
    expect(list.body.sessions).toHaveLength(3);
    // 按开始时间倒序
    const started = list.body.sessions.map((s) => s.startedAt);
    expect([...started].sort().reverse()).toEqual(started);
  });

  it("UTC+8 自然日的起点", () => {
    expect(startOfDayUtc8(new Date("2026-10-05T15:59:59.000Z"))).toBe("2026-10-04T16:00:00.000Z");
    expect(startOfDayUtc8(new Date("2026-10-05T16:00:00.000Z"))).toBe("2026-10-05T16:00:00.000Z");
    expect(startOfDayUtc8(new Date("2026-10-05T03:00:00.000Z"))).toBe("2026-10-04T16:00:00.000Z");
  });

  it("管理接口:非管理员 403;管理员拿到统计、对局、详情、反馈", async () => {
    for (const [method, handler, opts] of [
      ["GET", adminStats.GET, {}],
      ["GET", adminSessions.GET, {}],
      ["GET", adminSession.GET, sid(sessionId)],
      ["GET", adminFeedback.GET, {}],
      ["POST", adminInvites.POST, { body: { count: 1 } }],
    ] as const) {
      const r = await player.call(method, handler, opts);
      expect(r.status).toBe(403);
      expect(errorCode(r)).toBe("forbidden");
    }

    const stats = await admin.get<AdminStats>(adminStats.GET);
    expect(stats.status).toBe(200);
    const fin = (await player.get<ReportResponse>(report.GET, sid(sessionId))).body.report;
    expect(stats.body).toMatchObject({
      users: 3,
      sessionsStarted: 4,
      sessionsFinished: 1,
      completionRate: 0.25,
      medianTotal: fin.total,
      disputeRate: 1,
      costYuanTotal: 0,
      costYuanPerSession: 0,
    });
    expect(typeof stats.body.medianMinutesUsed).toBe("number");
    expect(stats.body.scoreHistogram.map((b) => b.bucket)).toEqual(["0-9", "10-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70-79", "80-89", "90-100"]);
    expect(stats.body.scoreHistogram.reduce((n, b) => n + b.count, 0)).toBe(1);
    // 三局没收工,都停在第 0 轮
    expect(stats.body.dropOffByTurn).toEqual([{ turn: 0, count: 3 }]);

    const rows = await admin.get<AdminSessionsResponse>(adminSessions.GET, { path: "/api/admin/sessions?limit=50" });
    expect(rows.status).toBe(200);
    expect(rows.body.sessions).toHaveLength(4);
    const row = rows.body.sessions.find((s) => s.id === sessionId)!;
    // 说了 3 句(并发那次只成功一句)
    expect(row).toMatchObject({ userEmail: "player@example.com", turns: 3, costYuan: 0, total: fin.total });
    const page = await admin.get<AdminSessionsResponse>(adminSessions.GET, { path: "/api/admin/sessions?limit=2" });
    expect(page.body.sessions.map((s) => s.id)).toEqual(rows.body.sessions.slice(0, 2).map((s) => s.id));
    const boundary = page.body.sessions[1]!.startedAt;
    const rest = await admin.get<AdminSessionsResponse>(adminSessions.GET, { path: `/api/admin/sessions?before=${encodeURIComponent(boundary)}` });
    expect(rest.status).toBe(200);
    expect(rest.body.sessions.every((s) => s.startedAt < boundary)).toBe(true);
    expect(rest.body.sessions.map((s) => s.id)).toEqual(rows.body.sessions.filter((s) => s.startedAt < boundary).map((s) => s.id));
    const badLimit = await admin.get(adminSessions.GET, { path: "/api/admin/sessions?limit=abc" });
    expect(badLimit.status).toBe(400);

    const detail = await admin.get<AdminSessionDetail>(adminSession.GET, sid(sessionId));
    expect(detail.status).toBe(200);
    expect(detail.body.userEmail).toBe("player@example.com");
    expect(detail.body.events.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.body.ledger)).toBe(true);
    expect(detail.body.report?.total).toBe(fin.total);
    expect(detail.body.feedback).toHaveLength(2);
    expect(detail.body.llmCalls).toEqual([]);
    expect((await admin.get(adminSession.GET, sid("no-such-session"))).status).toBe(404);

    const fb = await admin.get<AdminFeedbackResponse>(adminFeedback.GET);
    expect(fb.status).toBe(200);
    expect(fb.body.feedback).toHaveLength(2);
    expect(fb.body.feedback.every((f) => f.userEmail === "player@example.com")).toBe(true);
  });

  it("删除本人数据:对局、复盘、反馈都删掉,账号和别人的对局不受影响", async () => {
    const r = await player.del<DeleteMyDataResponse>(myData.DELETE);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, deletedSessions: 3 });
    expect((await player.get<SessionsResponse>(sessions.GET)).body.sessions).toEqual([]);
    expect((await player.get(session.GET, sid(sessionId))).status).toBe(404);
    expect((await player.get(report.GET, sid(sessionId))).status).toBe(404);
    expect((await player.get<MeResponse>(me.GET)).status).toBe(200);
    expect((await other.get<SessionsResponse>(sessions.GET)).body.sessions).toHaveLength(1);
    const store = await getStore();
    expect(await store.listFeedback({ sessionId })).toEqual([]);
    const stats = await admin.get<AdminStats>(adminStats.GET);
    expect(stats.body).toMatchObject({ sessionsStarted: 1, sessionsFinished: 0, completionRate: 0, medianTotal: null, disputeRate: 0 });
  });

  it("退出登录:cookie 清掉,旧 token 失效", async () => {
    const oldCookie = other.cookie!;
    const r = await other.post(logout.POST);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("set-cookie")).toMatch(/^fde_session=;.*Max-Age=0/);
    expect(other.cookie).toBeUndefined();
    const stale = await new Client(oldCookie).get(me.GET);
    expect(stale.status).toBe(401);
  });

  it("内存库落盘:重启(重置单例)后数据还在", async () => {
    expect(existsSync(storeFile)).toBe(true);
    await resetForTests();
    const r = await admin.get<MeResponse>(me.GET);
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe(ADMIN);
    const list = await admin.get<AdminSessionsResponse>(adminSessions.GET);
    expect(list.body.sessions).toHaveLength(1);
  });
});
