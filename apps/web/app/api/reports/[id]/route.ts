// GET /api/reports/:id —— 复盘(本人或管理员;还没出复盘 404)。reportId 与 sessionId 相同。
import type { ReportResponse } from "@fde/contracts";
import { publicReport } from "@fde/engine";
import { requireUser } from "../../../../lib/server/auth.ts";
import { HttpError, handle, json } from "../../../../lib/server/http.ts";
import { assertCanView, loadSession, scenarioOf } from "../../../../lib/server/sessions.ts";
import { getStore } from "../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireUser(req);
    const { id } = await ctx.params;
    const store = await getStore();
    const s = await loadSession(store, id);
    assertCanView(auth, s);
    const stored = await store.getReport(id);
    if (!stored) throw new HttpError("not_found", "这一局还没有复盘");
    const res: ReportResponse = { report: publicReport(scenarioOf(s).scn, id, stored.report) };
    return json(res);
  });
}
