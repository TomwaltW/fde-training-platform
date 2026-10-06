// POST /api/events —— 浏览器埋点(不需要登录;方案 2.2「自建 events 表」、6.3 的指标)。
// 没有合法的访客 cookie(fde_vid)就发一个;登录了记 userId;sessionId 只在属于当前用户时记,否则丢掉这个字段。
// 同一访客每分钟最多 60 条,超了照样 204 但不入库。成功 204 无响应体。
import { currentAuth } from "../../../lib/server/auth.ts";
import { newVisitorId, recordEvent, visitorCookie, visitorIdFrom } from "../../../lib/server/events.ts";
import { handle, readJson } from "../../../lib/server/http.ts";
import { EventSchema } from "../../../lib/server/schemas.ts";
import { getStore } from "../../../lib/server/store.ts";
import { takeEventQuota } from "./rate-limit.ts";

export async function POST(req: Request) {
  return handle(async () => {
    const existing = visitorIdFrom(req);
    const visitorId = existing ?? newVisitorId();
    const body = await readJson(req, EventSchema);

    if (takeEventQuota(req)) {
      const auth = await currentAuth(req);
      let sessionId: string | null = null;
      if (auth && body.sessionId) {
        const s = await (await getStore()).getSession(body.sessionId);
        if (s && s.userId === auth.user.id) sessionId = s.id;
      }
      await recordEvent({ type: body.type, userId: auth?.user.id ?? null, sessionId, visitorId, props: body.props ?? {} });
    }

    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (!existing) headers["set-cookie"] = visitorCookie(visitorId);
    return new Response(null, { status: 204, headers });
  });
}
