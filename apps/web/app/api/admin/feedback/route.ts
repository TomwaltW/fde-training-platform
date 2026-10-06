// GET /api/admin/feedback?limit=200 —— 反馈与申诉,新的在前(管理员)。
import type { AdminFeedbackResponse } from "@fde/contracts";
import { feedbackRows } from "../../../../lib/server/admin.ts";
import { requireAdmin } from "../../../../lib/server/auth.ts";
import { HttpError, handle, json } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const limitRaw = new URL(req.url).searchParams.get("limit");
    const limit = limitRaw === null ? 200 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError("bad_request", "limit 应为 1–1000 的整数");
    const store = await getStore();
    const res: AdminFeedbackResponse = { feedback: await feedbackRows(store, await store.listFeedback({ limit })) };
    return json(res);
  });
}
