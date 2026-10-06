// POST /api/me/consent —— 记录同意用户协议与隐私政策的时间。
import type { MeResponse } from "@fde/contracts";
import { requireUser, toMe } from "../../../../lib/server/auth.ts";
import { handle, json, nowIso } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireUser(req);
    const store = await getStore();
    await store.setConsent(user.id, nowIso());
    const fresh = (await store.getUser(user.id)) ?? user;
    const body: MeResponse = { user: toMe(fresh) };
    return json(body);
  });
}
