// GET /api/admin/sessions?limit=50&before=<startedAt ISO> —— 所有人的对局(管理员)。
import type { AdminSessionsResponse } from "@fde/contracts";
import { adminSessionRows } from "../../../../lib/server/admin.ts";
import { requireAdmin } from "../../../../lib/server/auth.ts";
import { HttpError, handle, json } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const q = new URL(req.url).searchParams;
    const limitRaw = q.get("limit");
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError("bad_request", "limit 应为 1–500 的整数");
    const before = q.get("before") ?? undefined;
    if (before !== undefined && Number.isNaN(Date.parse(before))) throw new HttpError("bad_request", "before 应为 ISO 时间");
    const store = await getStore();
    const res: AdminSessionsResponse = { sessions: await adminSessionRows(store, await store.listAllSessions(limit, before)) };
    return json(res);
  });
}
