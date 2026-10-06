// GET /api/products —— 预售页的商品(不需要登录)。只返回上架的;站内不收款,购买走 buyUrl / buyNote。
import type { ProductsResponse } from "@fde/contracts";
import { freeScenarioIds } from "../../../lib/server/entitlements.ts";
import { handle, json } from "../../../lib/server/http.ts";
import { productsConfig } from "../../../lib/server/products.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const config = productsConfig();
    const body: ProductsResponse = {
      products: config.products.filter((p) => p.available),
      freeScenarios: freeScenarioIds(),
      // 真人复盘的预约方式只给兑换了含真人复盘商品的人(见 /api/me/entitlements),公开接口不给
      humanReviewHowTo: null,
    };
    return json(body);
  });
}
