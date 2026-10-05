// GET /api/admin/stats —— 完成率、中位用时与总分、申诉率、花费、分数分布、流失回合(管理员)。
import { computeStats } from "../../../../lib/server/admin.ts";
import { requireAdmin } from "../../../../lib/server/auth.ts";
import { handle, json } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    return json(await computeStats(await getStore()));
  });
}
