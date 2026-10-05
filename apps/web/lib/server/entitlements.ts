// 权益(第三轮 F3):用户兑换过的兑换码 → 能玩哪些场景、每天能开几局、有没有真人复盘;
// 付费场景的开局校验;兑换失败的限频。
import type { Entitlement, EntitlementsResponse, ProductIncludes, RedeemCode, Store } from "@fde/contracts";
import { dailySessionLimit } from "./env.ts";
import { findProduct, productsConfig, productsIncluding, scenarioAccess } from "./products.ts";
import { runtime } from "./runtime.ts";
import { scenarios } from "./scenarios.ts";

/** 配置里已经没有的商品:照样列出来,但不再带任何权益。 */
const NO_INCLUDES: ProductIncludes = { scenarios: [], extraDailySessions: 0, humanReview: false };

/** 一条已兑换的兑换码 → 权益(名称和内容按当前配置)。 */
export function toEntitlement(row: RedeemCode): Entitlement {
  const product = findProduct(row.productId);
  return {
    productId: row.productId,
    productName: product?.name ?? row.productId,
    code: row.code,
    redeemedAt: row.redeemedAt ?? row.createdAt,
    includes: product ? structuredClone(product.includes) : structuredClone(NO_INCLUDES),
  };
}

/**
 * 汇总权益。每日限额 = FDE_DAILY_SESSION_LIMIT + 各商品的 extraDailySessions(同一个商品兑换多次只算一次)。
 * 没有商品配置时所有场景免费,scenarios 为 "all"。
 */
export function summarize(entitlements: Entitlement[]): EntitlementsResponse {
  const config = productsConfig();
  const extraByProduct = new Map<string, number>();
  for (const e of entitlements) extraByProduct.set(e.productId, Math.max(extraByProduct.get(e.productId) ?? 0, e.includes.extraDailySessions));
  const extra = [...extraByProduct.values()].reduce((a, b) => a + b, 0);

  let playable: string[] | "all";
  if (!config.configured || entitlements.some((e) => e.includes.scenarios === "all")) playable = "all";
  else {
    const set = new Set(config.freeScenarios);
    for (const e of entitlements) if (Array.isArray(e.includes.scenarios)) for (const id of e.includes.scenarios) set.add(id);
    playable = [...set];
  }
  const humanReview = entitlements.some((e) => e.includes.humanReview);
  return {
    entitlements,
    dailySessionLimit: dailySessionLimit() + extra,
    scenarios: playable,
    humanReview,
    humanReviewHowTo: humanReview ? config.humanReviewHowTo : null,
  };
}

/** 该用户的全部权益(新兑换的在前)。 */
export async function entitlementsFor(store: Store, userId: string): Promise<EntitlementsResponse> {
  const rows = await store.listRedeemCodes({ redeemedBy: userId });
  const entitlements = rows
    .filter((r) => r.redeemedBy === userId)
    .map(toEntitlement)
    .sort((a, b) => (a.redeemedAt < b.redeemedAt ? 1 : a.redeemedAt > b.redeemedAt ? -1 : a.code.localeCompare(b.code)));
  return summarize(entitlements);
}

/** 能不能开这个场景:免费的人人能玩,付费的要有包含它的权益。 */
export function canPlay(ent: EntitlementsResponse, scenarioId: string): boolean {
  if (scenarioAccess(scenarioId) === "free") return true;
  return ent.scenarios === "all" || ent.scenarios.includes(scenarioId);
}

/** 付费场景没有权益时的提示:列出第一个上架的、包含这个场景的商品;没有上架的就不点名(未上架的可能是企业试点的定制商品)。 */
export function entitlementRequiredMessage(scenarioId: string): string {
  const product = productsIncluding(scenarioId).find((p) => p.available);
  return product ? `这个场景需要兑换「${product.name}」后才能玩` : "这个场景需要兑换相应的商品后才能玩";
}

/** 免费场景的 id:没有商品配置时就是全部场景。 */
export function freeScenarioIds(): string[] {
  const config = productsConfig();
  return config.configured ? config.freeScenarios : [...scenarios().keys()];
}

// ---------------------------------------------------------------- 兑换失败的限频

/** 同一用户 1 小时内兑换失败 10 次后,再兑换(不论码对不对)一律 429,挡住批量猜码。 */
export const REDEEM_FAILURE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const;

function failureTimes(userId: string, now: number): number[] {
  const map = (runtime().rateLimits ??= new Map<string, number[]>());
  const id = `redeem-failures\u0000${userId}`;
  const recent = (map.get(id) ?? []).filter((t) => now - t < REDEEM_FAILURE_LIMIT.windowMs);
  if (recent.length) map.set(id, recent);
  else map.delete(id);
  return recent;
}

export function redeemBlocked(userId: string, now = Date.now()): boolean {
  return failureTimes(userId, now).length >= REDEEM_FAILURE_LIMIT.limit;
}

export function noteRedeemFailure(userId: string, now = Date.now()): void {
  const recent = failureTimes(userId, now);
  recent.push(now);
  runtime().rateLimits!.set(`redeem-failures\u0000${userId}`, recent);
}

/**
 * 兑换前先同步占一次"失败"名额(超了返回 null),成功后再用 releaseRedeemAttempt 退掉:
 * 并发的一批猜测在第一个失败被记下之前就都过了检查,先占后退才挡得住。
 */
export function reserveRedeemAttempt(userId: string, now = Date.now()): number | null {
  if (redeemBlocked(userId, now)) return null;
  noteRedeemFailure(userId, now);
  return now;
}

export function releaseRedeemAttempt(userId: string, stamp: number): void {
  const id = `redeem-failures\u0000${userId}`;
  const ts = runtime().rateLimits?.get(id);
  const i = ts?.indexOf(stamp) ?? -1;
  if (ts && i >= 0) ts.splice(i, 1);
}
