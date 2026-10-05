// HTTP 接口契约。第一轮(docs/dev-spec-2026-10-05.md)冻结;第三轮(docs/dev-spec-r3-2026-10-05.md)只增不改,
// 新增部分在各节末尾标了「第三轮」。前端只依赖这里和 @fde/engine 的 view 类型(仅类型,不引运行时)。
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
  // 第三轮
  /** 付费场景需要兑换相应的商品才能开局。 */
  entitlement_required: 403,
  /** 兑换码无效或已被使用。 */
  redeem_invalid: 400,
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
  // 第三轮
  /** 是否可以用手机号 + 短信验证码登录(配置了短信服务,或开发模式打开了 FDE_DEV_SMS_LOGIN)。 */
  smsLogin: boolean;
  /** 是否显示预售页入口(config/products.yaml 里有上架的商品)。 */
  presaleOpen: boolean;
}

// ---------------------------------------------------------------- 账号

export interface Me {
  id: string;
  /** 第三轮起:手机号注册的用户没有邮箱,为 null。 */
  email: string | null;
  /** 第三轮:手机号(+86 开头的 E.164 格式);邮箱注册的用户为 null。 */
  phone: string | null;
  isAdmin: boolean;
  /** 同意用户协议与隐私政策的时间;为 null 时不能开局。 */
  consentAt: string | null;
}

/**
 * POST /api/auth/request-code。新邮箱(或新手机号)必须带有效邀请码;老用户不用。
 * 评审修复:这一步只核对邀请码还能用,不消耗、不建用户;验证码校验通过(verify)时才消耗邀请码并建用户,
 * 输错邮箱不会白白用掉别人发来的一次性邀请码。
 * 第三轮:email 与 phone 必须且只能给一个;phone 只在 SiteInfo.smsLogin 为 true 时接受,否则 400。
 * phone 接受 11 位大陆手机号(可带 +86 / 86 前缀、空格和短横线),服务端统一成 "+86" 开头。
 */
export interface RequestCodeBody {
  email?: string;
  phone?: string;
  inviteCode?: string;
}
/** devCode 只在服务端设置 FDE_DEV_LOGIN_CODES=1 时返回(本地开发和测试用)。 */
export interface RequestCodeResponse {
  ok: true;
  devCode?: string;
}

