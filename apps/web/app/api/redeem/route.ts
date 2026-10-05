// POST /api/redeem —— 兑换码核销(方案 7.3:站内只做兑换码核销,不放支付按钮)。需要登录且已同意协议。
// 兑换码不区分大小写,空格和短横线忽略(store 负责规范化)。同一用户 1 小时内失败 10 次后 429。
import type { RedeemResponse } from "@fde/contracts";
import { requireUser } from "../../../lib/server/auth.ts";
import { entitlementsFor, noteRedeemFailure, redeemBlocked, toEntitlement } from "../../../lib/server/entitlements.ts";
import { recordEvent, visitorIdFrom } from "../../../lib/server/events.ts";
import { HttpError, MESSAGES, handle, json, nowIso, readJson } from "../../../lib/server/http.ts";
import { RedeemSchema } from "../../../lib/server/schemas.ts";
import { getStore } from "../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireUser(req);
    const body = await readJson(req, RedeemSchema);
    if (!user.consentAt) throw new HttpError("consent_required", MESSAGES.consent_required);
    if (redeemBlocked(user.id)) throw new HttpError("rate_limited", "兑换失败的次数太多了,请一小时后再试");
    const store = await getStore();
    const existing = await store.getRedeemCode(body.code);
    if (!existing) {
      noteRedeemFailure(user.id);
      throw new HttpError("redeem_invalid", "兑换码不存在");
    }
    // 并发兑换同一个码只有一个成功:查的时候还没用、兑换时已被别人抢先,也按"已被使用"处理
    const row = await store.redeemCode(body.code, user.id, nowIso());
    if (!row) {
      noteRedeemFailure(user.id);
      throw new HttpError("redeem_invalid", "这个兑换码已经被使用");
    }
    await recordEvent({ type: "code_redeemed", userId: user.id, visitorId: visitorIdFrom(req), props: { productId: row.productId } });
    const res: RedeemResponse = { entitlement: toEntitlement(row), entitlements: await entitlementsFor(store, user.id) };
    return json(res);
  });
}
