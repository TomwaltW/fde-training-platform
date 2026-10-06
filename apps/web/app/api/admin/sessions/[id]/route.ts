// GET /api/admin/sessions/:id —— 作者看一局的全部内部状态:事件、承诺账本、复盘、反馈、模型调用(管理员)。
import type { AdminSessionDetail } from "@fde/contracts";
import { publicReport, publicView } from "@fde/engine";
import { emailLookup, feedbackRows } from "../../../../../lib/server/admin.ts";
import { requireAdmin } from "../../../../../lib/server/auth.ts";
import { handle, json } from "../../../../../lib/server/http.ts";
import { loadSession, scenarioOf } from "../../../../../lib/server/sessions.ts";
import { getStore } from "../../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireAdmin(req);
    const { id } = await ctx.params;
    const store = await getStore();
    const s = await loadSession(store, id);
    const { scn } = scenarioOf(s);
    const [stored, feedback, calls, userEmail] = await Promise.all([
      store.getReport(id),
      store.listFeedback({ sessionId: id }),
      store.listLlmCalls(id),
      emailLookup(store)(s.userId),
    ]);
    const res: AdminSessionDetail = {
      view: publicView(scn, s.state),
      userEmail,
      events: s.state.events,
      ledger: s.state.ledger,
      report: stored ? publicReport(scn, id, stored.report) : null,
      feedback: await feedbackRows(store, feedback),
      llmCalls: calls.map((c) => ({
        at: c.at,
        stage: c.stage,
        model: c.model,
        tokensIn: c.tokensIn,
        tokensOut: c.tokensOut,
        costYuan: c.costYuan,
        latencyMs: c.latencyMs,
        ok: c.ok,
      })),
    };
    return json(res);
  });
}
