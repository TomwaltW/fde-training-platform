// GET /api/admin/waitlist?status=all|pending|invited —— 候补名单(管理员)。按登记时间从早到晚;
// 合计与来源统计按全部名单算,status 只筛选 rows。
import { requireAdmin } from "../../../../lib/server/auth.ts";
import { HttpError, handle, json } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";
import { WAITLIST_STATUS_FILTERS, adminWaitlist, type WaitlistStatusFilter } from "../../../../lib/server/waitlist.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const status = new URL(req.url).searchParams.get("status") ?? "all";
    if (!(WAITLIST_STATUS_FILTERS as readonly string[]).includes(status)) throw new HttpError("bad_request", "status 应为 all、pending 或 invited");
    return json(await adminWaitlist(await getStore(), status as WaitlistStatusFilter));
  });
}
