// 浏览器端 HTTP 客户端。只走 /api/**,只用 `import type` 引用契约,不把引擎、store 的运行时打进浏览器包。
import type {
  ActionBody,
  ActionResponse,
  AdminFeedbackResponse,
  AdminSessionDetail,
  AdminSessionsResponse,
  AdminStats,
  AdminRedeemCodesResponse,
  AdminWaitlistResponse,
  ApiError,
  ClientEventType,
  CreateRedeemCodesBody,
  CreateRedeemCodesResponse,
  EntitlementsResponse,
  GatesResponse,
  InviteWaitlistBody,
  InviteWaitlistResponse,
  ProductsResponse,
  RedeemBody,
  RedeemResponse,
  WaitlistBody,
  WaitlistResponse,
  ArtifactResponse,
  CreateInvitesBody,
  CreateInvitesResponse,
  CreateSessionBody,
  CreateSessionResponse,
  DeleteMyDataResponse,
  ErrorCode,
  FeedbackBody,
  FinishResponse,
  MeResponse,
  ReportResponse,
  RequestCodeBody,
  RequestCodeResponse,
  ScenariosResponse,
  SessionResponse,
  SessionsResponse,
  SiteInfo,
  TurnBody,
  TurnResponse,
  VerifyBody,
  VerifyResponse,
} from "@fde/contracts";

/** 契约里的错误码,外加两种浏览器侧才有的:网络不通、响应不是 ApiError。 */
export type FailureCode = ErrorCode | "network" | "unknown";

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: FailureCode;
  constructor(status: number, code: FailureCode, message: string) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
  }
}

/** 服务端没给 message 时的兜底文案。 */
const FALLBACK: Record<FailureCode, string> = {
  bad_request: "请求内容不对,请检查后重试",
  invite_invalid: "邀请码无效或已经用完",
  code_invalid: "验证码不对或已经过期",
  unauthorized: "请先登录",
  consent_required: "开始之前需要先同意用户协议和隐私政策",
  forbidden: "没有权限",
  not_found: "没有找到",
  session_busy: "上一句还在处理,稍等一下再发",
  session_ended: "这一局已经结束了",
  rate_limited: "操作太频繁,稍后再试",
  internal: "服务器出错了,请稍后再试",
  entitlement_required: "这个场景需要先兑换相应的商品",
  redeem_invalid: "兑换码无效或已经被使用",
  network: "网络连接失败,请检查网络后重试",
  unknown: "出了点问题,请稍后再试",
};

/** 没有 ApiError 体时按状态码猜错误码。 */
function codeFromStatus(status: number): FailureCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "session_busy";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal";
  return "unknown";
}

function isApiError(x: unknown): x is ApiError {
  if (typeof x !== "object" || x === null || !("error" in x)) return false;
  const e = (x as { error: unknown }).error;
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string";
}

export function failureMessage(e: unknown): string {
  if (e instanceof ApiFailure) return e.message;
  return FALLBACK.unknown;
}

export function isFailure(e: unknown, ...codes: FailureCode[]): e is ApiFailure {
  return e instanceof ApiFailure && codes.includes(e.code);
}

type Method = "GET" | "POST" | "DELETE";

export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiFailure(0, "network", FALLBACK.network);
  }
  const raw = await res.text().catch(() => "");
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (isApiError(data)) {
      const code = (data.error.code in FALLBACK ? data.error.code : codeFromStatus(res.status)) as FailureCode;
      throw new ApiFailure(res.status, code, data.error.message || FALLBACK[code]);
    }
    const code = codeFromStatus(res.status);
    throw new ApiFailure(res.status, code, FALLBACK[code]);
  }
  return data as T;
}

const enc = encodeURIComponent;

