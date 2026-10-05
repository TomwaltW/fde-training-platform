// POST /api/admin/redeem-codes —— 生成兑换码(管理员;商品必须在 config/products.yaml 里,未上架的也行)。
// GET /api/admin/redeem-codes?productId=&limit= —— 兑换码列表(新的在前)和按商品的汇总。
import type { AdminRedeemCodesResponse, CreateRedeemCodesResponse, RedeemCodeRow } from "@fde/contracts";
import { requireAdmin, userLabel } from "../../../../lib/server/auth.ts";
import { HttpError, handle, json, readJson } from "../../../../lib/server/http.ts";
import { findProduct, productsConfig } from "../../../../lib/server/products.ts";
import { CreateRedeemCodesSchema } from "../../../../lib/server/schemas.ts";
import { getStore } from "../../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const body = await readJson(req, CreateRedeemCodesSchema);
    if (!findProduct(body.productId)) throw new HttpError("bad_request", `config/products.yaml 里没有商品「${body.productId}」`);
    const store = await getStore();
    const res: CreateRedeemCodesResponse = { codes: await store.createRedeemCodes(body.productId, body.count, body.note || undefined) };
    return json(res, 201);
  });
}

type ProductStat = AdminRedeemCodesResponse["byProduct"][number];

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const q = new URL(req.url).searchParams;
    const productId = q.get("productId")?.trim() || undefined;
    const limitRaw = q.get("limit");
    const limit = limitRaw === null ? 500 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new HttpError("bad_request", "limit 应为 1–5000 的整数");

    const store = await getStore();
    // 汇总要看全部兑换码;列表再按商品筛、按 limit 截
    const all = await store.listRedeemCodes();
    const stats = new Map<string, ProductStat>();
    for (const p of productsConfig().products) stats.set(p.id, { productId: p.id, productName: p.name, created: 0, redeemed: 0 });
    // 库里有、配置里已经没有的商品排在后面(按 id),名称就用 id
    const unknown = [...new Set(all.map((c) => c.productId))].filter((id) => !stats.has(id)).sort();
    for (const id of unknown) stats.set(id, { productId: id, productName: id, created: 0, redeemed: 0 });
    for (const c of all) {
      const s = stats.get(c.productId)!;
      s.created += 1;
      if (c.redeemedBy) s.redeemed += 1;
    }

    const labels = new Map<string, string>();
    async function label(userId: string): Promise<string> {
      let l = labels.get(userId);
      if (l === undefined) {
        const u = await store.getUser(userId);
        l = u ? userLabel(u) : userId;
        labels.set(userId, l);
      }
      return l;
    }
    const picked = (productId ? all.filter((c) => c.productId === productId) : all).slice(0, limit);
    const rows: RedeemCodeRow[] = [];
    for (const c of picked) {
      rows.push({
        code: c.code,
        productId: c.productId,
        note: c.note,
        createdAt: c.createdAt,
        redeemedAt: c.redeemedAt,
        redeemedBy: c.redeemedBy ? await label(c.redeemedBy) : null,
      });
    }
    const res: AdminRedeemCodesResponse = { rows, byProduct: [...stats.values()] };
    return json(res);
  });
}
