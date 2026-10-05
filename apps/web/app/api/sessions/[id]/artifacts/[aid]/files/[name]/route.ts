// GET /api/sessions/:id/artifacts/:aid/files/:name —— 资料文件本体(本人或管理员)。
// 没拿到资料 403;文件名不在白名单里 404。图片和 pdf inline,xlsx 附件下载;不缓存。
import { readFile } from "node:fs/promises";
import { artifactFile, contentDisposition, contentType } from "../../../../../../../../lib/server/artifacts.ts";
import { requireUser } from "../../../../../../../../lib/server/auth.ts";
import { handle } from "../../../../../../../../lib/server/http.ts";
import { assertCanView, loadSession } from "../../../../../../../../lib/server/sessions.ts";
import { getStore } from "../../../../../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; aid: string; name: string }> }) {
  return handle(async () => {
    const auth = await requireUser(req);
    const { id, aid, name } = await ctx.params;
    const store = await getStore();
    const s = await loadSession(store, id);
    assertCanView(auth, s);
    const file = artifactFile(s, aid, name);
    const data = new Uint8Array(await readFile(file.path));
    return new Response(data, {
      status: 200,
      headers: {
        "content-type": contentType(file.name),
        "content-length": String(data.byteLength),
        "content-disposition": contentDisposition(file),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
