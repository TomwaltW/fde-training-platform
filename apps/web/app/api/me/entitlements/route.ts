// GET /api/me/entitlements —— 本人兑换过的商品、每日限额、能玩的场景、真人复盘预约方式。
import type { EntitlementsResponse } from "@fde/contracts";
import { requireUser } from "../../../../lib/server/auth.ts";
import { entitlementsFor } from "../../../../lib/server/entitlements.ts";
import { handle, json } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireUser(req);
    const store = await getStore();
    const body: EntitlementsResponse = await entitlementsFor(store, user.id);
    return json(body);
  });
}