/** 全部接口,与 spec 3.2 的路由表一一对应。 */
export const api = {
  site: () => request<SiteInfo>("GET", "/api/site"),
  scenarios: () => request<ScenariosResponse>("GET", "/api/scenarios"),

  requestCode: (b: RequestCodeBody) => request<RequestCodeResponse>("POST", "/api/auth/request-code", b),
  verify: (b: VerifyBody) => request<VerifyResponse>("POST", "/api/auth/verify", b),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),
  me: () => request<MeResponse>("GET", "/api/me"),
  consent: () => request<MeResponse>("POST", "/api/me/consent", {}),
  deleteMyData: () => request<DeleteMyDataResponse>("DELETE", "/api/me/data"),

  createSession: (b: CreateSessionBody) => request<CreateSessionResponse>("POST", "/api/sessions", b),
  sessions: () => request<SessionsResponse>("GET", "/api/sessions"),
  session: (id: string) => request<SessionResponse>("GET", `/api/sessions/${enc(id)}`),
  turn: (id: string, b: TurnBody) => request<TurnResponse>("POST", `/api/sessions/${enc(id)}/turns`, b),
  act: (id: string, b: ActionBody) => request<ActionResponse>("POST", `/api/sessions/${enc(id)}/actions`, b),
  finish: (id: string) => request<FinishResponse>("POST", `/api/sessions/${enc(id)}/finish`, {}),
  artifact: (id: string, aid: string) => request<ArtifactResponse>("GET", `/api/sessions/${enc(id)}/artifacts/${enc(aid)}`),

  report: (id: string) => request<ReportResponse>("GET", `/api/reports/${enc(id)}`),
  feedback: (id: string, b: FeedbackBody) => request<unknown>("POST", `/api/reports/${enc(id)}/feedback`, b),

  adminStats: () => request<AdminStats>("GET", "/api/admin/stats"),
  adminSessions: (q: { limit?: number; before?: string } = {}) => {
    const qs = new URLSearchParams();
    if (q.limit) qs.set("limit", String(q.limit));
    if (q.before) qs.set("before", q.before);
    const s = qs.toString();
    return request<AdminSessionsResponse>("GET", `/api/admin/sessions${s ? `?${s}` : ""}`);
  },
  adminSession: (id: string) => request<AdminSessionDetail>("GET", `/api/admin/sessions/${enc(id)}`),
  adminFeedback: () => request<AdminFeedbackResponse>("GET", "/api/admin/feedback"),
  createInvites: (b: CreateInvitesBody) => request<CreateInvitesResponse>("POST", "/api/admin/invites", b),

  // ---------------------------------------------------------------- 第三轮
  joinWaitlist: (b: WaitlistBody) => request<WaitlistResponse>("POST", "/api/waitlist", b),
  adminWaitlist: (status: "all" | "pending" | "invited" = "all") => request<AdminWaitlistResponse>("GET", `/api/admin/waitlist?status=${status}`),
  inviteWaitlist: (b: InviteWaitlistBody) => request<InviteWaitlistResponse>("POST", "/api/admin/waitlist/invite", b),

  adminGates: (range: { since?: string; until?: string } = {}) => {
    const qs = new URLSearchParams();
    if (range.since) qs.set("since", range.since);
    if (range.until) qs.set("until", range.until);
    const s = qs.toString();
    return request<GatesResponse>("GET", `/api/admin/gates${s ? `?${s}` : ""}`);
  },

  products: () => request<ProductsResponse>("GET", "/api/products"),
  entitlements: () => request<EntitlementsResponse>("GET", "/api/me/entitlements"),
  redeem: (b: RedeemBody) => request<RedeemResponse>("POST", "/api/redeem", b),
  adminRedeemCodes: (q: { productId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (q.productId) qs.set("productId", q.productId);
    if (q.limit) qs.set("limit", String(q.limit));
    const s = qs.toString();
    return request<AdminRedeemCodesResponse>("GET", `/api/admin/redeem-codes${s ? `?${s}` : ""}`);
  },
  createRedeemCodes: (b: CreateRedeemCodesBody) => request<CreateRedeemCodesResponse>("POST", "/api/admin/redeem-codes", b),
};

/** 候补名单 CSV 的下载地址(对应契约里的 ADMIN_WAITLIST_CSV_ROUTE)。 */
export const ADMIN_WAITLIST_CSV_URL = "/api/admin/waitlist.csv";

/**
 * 上报一条浏览器事件(第三轮,方案 6.3 的指标)。发出去就不管:不等响应、失败不报错、不影响页面。
 * 用 keepalive,页面跳转或关闭时也能发出去。
 */
export function track(type: ClientEventType, extra: { sessionId?: string; props?: Record<string, string | number | boolean> } = {}): void {
  try {
    void fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, ...extra }),
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 埋点失败不影响页面
  }
}

/** 资料文件本体的地址(对应契约里的 ARTIFACT_FILE_ROUTE)。 */
export function artifactFileUrl(sessionId: string, artifactId: string, name: string): string {
  return `/api/sessions/${enc(sessionId)}/artifacts/${enc(artifactId)}/files/${enc(name)}`;
}

/** 登录后回跳的站内路径;只接受以单个 "/" 开头的相对路径,防止开放重定向。 */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

export function loginHref(next: string): string {
  return `/login?next=${enc(next)}`;
}