/** POST /api/auth/verify。成功后设置 httpOnly cookie `fde_session`。 */
export interface VerifyBody {
  /** 第三轮:与 request-code 一样,email 与 phone 二选一。 */
  email?: string;
  phone?: string;
  code: string;
  /** 新用户必须带上请求验证码时用的邀请码(此时才消耗);老用户和 ADMIN_EMAILS 不用。用完了返回 400 invite_invalid。 */
  inviteCode?: string;
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
  /** 第三轮:free 人人可玩;paid 需要兑换包含该场景的商品(否则开局返回 403 entitlement_required)。 */
  access: "free" | "paid";
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

/** POST /api/reports/:id/feedback —— 推荐意愿、文字反馈、对某个维度的申诉、想不想玩下一个场景(至少填一项)。 */
export interface FeedbackBody {
  rating?: number; // 0–10
  text?: string;
  dispute?: { dimension: string; reason: string };
  /** 第三轮:"如果有下一个场景,你想玩吗?"(方案 6.3 第二关) */
  wantNext?: boolean;
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
  /** 邮箱;手机号注册的用户是手机号(第三轮)。 */
  userEmail: string;
  rating: number | null;
  text: string | null;
  dispute: { dimension: string; reason: string } | null;
  /** 第三轮 */
  wantNext: boolean | null;
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

// ================================================================ 第三轮新增

// ---------------------------------------------------------------- 候补名单(方案 5.2 W0「候补表单」、W5–W7「邀请/分批开放候补名单」)

export const WAITLIST_ROLES = ["fde", "career_switch", "student", "hiring", "other"] as const;
/** fde 在岗 FDE / 解决方案;career_switch 想转 FDE 的在职者;student 学生;hiring 招聘或培训负责人;other 其他。 */
export type WaitlistRole = (typeof WAITLIST_ROLES)[number];

/**
 * POST /api/waitlist —— 不需要登录。同一邮箱重复提交不报错(alreadyJoined: true,不改原来的登记时间)。
 * website 是给机器人的陷阱字段,页面上隐藏;非空时照样返回 201 但不入库。
 * 201 新登记;200 已经在名单里。
 */
export interface WaitlistBody {
  email: string;
  role?: WaitlistRole;
  /** 一句话:想用它做什么(≤ 500 字)。 */
  note?: string;
  /** 来源渠道,来自落地页链接的 ?from=(如 xhs、jike、wechat),≤ 32 字符,只允许字母数字 - _。 */
  source?: string;
  website?: string;
}
export interface WaitlistResponse {
  ok: true;
  alreadyJoined: boolean;
}

export interface WaitlistRow {
  email: string;
  role: WaitlistRole | null;
  note: string | null;
  source: string | null;
  createdAt: string;
  invitedAt: string | null;
  inviteCode: string | null;
  /** 这个邮箱已经注册(登录过)。 */
  registered: boolean;
}
/** GET /api/admin/waitlist?status=all|pending|invited —— 按登记时间从早到晚。 */
export interface AdminWaitlistResponse {
  total: number;
  invited: number;
  registered: number;
  bySource: { source: string; count: number }[];
  rows: WaitlistRow[];
}
/**
 * POST /api/admin/waitlist/invite —— 给候补名单发邀请码(每人一个、只能用一次),有 SMTP 就发邮件。
 * count:按登记时间取最早的 count 个还没邀请过的;emails:指定这些人(已邀请过的跳过)。二选一。
 */
export interface InviteWaitlistBody {
  count?: number;
  emails?: string[];
}
export interface InviteWaitlistResponse {
  invited: { email: string; inviteCode: string; mailed: boolean }[];
}
/** GET /api/admin/waitlist.csv —— 全部候补名单的 CSV(UTF-8 带 BOM,Excel 直接打开不乱码)。 */
export const ADMIN_WAITLIST_CSV_ROUTE = "/api/admin/waitlist.csv";

// ---------------------------------------------------------------- 埋点(方案 2.2「自建 events 表」、6.3 的指标)

/** 浏览器上报的事件类型(白名单)。 */
export const CLIENT_EVENT_TYPES = [
  "landing_viewed",
  "waitlist_viewed",
  "presale_viewed",
  "report_viewed",
  "share_card_saved",
  "share_text_copied",
] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** 服务端自己记的事件类型。 */
export const SERVER_EVENT_TYPES = [
  "login",
  "session_created",
  "turn",
  "action",
  "session_finished",
  "waitlist_joined",
  "code_redeemed",
] as const;
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
export type EventType = ClientEventType | ServerEventType;

/**
 * POST /api/events —— 不需要登录;登录了就带上用户。服务端给每个浏览器发一个匿名访客 cookie(fde_vid),
 * 用来把"第一次打开落地页"和"登录后说出第一句话"连起来。204 无响应体。
 * sessionId 只在属于当前用户时记录(否则丢弃这个字段)。props 最多 10 个键,值是短字符串、数字或布尔。
 */
export interface EventBody {
  type: ClientEventType;
  sessionId?: string;
  props?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------- 继续/转向/放弃的指标(方案 6.3)

/** insufficient:样本太少(分母 < 门槛配置里的 minSample),不下结论。 */
export type GateStatus = "pass" | "fix" | "fail" | "insufficient";

export interface GateMetric {
  id: string;
  label: string;
  /** 比例是 0–1 的小数;人数、分钟数是原值;算不出来为 null。 */
  value: number | null;
  /** 给人看的值,如 "42%"、"23 分钟"、"118 人"。 */
  display: string;
  numerator: number;
  denominator: number;
  status: GateStatus;
  /** 给人看的门槛,如 "过 ≥40% · 修 20–40% · 不过 <20%"。 */
  thresholds: string;
  /** 口径说明(分母是谁、怎么算)。 */
  note: string;
}

/**
 * GET /api/admin/gates?since=<ISO>&until=<ISO> —— 时间范围按开局时间(第一关按候补登记时间)筛选,都可省略。
 * gate1 兴趣、gate2 体验、gate3 付费;门槛来自 config/gates.yaml。
 */
export interface GatesResponse {
  range: { since: string | null; until: string | null };
  gate1: GateMetric[];
  gate2: GateMetric[];
  gate3: GateMetric[];
  /** 不在 6.3 里、但方案其他地方要看的数。 */
  extra: {
    /** 每轮说话的服务端耗时(毫秒)中位数与 P90(W1 验收:中位数 < 4 秒)。 */
    turnLatencyMsP50: number | null;
    turnLatencyMsP90: number | null;
    /** 新用户从第一次打开落地页到说出第一句话的秒数中位数(W4 验收:≤ 60 秒)。 */
    firstTurnSecondsP50: number | null;
    /** 参与计算的新用户数。 */
    firstTurnSample: number;
  };
}

// ---------------------------------------------------------------- 预售与兑换码(方案 5.2 W6–W7、7.3「站内只做兑换码核销,不放支付按钮」)

export interface ProductIncludes {
  /** 解锁的付费场景 id;"all" 表示全部场景。 */
  scenarios: string[] | "all";
  /** 每天多开的局数(加在 FDE_DAILY_SESSION_LIMIT 上)。 */
  extraDailySessions: number;
  /** 含一次真人复盘(兑换后在"我的"里显示预约方式)。 */
  humanReview: boolean;
}

export interface Product {
  id: string;
  name: string;
  /** 价格文字,如 "早鸟价 ¥399(原价 ¥699)"。站内不收款。 */
  priceText: string;
  /** Markdown。 */
  description: string;
  includes: ProductIncludes;
  /** 第三方平台的购买链接(有相应资质的平台);没有时显示 buyNote。 */
  buyUrl: string | null;
  /** 购买说明,如"加微信 xxx 转账后发兑换码"。 */
  buyNote: string | null;
  /** 是否在预售页上架。 */
  available: boolean;
}

/** GET /api/products —— 不需要登录。只返回 available 的商品;humanReviewHowTo 在这里永远是 null(预约方式只给兑换了的人,见 /api/me/entitlements)。 */
export interface ProductsResponse {
  products: Product[];
  /** 免费场景的 id。 */
  freeScenarios: string[];
  /** 真人复盘的预约方式(Markdown),兑换了含真人复盘的商品后显示。 */
  humanReviewHowTo: string | null;
}

export interface Entitlement {
  productId: string;
  productName: string;
  /** 兑换码(规范格式 XXXX-XXXX-XXXX)。 */
  code: string;
  redeemedAt: string;
  includes: ProductIncludes;
}

/** GET /api/me/entitlements —— 需要登录。 */
export interface EntitlementsResponse {
  entitlements: Entitlement[];
  /** 今天最多能开几局(基础限额 + 各商品的 extraDailySessions)。 */
  dailySessionLimit: number;
  /** 能玩的场景:免费的加上兑换解锁的;"all" 表示全部。 */
  scenarios: string[] | "all";
  humanReview: boolean;
  /** humanReview 为 true 时给出预约方式(Markdown),否则 null。 */
  humanReviewHowTo: string | null;
}

/**
 * POST /api/redeem —— 需要登录且已同意协议。兑换码不区分大小写,空格和短横线忽略。
 * 无效或已被别人使用 400 redeem_invalid;同一用户 1 小时内失败 10 次后 429 rate_limited。
 * 已经被自己兑换过的码(比如注册时用它代替了邀请码):照样 200,返回那条权益。
 */
export interface RedeemBody {
  code: string;
}
export interface RedeemResponse {
  entitlement: Entitlement;
  entitlements: EntitlementsResponse;
}

/** POST /api/admin/redeem-codes —— 生成兑换码(一次最多 500 个,每个只能用一次)。productId 必须是 config/products.yaml 里有的。 */
export interface CreateRedeemCodesBody {
  productId: string;
  count: number;
  note?: string;
}
export interface CreateRedeemCodesResponse {
  codes: string[];
}

export interface RedeemCodeRow {
  code: string;
  productId: string;
  note: string | null;
  createdAt: string;
  redeemedAt: string | null;
  /** 兑换人的邮箱或手机号。 */
  redeemedBy: string | null;
}
/** GET /api/admin/redeem-codes?productId=&limit= —— 新的在前。 */
export interface AdminRedeemCodesResponse {
  rows: RedeemCodeRow[];
  /** configured:还在 config/products.yaml 里(不在的只是库里有历史兑换码,不能再生成)。 */
  byProduct: { productId: string; productName: string; created: number; redeemed: number; configured: boolean }[];
}
