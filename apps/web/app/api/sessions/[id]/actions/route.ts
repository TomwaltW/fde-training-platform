// POST /api/sessions/:id/actions —— 按钮动作(换人、看资料、去现场、做验证、提交判断、结束),body 是 UserAction。
import { requireUser } from "../../../../../lib/server/auth.ts";
import { handle, json, readJson } from "../../../../../lib/server/http.ts";
import { ActionSchema } from "../../../../../lib/server/schemas.ts";
import { playStep } from "../../../../../lib/server/sessions.ts";
import { getStore } from "../../../../../lib/server/store.ts";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireUser(req);
    const { id } = await ctx.params;
    const action = await readJson(req, ActionSchema);
    const store = await getStore();
    return json(await playStep(store, auth, id, (engine, state) => engine.act(state, action)));
  });
}
