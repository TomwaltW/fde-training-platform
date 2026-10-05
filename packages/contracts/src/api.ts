// HTTP 接口契约(本轮冻结)。前端只依赖这里和 @fde/engine 的 view 类型(仅类型,不引运行时)。
// 所有接口:请求和响应都是 JSON(资料文件下载除外);出错时返回 ApiError + 对应 HTTP 状态码。
import type { PublicArtifact, PublicReport, PublicTurnResult, PublicView, SessionEvent, LedgerEntry, UserAction } from "@fde/engine";

export type { PublicArtifact, PublicReport, PublicTurnResult, PublicView, UserAction };

// ---------------------------------------------------------------- 错误

export const ERROR_STATUS = {
  bad_request: 400,
  invite_invalid: 400,
  code_invalid: 400,
  unauthorized: 401,
  consent_required: 403,
  forbidden: 403,
  not_found: 404,
  session_busy: 409,
  session_ended: 409,
  rate_limited: 429,
  internal: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiError {
  error: { code: ErrorCode; message: string };
}

// ---------------------------------------------------------------- 站点信息(页脚公示)

/** GET /api/site —— 不需要登录。 */
export interface SiteInfo {
  /** "对话内容由 AI 生成" */
  aiNotice: string;
  /** 公示所用模型名称和备案号,例如 "通义千问 qwen-plus(备案号 xxx);DeepSeek(备案号 xxx)";未配置时为 null。 */
  modelDisclosure: string | null;
  /** ICP 备案号,例如 "浙ICP备xxxx号";未配置时为 null。 */
  icpNumber: string | null;
  /** 公安联网备案号;未配置时为 null。 */
  publicSecurityNumber: string | null;
  /** 是否开放注册(需要邀请码)。 */
  inviteOnly: boolean;
}

// ---------------------------------------------------------------- 账号

export interface Me {
  id: string;
  email: string;
  isAdmin: boolean;
  /** 同意用户协议与隐私政策的时间;为 null 时不能开局。 */
  consentAt: string | null;
}

/** POST /api/auth/request-code。新邮箱必须带有效邀请码;老用户不用。 */
export interface RequestCodeBody {
  email: string;
  inviteCode?: string;
}
/** devCode 只在服务端设置 FDE_DEV_LOGIN_CODES=1 时返回(本地开发和测试用)。 */
export interface RequestCodeResponse {
  ok: true;
  devCode?: string;
}

/** POST /api/auth/verify。成功后设置 httpOnly cookie `fde_session`。 */
export interface VerifyBody {
  email: string;
  code: string;
}
export interface VerifyResponse {
  user: Me;
}

/** POST /api/auth/logout → { ok: true } */
/** GET /api/me → MeResponse;未登录 401 unauthorized。 */
export interface MeResponse {
  user: Me;
}
/** POST /api/me/consent → MeResponse(consentAt 已填)。 */
/** DELETE /api/me/data → 删除本人所有对局与复盘。 */
export interface DeleteMyDataResponse {
  ok: true;
  deletedSessions: number;
}

// ---------------------------------------------------------------- 场景与对局

/** GET /api/scenarios —— 不需要登录。 */
export interface ScenarioSummary {
  id: string;
  title: string;
  difficulty: number;
  estMinutes: number;
  skillFocus: string[];
  disclaimer: string;
  opening: { speakerName: string; speakerTitle: string; text: string };
}
export interface ScenariosResponse {
  scenarios: ScenarioSummary[];
}

/** POST /api/sessions。需要登录且已同意协议;每人每天最多 FDE_DAILY_SESSION_LIMIT(默认 3)局。 */
export interface CreateSessionBody {
  scenarioId: string;
}
/** 201 */
export interface CreateSessionResponse {
  sessionId: string;
  view: PublicView;
}

export interface SessionSummary {
  id: string;
  scenarioId: string;
  title: string;
  phase: PublicView["phase"];
  startedAt: string;
  endedAt: string | null;
  /** 收工并出了复盘才有。 */
  total: number | null;
}
/** GET /api/sessions —— 本人的对局,按开始时间倒序。 */
export interface SessionsResponse {
  sessions: SessionSummary[];
}

/** GET /api/sessions/:id(本人或管理员)。 */
export interface SessionResponse {
  view: PublicView;
}

/** POST /api/sessions/:id/turns。同一对局同一时刻只处理一个请求,并发的返回 409 session_busy。 */
export interface TurnBody {
  text: string;
}
export interface TurnResponse {
  result: PublicTurnResult;
  view: PublicView;
}

/** POST /api/sessions/:id/actions,body 就是 engine 的 UserAction(end 也走这里)。 */
export type ActionBody = UserAction;
export type ActionResponse = TurnResponse;

/**
 * POST /api/sessions/:id/finish —— 收工并生成复盘(裁判 → 算分 → 复盘,可能要几十秒)。
 * 幂等:已经出过复盘的直接返回。reportId 与 sessionId 相同。
 */
export interface FinishResponse {
  reportId: string;
  report: PublicReport;
}

/** GET /api/sessions/:id/artifacts/:aid —— 只能看已经拿到的资料,否则 403 forbidden。 */
export interface ArtifactResponse {
  artifact: PublicArtifact;
}
/**
 * GET /api/sessions/:id/artifacts/:aid/files/:name —— 文件本体(Content-Type 按扩展名,
 * 图片 inline,xlsx 作为附件下载)。没拿到资料 403;文件不存在 404。
 */
export const ARTIFACT_FILE_ROUTE = "/api/sessions/:id/artifacts/:aid/files/:name";

/** GET /api/reports/:id(本人或管理员;还没出复盘 404)。 */
export interface ReportResponse {
  report: PublicReport;
}

/** POST /api/reports/:id/feedback —— 推荐意愿、文字反馈、对某个维度的申诉(至少填一项)。 */
export interface FeedbackBody {
  rating?: number; // 0–10
  text?: string;
  dispute?: { dimension: string; reason: string };
}

// ---------------------------------------------------------------- 管理(ADMIN_EMAILS 里的邮箱)

export interface AdminStats {
  users: number;
  sessionsStarted: number;
  sessionsFinished: number;
  /** 出了复盘的 / 开局的 */
  completionRate: number;
  /** 出了复盘的对局,用掉的模拟分钟数中位数 */
  medianMinutesUsed: number | null;
  medianTotal: number | null;
  /** 有申诉的复盘 / 出了复盘的 */
  disputeRate: number;
  costYuanTotal: number;
  costYuanPerSession: number | null;
  /** 总分分布,每 10 分一档:"0-9" … "90-100" */
  scoreHistogram: { bucket: string; count: number }[];
  /** 没收工的对局停在第几轮 */
  dropOffByTurn: { turn: number; count: number }[];
}

export interface AdminSessionRow extends SessionSummary {
  userEmail: string;
  turns: number;
  costYuan: number;
}
/** GET /api/admin/sessions?limit=50&before=<startedAt ISO> */
export interface AdminSessionsResponse {
  sessions: AdminSessionRow[];
}

export interface FeedbackRow {
  sessionId: string;
  userEmail: string;
  rating: number | null;
  text: string | null;
  dispute: { dimension: string; reason: string } | null;
  createdAt: string;
}

/** GET /api/admin/sessions/:id —— 作者看全部内部状态(真相、事件、账本、模型调用)。 */
export interface AdminSessionDetail {
  view: PublicView;
  userEmail: string;
  events: SessionEvent[];
  ledger: LedgerEntry[];
  report: PublicReport | null;
  feedback: FeedbackRow[];
  llmCalls: { at: string; stage: string; model: string; tokensIn: number; tokensOut: number; costYuan: number | null; latencyMs: number; ok: boolean }[];
}

/** POST /api/admin/invites */
export interface CreateInvitesBody {
  count: number;
  maxUses?: number; // 默认 1
  note?: string;
}
export interface CreateInvitesResponse {
  codes: string[];
}

/** GET /api/admin/feedback */
export interface AdminFeedbackResponse {
  feedback: FeedbackRow[];
}
