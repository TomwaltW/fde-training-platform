// POST /api/admin/invites —— 生成邀请码(管理员)。
import type { CreateInvitesResponse } from "@fde/contracts";
import { requireAdmin } from "../../../../lib/server/auth.ts";
import { handle, json, readJson } from "../../../../lib/server/http.ts";
import { CreateInvitesSchema } from "../../../../lib/server/schemas.ts";
import { getStore } from "../../../../lib/server/store.ts";

export async function POST(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const body = await readJson(req, CreateInvitesSchema);
    const store = await getStore();
    const res: CreateInvitesResponse = { codes: await store.createInvites(body.count, body.maxUses ?? 1, body.note || undefined) };
    return json(res, 201);
  });
}
