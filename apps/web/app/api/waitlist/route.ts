// POST /api/waitlist —— 登记候补名单(不需要登录)。WAITLIST_OPEN=0 时 403;陷阱字段 website 非空时假装成功;
// 同一访客 10 分钟内最多 5 次;新登记 201 并记 waitlist_joined,已经在名单里 200(什么都不改)。
import type { WaitlistResponse } from "@fde/contracts";
import { waitlistOpen } from "../../../lib/server/env.ts";
import { recordEvent, visitorIdFrom } from "../../../lib/server/events.ts";
import { HttpError, handle, json, nowIso, readJson } from "../../../lib/server/http.ts";
import { WaitlistSchema } from "../../../lib/server/schemas.ts";
import { getStore } from "../../../lib/server/store.ts";
import { claimJoinSlot } from "../../../lib/server/waitlist.ts";

export async function POST(req: Request) {
  return handle(async () => {
    if (!waitlistOpen()) throw new HttpError("forbidden", "候补名单暂停登记");
    const body = await readJson(req, WaitlistSchema);
    // 只有机器人会填页面上隐藏的 website:照样回成功,不入库、不记事件、不占限频名额
    if (body.website) return json({ ok: true, alreadyJoined: false } satisfies WaitlistResponse, 201);
    claimJoinSlot(req);

    const role = body.role ?? null;
    const source = body.source ?? null;
    const store = await getStore();
    const { created } = await store.addToWaitlist({ email: body.email, role, note: body.note || null, source, createdAt: nowIso() });
    if (created) await recordEvent({ type: "waitlist_joined", visitorId: visitorIdFrom(req), props: { source, role } });
    const res: WaitlistResponse = { ok: true, alreadyJoined: !created };
    return json(res, created ? 201 : 200);
  });
}
