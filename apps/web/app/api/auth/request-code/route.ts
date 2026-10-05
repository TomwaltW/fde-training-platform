// POST /api/auth/request-code —— 请求登录验证码(邮箱,或开放了手机号登录时的手机号)。
// 新地址必须带有效邀请码;同一地址 60 秒一次;手机号另有每天每号、全站每小时的条数上限。
import { HttpError, handle, json, readJson } from "../../../../lib/server/http.ts";
import { LIMITS, allow, clientIp } from "../../../../lib/server/ratelimit.ts";
import { loginAddress, requestLoginCode } from "../../../../lib/server/login.ts";
import { RequestCodeSchema } from "../../../../lib/server/schemas.ts";

export async function POST(req: Request) {
  return handle(async () => {
    if (!allow("request-code:ip", clientIp(req), LIMITS.requestCodePerIp.limit, LIMITS.requestCodePerIp.windowMs)) {
      throw new HttpError("rate_limited", "请求太频繁,请过几分钟再试");
    }
    const body = await readJson(req, RequestCodeSchema);
    return json(await requestLoginCode(loginAddress(body), body.inviteCode));
  });
}
