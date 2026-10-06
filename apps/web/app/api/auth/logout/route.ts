// POST /api/auth/logout —— 删除登录态,清 cookie。
import { clearedSessionCookie, requireUser } from "../../../../lib/server/auth.ts";
import { handle, json } from "../../../../lib/server/http.ts";
import { getStore } from "../../../../lib/server/store.ts";

export async function POST(req: Request) {
  return handle(async () => {
    const auth = await requireUser(req);
    const store = await getStore();
    await store.deleteAuthToken(auth.tokenHash);
    return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
  });
}
