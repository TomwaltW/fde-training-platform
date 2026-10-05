// GET /api/sessions/:id —— 对局视图(本人或管理员)。
import type { SessionResponse } from "@fde/contracts";
import { publicView } from "@fde/engine";
import { requireUser } from "../../../../lib/server/auth.ts";
import { handle, json } from "../../../../lib/server/http.ts";
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
    const res: SessionResponse = { view: publicView(scenarioOf(s).scn, s.state) };
    return json(res);
  });
}
