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
} satisfies SiteInfo);
write("me.json", { user: { id: "u-fixture-1", email: "player@example.com", isAdmin: false, consentAt: T0 } } satisfies MeResponse);
write("me-admin.json", { user: { id: "u-fixture-2", email: "author@example.com", isAdmin: true, consentAt: T0 } } satisfies MeResponse);
write("scenarios.json", {
  scenarios: [
    {
      id: scn.data.meta.id,
      title: scn.data.meta.title,
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
if (!art.files.length) {
  // 合成单据还没渲染时给一组示例文件名,前端据此做查看器
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
const fb = { sessionId: st.sessionId, userEmail: "player@example.com", rating: 8, text: "周总记账那段很真实", dispute: { dimension: "D3", reason: "我问了很多量化问题" }, createdAt: "2026-10-05T08:35:00.000Z" };
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
write("error-unauthorized.json", { error: { code: "unauthorized", message: "请先登录" } });
write("error-rate-limited.json", { error: { code: "rate_limited", message: "今天的 3 局已经用完了,明天再来" } });
console.log(`fixtures written to ${out}`);
