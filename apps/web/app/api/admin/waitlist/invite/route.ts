// POST /api/admin/waitlist/invite —— 给候补名单发邀请码(管理员)。count:最早的 count 个还没邀请的;
// emails:只处理在名单里且还没邀请的。每人一个只能用一次的邀请码;有 SMTP 就发邀请邮件,某一封失败只影响那一行。
import { requireAdmin } from "../../../../../lib/server/auth.ts";
import { handle, json, readJson } from "../../../../../lib/server/http.ts";
import { InviteWaitlistSchema } from "../../../../../lib/server/schemas.ts";
import { getStore } from "../../../../../lib/server/store.ts";
import { inviteFromWaitlist } from "../../../../../lib/server/waitlist.ts";

export async function POST(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const body = await readJson(req, InviteWaitlistSchema);
    return json(await inviteFromWaitlist(await getStore(), body));
  });
}
