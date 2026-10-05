// GET /api/me —— 当前登录用户;未登录 401。
import type { MeResponse } from "@fde/contracts";
import { requireUser, toMe } from "../../../lib/server/auth.ts";
import { handle, json } from "../../../lib/server/http.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireUser(req);
    const body: MeResponse = { user: toMe(user) };
    return json(body);
  });
}
