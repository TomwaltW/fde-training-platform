// POST /api/reports/:id/feedback —— 推荐意愿(0–10)、文字反馈、对某个维度的申诉、想不想玩下一个场景,至少填一项(本人)。
import { requireUser } from "../../../../../lib/server/auth.ts";
import { HttpError, handle, json, nowIso, readJson } from "../../../../../lib/server/http.ts";
import { FeedbackSchema } from "../../../../../lib/server/schemas.ts";
import { assertOwner, loadSession } from "../../../../../lib/server/sessions.ts";
import { getStore } from "../../../../../lib/server/store.ts";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireUser(req);
    const { id } = await ctx.params;
    const body = await readJson(req, FeedbackSchema);
    const store = await getStore();
    const s = await loadSession(store, id);
    assertOwner(auth, s);
    if (!(await store.getReport(id))) throw new HttpError("not_found", "这一局还没有复盘");
    await store.addFeedback({
      sessionId: id,
      userId: auth.user.id,
      rating: body.rating ?? null,
      text: body.text ? body.text : null,
      dispute: body.dispute ?? null,
      wantNext: body.wantNext ?? null,
      createdAt: nowIso(),
    });
    return json({ ok: true }, 201);
  });
}
