// 商品、免费场景与预售开关(第三轮 F3):读 config/products.yaml(路径见 env.ts 的 productsConfigPath())。
// - 文件不存在:所有场景免费、没有商品(预售页不开)。
// - 文件写错:打一次错误日志,同样按"所有场景免费、没有商品"运行,不让整站挂掉。
// 按文件的修改时间和大小缓存:作者改了配置不用重启,下次用到时重新读取;同一份写错的文件只报一次错。
import { readFileSync, statSync } from "node:fs";
import type { Product } from "@fde/contracts";
import { parse } from "yaml";
import { z } from "zod";
import { productsConfigPath } from "./env.ts";

// ---------------------------------------------------------------- 配置文件的结构(严格校验,多出来的键直接报错)

const scenarioId = z.string().trim().min(1).max(64);
/** 商品 id 会出现在兑换码记录和管理接口的查询参数里,只允许字母数字 - _。 */
const productId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "只能用字母、数字、- 和 _,最长 64 个字符");

const IncludesSchema = z.strictObject({
  /** all 表示全部场景。 */
  scenarios: z.union([z.literal("all"), z.array(scenarioId)]),
  extra_daily_sessions: z.number().int().min(0).max(100).default(0),
  human_review: z.boolean().default(false),
});

const ProductSchema = z
  .strictObject({
    id: productId,
    name: z.string().trim().min(1).max(60),
    price_text: z.string().trim().min(1).max(100),
    /** Markdown。 */
    description: z.string().trim().max(5000),
    includes: IncludesSchema,
    /** 只接受 http(s) 链接:页面上直接当外链用。 */
    buy_url: z.url({ protocol: /^https?$/, error: "要是 http(s) 开头的链接" }).nullable().default(null),
    buy_note: z.string().trim().min(1).max(500).nullable().default(null),
    available: z.boolean(),
  })
  .refine((p) => !p.available || p.buy_url !== null || p.buy_note !== null, {
    message: "上架的商品要有 buy_url 或 buy_note(站内不收款,买家得知道去哪里买)",
    path: ["available"],
  });

export const ProductsConfigSchema = z
  .strictObject({
    free_scenarios: z.array(scenarioId),
    human_review_how_to: z.string().trim().min(1).max(5000).nullable().default(null),
    products: z.array(ProductSchema).default([]),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.products.forEach((p, i) => {
      if (seen.has(p.id)) ctx.addIssue({ code: "custom", message: `商品 id「${p.id}」重复了`, path: ["products", i, "id"] });
      seen.add(p.id);
    });
  });

// ---------------------------------------------------------------- 读取

export interface ProductsConfig {
  /** false:没有配置文件或配置写错,此时所有场景免费、没有商品。 */
  configured: boolean;
  freeScenarios: string[];
  humanReviewHowTo: string | null;
  /** 配置里的全部商品(含未上架的),按配置里的顺序。 */
  products: Product[];
}

const UNCONFIGURED: ProductsConfig = { configured: false, freeScenarios: [], humanReviewHowTo: null, products: [] };

/** 解析配置文本;写错时抛错,错误信息逐条列出哪里不对。 */
export function parseProductsConfig(text: string): ProductsConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new Error(`不是合法的 YAML:${e instanceof Error ? e.message : String(e)}`);
  }
  const r = ProductsConfigSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "(根)"}:${i.message}`).join(";"));
  }
  const c = r.data;
  return {
    configured: true,
    freeScenarios: [...new Set(c.free_scenarios)],
    humanReviewHowTo: c.human_review_how_to,
    products: c.products.map((p) => ({
      id: p.id,
      name: p.name,
      priceText: p.price_text,
      description: p.description,
      includes: {
        scenarios: p.includes.scenarios === "all" ? "all" : [...new Set(p.includes.scenarios)],
        extraDailySessions: p.includes.extra_daily_sessions,
        humanReview: p.includes.human_review,
      },
      buyUrl: p.buy_url,
      buyNote: p.buy_note,
      available: p.available,
    })),
  };
}

interface Cached {
  key: string;
  config: ProductsConfig;
}

const KEY = Symbol.for("fde.web.products-config");

function cacheSlot(): { current?: Cached } {
  const g = globalThis as unknown as Record<symbol, { current?: Cached } | undefined>;
  return (g[KEY] ??= {});
}

function load(path: string, exists: boolean): ProductsConfig {
  if (!exists) {
    console.log(`[products] 没有商品配置 ${path}:所有场景免费,预售页不开`);
    return UNCONFIGURED;
  }
  try {
    return parseProductsConfig(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`[products] 商品配置 ${path} 有误,先按"所有场景免费、没有商品"运行。${e instanceof Error ? e.message : String(e)}`);
    return UNCONFIGURED;
  }
}

/** 当前生效的商品配置(文件没变就用缓存)。 */
export function productsConfig(): ProductsConfig {
  const path = productsConfigPath();
  let key: string;
  let exists = true;
  try {
    const st = statSync(path);
    key = `${path}\u0000${st.mtimeMs}\u0000${st.size}`;
  } catch {
    exists = false;
    key = `${path}\u0000missing`;
  }
  const slot = cacheSlot();
  if (slot.current?.key !== key) slot.current = { key, config: load(path, exists) };
  return slot.current.config;
}

// ---------------------------------------------------------------- 查询

/** 预售页是否开放(有上架商品)。 */
export function presaleOpen(): boolean {
  return productsConfig().products.some((p) => p.available);
}

/** 场景的访问方式:free 人人可玩,paid 需要兑换。没有配置(或配置写错)时一律免费。 */
export function scenarioAccess(scenarioId: string): "free" | "paid" {
  const c = productsConfig();
  if (!c.configured) return "free";
  return c.freeScenarios.includes(scenarioId) ? "free" : "paid";
}

/** 配置里的商品(含未上架的)。 */
export function findProduct(id: string): Product | undefined {
  return productsConfig().products.find((p) => p.id === id);
}

/** 包含这个场景的商品,上架的排在前面(同一组里按配置顺序)。 */
export function productsIncluding(scenarioId: string): Product[] {
  const hits = productsConfig().products.filter((p) => p.includes.scenarios === "all" || p.includes.scenarios.includes(scenarioId));
  return [...hits.filter((p) => p.available), ...hits.filter((p) => !p.available)];
}
