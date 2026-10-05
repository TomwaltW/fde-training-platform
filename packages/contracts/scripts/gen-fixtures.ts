// 用真引擎(离线模式)跑一小段,生成前端测试用的接口响应样例。契约变了就重跑:
//   pnpm exec tsx packages/contracts/scripts/gen-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Engine,
  FixtureJudge,
  QueueGate,
  TemplateActor,
  TemplateDebrief,
  emptyJudge,
  gateOutput,
  loadScenario,
  publicArtifact,
  publicReport,
  publicTurnResult,
  publicView,
  type GateOutput,
} from "@fde/engine";
import type {
  AdminFeedbackResponse,
  AdminRedeemCodesResponse,
  AdminWaitlistResponse,
  EntitlementsResponse,
  GatesResponse,
  ProductsResponse,
  AdminSessionDetail,
  AdminSessionsResponse,
  AdminStats,
  ArtifactResponse,
  CreateSessionResponse,
  FinishResponse,
  MeResponse,
  ScenariosResponse,
  SessionsResponse,
  SiteInfo,
  TurnResponse,
} from "../src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
const out = resolve(import.meta.dirname, "../fixtures");
mkdirSync(out, { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(resolve(out, name), `${JSON.stringify(data, null, 2)}\n`);

const scn = loadScenario(resolve(root, "scenarios/freight-docs"));
const gate = new QueueGate();
const engine = new Engine(scn, { gate, actor: new TemplateActor(), judge: new FixtureJudge(() => emptyJudge(scn)), debrief: new TemplateDebrief() });
const st = engine.start("s-fixture-0001");
st.transcript.forEach((l) => (l.turn = 0));
const t = (...ids: string[]) => ids.map((id) => ({ id, confidence: 0.9 }));
const say = async (text: string, g: Partial<GateOutput>) => {
  gate.push(gateOutput(g));
  const r = await engine.userTurn(st, text);
  gate.clear();
  return r;
};

const T0 = "2026-10-05T08:00:00.000Z";
write("site.json", {
  aiNotice: "对话内容由 AI 生成",
  modelDisclosure: "通义千问 qwen-plus(备案号:待填写);DeepSeek(备案号:待填写)",
  icpNumber: null,
  publicSecurityNumber: null,
  inviteOnly: true,
  smsLogin: false,
  presaleOpen: false,
} satisfies SiteInfo);
write("me.json", { user: { id: "u-fixture-1", email: "player@example.com", phone: null, isAdmin: false, consentAt: T0 } } satisfies MeResponse);
write("me-admin.json", { user: { id: "u-fixture-2", email: "author@example.com", phone: null, isAdmin: true, consentAt: T0 } } satisfies MeResponse);
write("scenarios.json", {
  scenarios: [
    {
      id: scn.data.meta.id,
      title: scn.data.meta.title,
      access: "free",
      difficulty: scn.data.meta.difficulty,
      estMinutes: scn.data.meta.est_minutes,
      skillFocus: scn.data.meta.skill_focus,
      disclaimer: scn.data.meta.disclaimer,
      opening: {
        speakerName: scn.role(scn.data.briefing.opening.speaker).name,
        speakerTitle: scn.role(scn.data.briefing.opening.speaker).title,
        text: scn.data.briefing.opening.text,
      },
    },
  ],
} satisfies ScenariosResponse);

write("session-created.json", { sessionId: st.sessionId, view: publicView(scn, st) } satisfies CreateSessionResponse);

const r1 = await say("周总您好。为什么现在想做这件事?最近出过什么事吗?", { matched_triggers: t("S2@zhou:L2"), question_tags: { open: true, quantifying: false, follow_up: false, leading: false, bundled_count: 1, evidence_ask: false } });
write("turn-response.json", { result: publicTurnResult(scn, r1), view: publicView(scn, st) } satisfies TurnResponse);
await say("能跟操作部打个招呼吗?出错的记录在谁那儿?", { acts: ["ask", "request_permission"], matched_triggers: t("perm:auth_ops", "P1@liu:L3") });
const sw = await engine.act(st, { type: "switch_role", role: "lin" });
write("action-switch-response.json", { result: publicTurnResult(scn, sw), view: publicView(scn, st) } satisfies TurnResponse);
const r3 = await say("小林你好,周总说样本单据在你这儿,能给我看看吗?", { acts: ["ask", "request_artifact"], matched_triggers: t("A1@lin:L3") });
write("turn-artifact-response.json", { result: publicTurnResult(scn, r3), view: publicView(scn, st) } satisfies TurnResponse);
const op = await engine.act(st, { type: "open_artifact", artifact: "A1" });
write("action-open-response.json", { result: publicTurnResult(scn, op), view: publicView(scn, st) } satisfies TurnResponse);
const art = publicArtifact(scn, st, "A1")!;
{
  // 前端 mock 测试固定用一组三种类型各一个的示例文件(不随真实单据变化);真实的 14 份文件由真后端 e2e 覆盖
  art.files = [
    { name: "01_invoice_LT2609-0387.pdf", kind: "pdf", bytes: 48213 },
    { name: "02_packing_LT2609-0387.jpg", kind: "image", bytes: 412877 },
    { name: "03_import_template.xlsx", kind: "xlsx", bytes: 9120 },
  ];
}
write("artifact-A1.json", { artifact: art } satisfies ArtifactResponse);
const visit = await engine.act(st, { type: "action", action: "site_visit" });
write("action-visit-response.json", { result: publicTurnResult(scn, visit), view: publicView(scn, st) } satisfies TurnResponse);

const judged = await engine.act(st, {
  type: "submit_judgment",
  form: { J1: "主因是单据之间不一致和改单没同步", J2: "样本包、现场观察", J3: "大会能演示", J4: "两周小验证", J5: "损失金额" },
});
write("action-judgment-response.json", { result: publicTurnResult(scn, judged), view: publicView(scn, st) } satisfies TurnResponse);
const rep = await engine.finish(st);
const report = publicReport(scn, st.sessionId, rep);
write("finish-response.json", { reportId: st.sessionId, report } satisfies FinishResponse);
write("view-ended.json", { view: publicView(scn, st) });

write("sessions.json", {
  sessions: [
    { id: st.sessionId, scenarioId: scn.data.meta.id, title: scn.data.meta.title, phase: "debrief", startedAt: T0, endedAt: "2026-10-05T08:31:00.000Z", total: report.total },
    { id: "s-fixture-0002", scenarioId: scn.data.meta.id, title: scn.data.meta.title, phase: "discovery", startedAt: "2026-10-05T09:00:00.000Z", endedAt: null, total: null },
  ],
} satisfies SessionsResponse);
write("admin-stats.json", {
  users: 12,
  sessionsStarted: 20,
  sessionsFinished: 9,
  completionRate: 0.45,
  medianMinutesUsed: 284,
  medianTotal: 58,
  disputeRate: 0.11,
  costYuanTotal: 7.42,
  costYuanPerSession: 0.37,
  scoreHistogram: ["0-9", "10-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70-79", "80-89", "90-100"].map((bucket, i) => ({ bucket, count: [1, 0, 1, 1, 2, 1, 1, 1, 1, 0][i]! })),
  dropOffByTurn: [
    { turn: 1, count: 2 },
    { turn: 3, count: 4 },
    { turn: 9, count: 3 },
    { turn: 15, count: 2 },
  ],
} satisfies AdminStats);
write("admin-sessions.json", {
  sessions: [{ id: st.sessionId, scenarioId: scn.data.meta.id, title: scn.data.meta.title, phase: "debrief", startedAt: T0, endedAt: "2026-10-05T08:31:00.000Z", total: report.total, userEmail: "player@example.com", turns: st.turn, costYuan: 0.31 }],
} satisfies AdminSessionsResponse);
const fb = { sessionId: st.sessionId, userEmail: "player@example.com", rating: 8, text: "周总记账那段很真实", dispute: { dimension: "D3", reason: "我问了很多量化问题" }, wantNext: true, createdAt: "2026-10-05T08:35:00.000Z" };
write("admin-feedback.json", { feedback: [fb] } satisfies AdminFeedbackResponse);
write("admin-session-detail.json", {
  view: publicView(scn, st),
  userEmail: "player@example.com",
  events: st.events,
  ledger: st.ledger,
  report,
  feedback: [fb],
  llmCalls: [{ at: T0, stage: "actor", model: "qwen-plus", tokensIn: 3012, tokensOut: 96, costYuan: 0.0026, latencyMs: 1830, ok: true }],
} satisfies AdminSessionDetail);
// ---------------------------------------------------------------- 第三轮
const sprintIncludes = { scenarios: "all" as const, extraDailySessions: 5, humanReview: true };
write("products.json", {
  products: [
    {
      id: "sprint",
      name: "求职冲刺包",
      priceText: "早鸟价 ¥399(原价 ¥699)",
      description: "全部场景,外加一次 30 分钟真人复盘。",
      includes: sprintIncludes,
      buyUrl: null,
      buyNote: "加微信 fde-sim(备注「冲刺包」),转账后发兑换码。",
      available: true,
    },
  ],
  freeScenarios: [scn.data.meta.id],
  humanReviewHowTo: "兑换后加微信 fde-sim,发送兑换码预约时间。",
} satisfies ProductsResponse);
write("entitlements-empty.json", {
  entitlements: [],
  dailySessionLimit: 3,
  scenarios: [scn.data.meta.id],
  humanReview: false,
  humanReviewHowTo: null,
} satisfies EntitlementsResponse);
write("entitlements-sprint.json", {
  entitlements: [{ productId: "sprint", productName: "求职冲刺包", code: "ABCD-EFGH-JKLM", redeemedAt: "2026-10-05T09:10:00.000Z", includes: sprintIncludes }],
  dailySessionLimit: 8,
  scenarios: "all",
  humanReview: true,
  humanReviewHowTo: "兑换后加微信 fde-sim,发送兑换码预约时间。",
} satisfies EntitlementsResponse);
write("admin-waitlist.json", {
  total: 3,
  invited: 1,
  registered: 1,
  bySource: [
    { source: "xhs", count: 2 },
    { source: "(直接访问)", count: 1 },
  ],
  rows: [
    { email: "early@example.com", role: "career_switch", note: "想转 FDE,练练访谈", source: "xhs", createdAt: "2026-10-05T07:00:00.000Z", invitedAt: "2026-10-05T07:30:00.000Z", inviteCode: "QWER2345", registered: true },
    { email: "second@example.com", role: "fde", note: null, source: "xhs", createdAt: "2026-10-05T07:10:00.000Z", invitedAt: null, inviteCode: null, registered: false },
    { email: "third@example.com", role: null, note: null, source: null, createdAt: "2026-10-05T07:20:00.000Z", invitedAt: null, inviteCode: null, registered: false },
  ],
} satisfies AdminWaitlistResponse);
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
write("admin-gates.json", {
  range: { since: null, until: null },
  gate1: [
    { id: "waitlist_7d", label: "首条内容 7 天内的候补名单人数", value: 118, display: "118 人", numerator: 118, denominator: 1, status: "pass", thresholds: "过 ≥100 人 · 修 30–100 人 · 不过 <30 人", note: "所选时间范围内登记的人数。" },
  ],
  gate2: [
    { id: "completion", label: "开局到看到复盘的完成率", value: 9 / 20, display: pct(9, 20), numerator: 9, denominator: 20, status: "pass", thresholds: "过 ≥40% · 修 20–40% · 不过 <20%", note: "出了复盘的对局 / 开局数。" },
    { id: "median_minutes", label: "完成者的中位时长", value: 27, display: "27 分钟", numerator: 27, denominator: 9, status: "pass", thresholds: "过 15–35 分钟 · 修 35–50 分钟 · 不过 >50 或 <8 分钟", note: "按事件时间算的实际在线时长,两次操作间隔超过 10 分钟的按 10 分钟计。" },
    { id: "promoters", label: "完成者中打 9–10 分推荐意愿的比例", value: 2 / 9, display: pct(2, 9), numerator: 2, denominator: 9, status: "fix", thresholds: "过 ≥30% · 修 15–30% · 不过 <15%", note: "分母是完成者(没打分的按不推荐计)。" },
    { id: "want_next", label: "完成者中表示想玩下一个场景的比例", value: 6 / 9, display: pct(6, 9), numerator: 6, denominator: 9, status: "pass", thresholds: "过 ≥60% · 修 40–60% · 不过 <40%", note: "分母是完成者。" },
    { id: "share", label: "完成者中主动分享复盘卡的比例", value: 1 / 9, display: pct(1, 9), numerator: 1, denominator: 9, status: "fix", thresholds: "过 ≥15% · 修 5–15% · 不过 <5%", note: "保存分享图或复制分享文字算分享。" },
    { id: "dispute", label: "对评分提出申诉的比例", value: 1 / 9, display: pct(1, 9), numerator: 1, denominator: 9, status: "pass", thresholds: "过 <20% · 修 20–40% · 不过 >40%", note: "有申诉的复盘 / 出了复盘的对局。" },
  ],
  gate3: [
    { id: "waitlist_to_paid", label: "候补名单到预售付费的转化", value: 0, display: "0%", numerator: 0, denominator: 118, status: "fail", thresholds: "过 ≥5% · 修 2–5% · 不过 <2%", note: "兑换过付费商品的候补名单用户 / 候补名单人数。" },
  ],
  extra: { turnLatencyMsP50: 2350, turnLatencyMsP90: 4100, firstTurnSecondsP50: 48, firstTurnSample: 7 },
} satisfies GatesResponse);
write("admin-redeem-codes.json", {
  rows: [
    { code: "ABCD-EFGH-JKLM", productId: "sprint", note: "早鸟第一批", createdAt: "2026-10-05T09:00:00.000Z", redeemedAt: "2026-10-05T09:10:00.000Z", redeemedBy: "player@example.com" },
    { code: "NPQR-STUV-WXYZ", productId: "sprint", note: "早鸟第一批", createdAt: "2026-10-05T09:00:00.000Z", redeemedAt: null, redeemedBy: null },
  ],
  byProduct: [{ productId: "sprint", productName: "求职冲刺包", created: 2, redeemed: 1 }],
} satisfies AdminRedeemCodesResponse);

write("error-unauthorized.json", { error: { code: "unauthorized", message: "请先登录" } });
write("error-rate-limited.json", { error: { code: "rate_limited", message: "今天的 3 局已经用完了,明天再来" } });
console.log(`fixtures written to ${out}`);
