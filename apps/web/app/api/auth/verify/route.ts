// POST /api/auth/verify —— 校验验证码,成功后设置 httpOnly cookie `fde_session`(30 天)。
import type { VerifyResponse } from "@fde/contracts";
import { SESSION_TTL_SECONDS, newAuthToken, secretHash, sessionCookie, toMe } from "../../../../lib/server/auth.ts";
import { recordEvent, visitorIdFrom } from "../../../../lib/server/events.ts";
import { HttpError, handle, json, readJson } from "../../../../lib/server/http.ts";
import { verifyLoginCode } from "../../../../lib/server/login.ts";
import { VerifySchema } from "../../../../lib/server/schemas.ts";
import { getStore } from "../../../../lib/server/store.ts";

export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson(req, VerifySchema);
    // T0 占位:手机号登录由 F4 实现
    if (body.email === undefined) throw new HttpError("bad_request", "暂不支持手机号登录");
    const user = await verifyLoginCode(body.email, body.code);
    const token = newAuthToken();
    const store = await getStore();
    await store.createAuthToken(user.id, secretHash(token), new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString());
    await recordEvent({ type: "login", userId: user.id, visitorId: visitorIdFrom(req), props: { method: "email" } });
    const res: VerifyResponse = { user: toMe(user) };
    return json(res, 200, { "set-cookie": sessionCookie(token) });
  });
}
