// 用 page.route 拦截 /api/**,按方法和路径返回 packages/contracts/fixtures/*.json。
// 需要状态变化的地方(说话后、换人后、提交判断后、收工后)由这里的小状态机依次返回不同 fixture。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page, Request, Route } from "@playwright/test";
import type {
  ActionBody,
  ActionResponse,
  ArtifactResponse,
  EntitlementsResponse,
  FeedbackBody,
  FinishResponse,
  Me,
  MeResponse,
  PublicView,
  SessionResponse,
  TurnResponse,
} from "@fde/contracts";

const require = createRequire(import.meta.url);

/** 读 fixture(通过 @fde/contracts 的包导出定位文件),每次返回一份新拷贝。 */
export function fixture<T>(name: string): T {
  const file = require.resolve(`@fde/contracts/fixtures/${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export const SESSION_ID = "s-fixture-0001";
export const DEV_CODE = "246810";
/** 第三轮:mock 里唯一能兑换成功的兑换码。 */
export const MOCK_REDEEM_CODE = "ABCD-EFGH-JKLM";

/** 1×1 的 PNG,资料图片请求用。 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export type Auth = "anon" | "pending" | "user" | "admin";

export interface MockOptions {
  /** anon 未登录;pending 已登录但没同意协议;user 普通用户;admin 管理员。 */
  auth?: Auth;
  /** 对局的初始视图;默认是刚开局(session-created)。 */
  view?: PublicView;
  /** 复盘是否已经生成(直接打开 /report/[id] 时用)。 */
  reportReady?: boolean;
  /** 说话请求的延迟,用来看"正在说话…"。 */
  turnDelayMs?: number;
  finishDelayMs?: number;
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
}
function apiError(route: Route, status: number, code: string, message: string) {
  return json(route, status, { error: { code, message } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockApi {
  auth: Auth;
  view: PublicView;
  reportReady: boolean;
  turnDelayMs: number;
  finishDelayMs: number;
  /** 下一次说话返回 409 session_busy。 */
  busyNext = false;
  /** 第几次说话(决定返回哪个 fixture)。 */
  turns = 0;
  calls: Call[] = [];
  feedback: FeedbackBody[] = [];
  /** 没匹配上任何路由的请求;测试结束时应该为空。 */
  unhandled: string[] = [];
  /** 可以替换资料响应(比如测试看图左右翻时多给几张图)。 */
  artifactOverride: ArtifactResponse | null = null;
  // ---- 第三轮
  /** 浏览器上报的事件(POST /api/events 的请求体)。 */
  events: unknown[] = [];
  /** GET /api/me/entitlements 的响应;兑换成功后换成 entitlements-sprint。 */
  entitlements: EntitlementsResponse = fixture<EntitlementsResponse>("entitlements-empty");

  constructor(opts: MockOptions = {}) {
    this.auth = opts.auth ?? "user";
    this.view = opts.view ?? fixture<{ view: PublicView }>("session-created").view;
    this.reportReady = opts.reportReady ?? false;
    this.turnDelayMs = opts.turnDelayMs ?? 0;
    this.finishDelayMs = opts.finishDelayMs ?? 0;
  }

  async install(page: Page) {
    await page.route("**/api/**", (route, request) => this.handle(route, request));
  }

  callsTo(method: string, pathRe: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && pathRe.test(c.path));
  }

  private me(): Me | null {
    if (this.auth === "anon") return null;
    const base = fixture<MeResponse>(this.auth === "admin" ? "me-admin" : "me").user;
    return this.auth === "pending" ? { ...base, consentAt: null } : base;
  }

  private async handle(route: Route, req: Request) {
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    this.calls.push({ method, path, body });

    const me = this.me();
    const needLogin = () => json(route, 401, fixture("error-unauthorized"));
    let m: RegExpMatchArray | null;

    // ---- 不需要登录
    if (method === "GET" && path === "/api/site") return json(route, 200, fixture("site"));
    if (method === "GET" && path === "/api/scenarios") return json(route, 200, fixture("scenarios"));
    // 第三轮
    if (method === "POST" && path === "/api/events") {
      this.events.push(body);
      return route.fulfill({ status: 204 });
    }
    if (method === "POST" && path === "/api/waitlist") return json(route, 201, { ok: true, alreadyJoined: false });
    if (method === "GET" && path === "/api/products") return json(route, 200, fixture("products"));
    if (method === "POST" && path === "/api/auth/request-code") {
      const b = body as { email?: string; inviteCode?: string };
      if (!b?.email) return apiError(route, 400, "bad_request", "邮箱不能为空");
      if (b.inviteCode !== undefined && b.inviteCode !== "FDE-INVITE") return apiError(route, 400, "invite_invalid", "邀请码无效");
      return json(route, 200, { ok: true, devCode: DEV_CODE });
    }
    if (method === "POST" && path === "/api/auth/verify") {
      const b = body as { email?: string; code?: string };
      if (b?.code !== DEV_CODE) return apiError(route, 400, "code_invalid", "验证码不对");
      if (this.auth === "anon") this.auth = "pending";
      return json(route, 200, { user: this.me() });
    }

    // ---- 需要登录
    if (!me) return needLogin();
    if (method === "POST" && path === "/api/auth/logout") {
      this.auth = "anon";
      return json(route, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/me") return json(route, 200, { user: me });
    if (method === "POST" && path === "/api/me/consent") {
      if (this.auth === "pending") this.auth = "user";
      return json(route, 200, { user: this.me() });
    }
    if (method === "DELETE" && path === "/api/me/data") return json(route, 200, { ok: true, deletedSessions: 2 });

    if (method === "GET" && path === "/api/sessions") return json(route, 200, fixture("sessions"));
    if (method === "POST" && path === "/api/sessions") {
      if (!me.consentAt) return apiError(route, 403, "consent_required", "请先同意用户协议和隐私政策");
      const created = fixture<{ sessionId: string; view: PublicView }>("session-created");
      this.view = created.view;
      return json(route, 201, created);
    }

    if ((m = path.match(/^\/api\/sessions\/([^/]+)$/)) && method === "GET") {
      if (decodeURIComponent(m[1]!) !== this.view.sessionId) return apiError(route, 404, "not_found", "没有这一局");
      return json(route, 200, { view: this.view } satisfies SessionResponse);
    }
    if (path.match(/^\/api\/sessions\/[^/]+\/turns$/) && method === "POST") return this.turn(route, body as { text: string });
    if (path.match(/^\/api\/sessions\/[^/]+\/actions$/) && method === "POST") return this.action(route, body as ActionBody);
    if (path.match(/^\/api\/sessions\/[^/]+\/finish$/) && method === "POST") {
      if (this.finishDelayMs) await sleep(this.finishDelayMs);
      this.reportReady = true;
      return json(route, 200, fixture("finish-response"));
    }
    if ((m = path.match(/^\/api\/sessions\/[^/]+\/artifacts\/([^/]+)\/files\/([^/]+)$/)) && method === "GET") {
      const name = decodeURIComponent(m[2]!);
      if (/\.(png|jpe?g|webp)$/i.test(name)) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
      if (/\.pdf$/i.test(name)) return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4\n%%EOF\n" });
      return route.fulfill({
        status: 200,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers: { "content-disposition": `attachment; filename="${encodeURIComponent(name)}"` },
        body: "PK",
      });
    }
    if ((m = path.match(/^\/api\/sessions\/[^/]+\/artifacts\/([^/]+)$/)) && method === "GET") {
      const aid = decodeURIComponent(m[1]!);
      if (!this.view.artifacts.some((a) => a.id === aid)) return apiError(route, 403, "forbidden", "还没有拿到这份资料");
      if (this.artifactOverride) return json(route, 200, this.artifactOverride);
      if (aid === "A1") return json(route, 200, fixture("artifact-A1"));
      const a = this.view.artifacts.find((x) => x.id === aid)!;
      return json(route, 200, { artifact: { id: aid, title: a.title, opened: true, files: [{ name: `${aid}_screen.png`, kind: "image", bytes: 120_000 }] } });
    }

    if ((m = path.match(/^\/api\/reports\/([^/]+)$/)) && method === "GET") {
      if (!this.reportReady) return apiError(route, 404, "not_found", "还没有复盘");
      return json(route, 200, { report: fixture<FinishResponse>("finish-response").report });
    }
    if (path.match(/^\/api\/reports\/[^/]+\/feedback$/) && method === "POST") {
      this.feedback.push(body as FeedbackBody);
      return json(route, 200, { ok: true });
    }

    // 第三轮:兑换(MOCK_REDEEM_CODE 能兑,其他都无效)
    if (method === "GET" && path === "/api/me/entitlements") return json(route, 200, this.entitlements);
    if (method === "POST" && path === "/api/redeem") {
      const code = String((body as { code?: string })?.code ?? "")
        .toUpperCase()
        .replace(/[\s-]/g, "");
      if (code !== MOCK_REDEEM_CODE.replace(/-/g, "")) return apiError(route, 400, "redeem_invalid", "兑换码无效或已经被使用");
      this.entitlements = fixture<EntitlementsResponse>("entitlements-sprint");
      return json(route, 200, { entitlement: this.entitlements.entitlements[0], entitlements: this.entitlements });
    }

    // ---- 管理接口
    if (path.startsWith("/api/admin/")) {
      if (!me.isAdmin) return apiError(route, 403, "forbidden", "没有权限");
      // 第三轮
      if (method === "GET" && path === "/api/admin/waitlist") return json(route, 200, fixture("admin-waitlist"));
      if (method === "POST" && path === "/api/admin/waitlist/invite") {
        const b = body as { count?: number; emails?: string[] };
        const emails = b?.emails ?? ["second@example.com", "third@example.com"].slice(0, Math.max(1, b?.count ?? 1));
        return json(route, 200, { invited: emails.map((email, i) => ({ email, inviteCode: `WAIT${String(i + 2).padStart(4, "2")}`, mailed: false })) });
      }
      if (method === "GET" && path === "/api/admin/gates") return json(route, 200, fixture("admin-gates"));
      if (method === "GET" && path === "/api/admin/redeem-codes") return json(route, 200, fixture("admin-redeem-codes"));
      if (method === "POST" && path === "/api/admin/redeem-codes") {
        const n = Math.max(1, Math.min(50, Number((body as { count?: number })?.count ?? 1)));
        return json(route, 200, { codes: Array.from({ length: n }, (_, i) => `MOCK-CODE-${String(i + 1).padStart(4, "2")}`) });
      }
      if (method === "GET" && path === "/api/admin/stats") return json(route, 200, fixture("admin-stats"));
      if (method === "GET" && path === "/api/admin/sessions") return json(route, 200, fixture("admin-sessions"));
      if (method === "GET" && path.match(/^\/api\/admin\/sessions\/[^/]+$/)) return json(route, 200, fixture("admin-session-detail"));
      if (method === "GET" && path === "/api/admin/feedback") return json(route, 200, fixture("admin-feedback"));
      if (method === "POST" && path === "/api/admin/invites") {
        const n = Math.max(1, Math.min(100, Number((body as { count?: number })?.count ?? 1)));
        return json(route, 200, { codes: Array.from({ length: n }, (_, i) => `FDE-${String(i + 1).padStart(4, "0")}`) });
      }
    }

    this.unhandled.push(`${method} ${path}`);
    return apiError(route, 404, "not_found", "mock 没有这个接口");
  }

  /** 说话:第 1 句 → turn-response;第 2 句 → turn-artifact-response(小林给样本包);之后按当前视图拼一条回复。 */
  private async turn(route: Route, body: { text: string }) {
    if (this.view.ended) return apiError(route, 409, "session_ended", "这一局已经结束");
    if (this.turnDelayMs) await sleep(this.turnDelayMs);
    if (this.busyNext) {
      this.busyNext = false;
      return apiError(route, 409, "session_busy", "上一句还在处理");
    }
    this.turns += 1;
    let resp: TurnResponse;
    if (this.turns === 1) resp = fixture<TurnResponse>("turn-response");
    else if (this.turns === 2) resp = fixture<TurnResponse>("turn-artifact-response");
    else resp = this.synthTurn(body.text);
    this.view = resp.view;
    return json(route, 200, resp);
  }

  private synthTurn(text: string): TurnResponse {
    const v = structuredClone(this.view);
    const role = v.people.find((p) => p.current) ?? v.people[0]!;
    const turn = Math.max(0, ...v.transcript.map((l) => l.turn)) + 1;
    const nU = v.transcript.filter((l) => l.speaker === "user").length + 1;
    const nN = v.transcript.filter((l) => l.speaker === "npc").length + 1;
    const reply = { roleId: role.id, roleName: role.name, text: "这个我得想想。", ref: `N${nN}` };
    v.transcript.push({ ref: `U${nU}`, turn, speaker: "user", roleId: role.id, roleName: role.name, text });
    v.transcript.push({ ref: reply.ref, turn, speaker: "npc", roleId: role.id, roleName: role.name, text: reply.text });
    v.minutesLeft = Math.max(0, v.minutesLeft - 8);
    role.exchanges += 1;
    return { result: { system: [], unlockedArtifacts: [], discovered: [], reply }, view: v };
  }

  /** 按钮动作:换到小林、看样本包、去现场、提交判断、收工都有现成 fixture;其他的拼一个。 */
  private action(route: Route, a: ActionBody) {
    if (this.view.ended) return apiError(route, 409, "session_ended", "这一局已经结束");
    let resp: ActionResponse;
    switch (a.type) {
      case "switch_role":
        resp = a.role === "lin" ? fixture("action-switch-response") : this.synthSystem(`你去找了${a.role}。`, (v) => {
          for (const p of v.people) p.current = p.id === a.role;
          v.currentRole = a.role;
        });
        break;
      case "open_artifact":
        resp = a.artifact === "A1" ? fixture("action-open-response") : this.synthSystem(`你花了 15 分钟看「${a.artifact}」。`, (v) => {
          const art = v.artifacts.find((x) => x.id === a.artifact);
          if (art) art.opened = true;
        });
        break;
      case "action":
        resp = fixture("action-visit-response");
        break;
      case "experiment":
        resp = this.synthSystem(`你花了 45 分钟做「${a.experiment}」。结果:(mock)`, (v) => {
          const x = v.experiments.find((e) => e.id === a.experiment);
          if (x) x.done = true;
        });
        break;
      case "submit_judgment":
        resp = fixture("action-judgment-response");
        break;
      case "end": {
        const ended = fixture<SessionResponse>("view-ended");
        resp = { result: { system: ["你收工了。"], unlockedArtifacts: [], discovered: [], ok: true }, view: ended.view };
        break;
      }
    }
    this.view = resp.view;
    return json(route, 200, resp);
  }

  private synthSystem(text: string, mutate: (v: PublicView) => void): ActionResponse {
    const v = structuredClone(this.view);
    mutate(v);
    const n = v.transcript.filter((l) => l.speaker === "system").length + 1;
    const turn = Math.max(0, ...v.transcript.map((l) => l.turn));
    v.transcript.push({ ref: `S${n}`, turn, speaker: "system", text });
    return { result: { system: [text], unlockedArtifacts: [], discovered: [], ok: true }, view: v };
  }
}
