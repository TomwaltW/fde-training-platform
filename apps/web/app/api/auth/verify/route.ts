// POST /api/auth/verify —— 校验验证码(邮箱或手机号),成功后设置 httpOnly cookie `fde_session`(30 天)。
import type { VerifyResponse } from "@fde/contracts";
import { SESSION_TTL_SECONDS, newAuthToken, secretHash, sessionCookie, toMe } from "../../../../lib/server/auth.ts";
import { recordEvent, visitorIdFrom } from "../../../../lib/server/events.ts";
import { HttpError, handle, json, readJson } from "../../../../lib/server/http.ts";
import { LIMITS, allow, clientIp } from "../../../../lib/server/ratelimit.ts";
import { loginAddress, verifyLoginCode } from "../../../../lib/server/login.ts";
import { VerifySchema } from "../../../../lib/server/schemas.ts";
import { getStore } from "../../../../lib/server/store.ts";

export async function POST(req: Request) {
  return handle(async () => {
    if (!allow("verify:ip", clientIp(req), LIMITS.verifyPerIp.limit, LIMITS.verifyPerIp.windowMs)) {
      throw new HttpError("rate_limited", "尝试太频繁,请过几分钟再试");
    }
    const body = await readJson(req, VerifySchema);
    const address = loginAddress(body);
    const user = await verifyLoginCode(address, body.code, body.inviteCode);
    const token = newAuthToken();
    const store = await getStore();
    await store.createAuthToken(user.id, secretHash(token), new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString());
    await recordEvent({ type: "login", userId: user.id, visitorId: visitorIdFrom(req), props: { method: address.kind } });
    const res: VerifyResponse = { user: toMe(user) };
    return json(res, 200, { "set-cookie": sessionCookie(token) });
  });
}
