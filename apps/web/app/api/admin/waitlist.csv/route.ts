// GET /api/admin/waitlist.csv —— 全部候补名单的 CSV(管理员)。UTF-8 带 BOM,RFC 4180 转义,防公式注入;
// 文件名 waitlist-YYYYMMDD.csv(北京时间的日期)。
import { requireAdmin } from "../../../../lib/server/auth.ts";
import { handle } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";
import { waitlistCsv, waitlistCsvFilename, waitlistRows } from "../../../../lib/server/waitlist.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const store = await getStore();
    const csv = waitlistCsv(await waitlistRows(store, await store.listWaitlist()));
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${waitlistCsvFilename()}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
