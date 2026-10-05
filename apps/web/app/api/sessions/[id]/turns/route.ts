// POST /api/sessions/:id/turns —— 说一句话(本人)。已结束 409 session_ended;并发 409 session_busy。
import { requireUser } from "../../../../../lib/server/auth.ts";
import { handle, json, readJson } from "../../../../../lib/server/http.ts";
import { TurnSchema } from "../../../../../lib/server/schemas.ts";
import { playStep } from "../../../../../lib/server/sessions.ts";
import { getStore } from "../../../../../lib/server/store.ts";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireUser(req);
    const { id } = await ctx.params;
    const body = await readJson(req, TurnSchema);
    const store = await getStore();
    return json(await playStep(store, auth, id, (engine, state) => engine.userTurn(state, body.text), { type: "turn" }));
  });
}
