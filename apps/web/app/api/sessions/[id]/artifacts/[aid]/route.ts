// GET /api/sessions/:id/artifacts/:aid —— 资料信息和文件列表(本人或管理员;没拿到 403)。
import type { ArtifactResponse } from "@fde/contracts";
import { obtainedArtifact } from "../../../../../../lib/server/artifacts.ts";
import { requireUser } from "../../../../../../lib/server/auth.ts";
import { handle, json } from "../../../../../../lib/server/http.ts";
import { assertCanView, loadSession } from "../../../../../../lib/server/sessions.ts";
import { getStore } from "../../../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; aid: string }> }) {
  return handle(async () => {
    const auth = await requireUser(req);
    const { id, aid } = await ctx.params;
    const store = await getStore();
    const s = await loadSession(store, id);
    assertCanView(auth, s);
    const res: ArtifactResponse = { artifact: obtainedArtifact(s, aid) };
    return json(res);
  });
}
