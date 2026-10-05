// POST /api/auth/request-code —— 请求登录验证码。新邮箱必须带有效邀请码;同一邮箱 60 秒一次。
import { HttpError, handle, json, readJson } from "../../../../lib/server/http.ts";
import { requestLoginCode } from "../../../../lib/server/login.ts";
import { RequestCodeSchema } from "../../../../lib/server/schemas.ts";

export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson(req, RequestCodeSchema);
    // T0 占位:手机号登录由 F4 实现
    if (body.email === undefined) throw new HttpError("bad_request", "暂不支持手机号登录");
    return json(await requestLoginCode(body.email, body.inviteCode));
  });
}
