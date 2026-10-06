// DELETE /api/me/data —— 删除本人全部对局(连同复盘、反馈、模型调用记录)。账号本身保留。
import type { DeleteMyDataResponse } from "@fde/contracts";
import { requireUser } from "../../../../lib/server/auth.ts";
import { handle, json } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";

export async function DELETE(req: Request) {
  return handle(async () => {
    const { user } = await requireUser(req);
    const store = await getStore();
    const deletedSessions = await store.deleteUserSessions(user.id);
    const body: DeleteMyDataResponse = { ok: true, deletedSessions };
    return json(body);
  });
}
