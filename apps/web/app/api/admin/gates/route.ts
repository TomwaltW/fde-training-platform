// GET /api/admin/gates?since=<ISO>&until=<ISO> —— 方案 6.3 继续/转向/放弃的三关指标(管理员)。
// 第一关、第三关按候补登记时间筛选,第二关按开局时间;门槛来自 config/gates.yaml。
import { requireAdmin } from "../../../../lib/server/auth.ts";
import { computeGatesFromStore, gatesConfigForRequest, parseGatesRange } from "../../../../lib/server/gates.ts";
import { handle, json } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const range = parseGatesRange(new URL(req.url).searchParams);
    const cfg = gatesConfigForRequest();
    return json(await computeGatesFromStore(await getStore(), range, cfg));
  });
}
