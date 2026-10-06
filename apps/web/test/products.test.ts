// 商品配置(config/products.yaml)的读取与校验:仓库里的默认配置、缺文件、写错、未上架,
// 以及 GET /api/products、/api/site 的 presaleOpen、/api/scenarios 的 access。
// 付费场景用临时配置(FDE_PRODUCTS_CONFIG)测:仓库里的默认配置让所有场景免费。
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductsResponse, ScenariosResponse, SiteInfo } from "@fde/contracts";
import * as products from "../app/api/products/route.ts";
import * as scenarios from "../app/api/scenarios/route.ts";
import * as site from "../app/api/site/route.ts";
import { parseProductsConfig, presaleOpen, productsConfig, productsIncluding, scenarioAccess } from "../lib/server/products.ts";
import { resetForTests } from "../lib/server/runtime.ts";
import { Client } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const tmp = mkdtempSync(join(tmpdir(), "fde-products-test-"));
let seq = 0;

const ENV_KEYS = ["FDE_ROOT", "FDE_ENGINE_MODE", "FDE_MEMORY_STORE_FILE", "FDE_PRODUCTS_CONFIG", "DATABASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { FDE_ROOT: ROOT, FDE_ENGINE_MODE: "offline", FDE_MEMORY_STORE_FILE: join(tmp, `store-${++seq}.json`) });
  await resetForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** 写一份临时配置并让服务端读它;返回文件路径。 */
function useConfig(text: string): string {
  const file = join(tmp, `products-${++seq}.yaml`);
  writeFileSync(file, text);
  process.env.FDE_PRODUCTS_CONFIG = file;
  return file;
}

const VALID = `
free_scenarios: [freight-docs]
human_review_how_to: 加微信预约
products:
  - id: sprint
    name: 求职冲刺包
    price_text: 早鸟价 ¥399
    description: 全部场景,外加一次真人复盘。
    includes: {scenarios: all, extra_daily_sessions: 5, human_review: true}
    buy_url: https://shop.example.com/sprint
    available: true
  - id: pack
    name: 场景包
    price_text: "【待定】"
    description: 解锁付费场景。
    includes: {scenarios: [freight-docs, warehouse]}
    available: false
`;

/** 不合法的配置要报错,错误信息里能看出是哪里。 */
function expectInvalid(text: string, hint: RegExp) {
  expect(() => parseProductsConfig(text)).toThrow(hint);
}

describe("仓库里的默认配置", () => {
  it("两个商品(求职冲刺包、场景包)都没上架、价格待定,第一个场景免费,真人复盘预约方式待填写", () => {
    const c = productsConfig();
    expect(c.configured).toBe(true);
    expect(c.freeScenarios).toEqual(["freight-docs"]);
    expect(c.products.map((p) => p.name)).toEqual(["求职冲刺包", "场景包"]);
    for (const p of c.products) {
      expect(p.available).toBe(false);
      expect(p.priceText).toBe("【待定】");
    }
    const sprint = c.products[0]!;
    expect(sprint.includes).toEqual({ scenarios: "all", extraDailySessions: 5, humanReview: true });
    expect(c.humanReviewHowTo).toContain("【待填写】");
    expect(presaleOpen()).toBe(false);
    expect(scenarioAccess("freight-docs")).toBe("free");
  });

  it("GET /api/products 返回空列表;site.presaleOpen 为 false;场景都是 free", async () => {
    const c = new Client();
    const r = await c.get<ProductsResponse>(products.GET);
    expect(r.status).toBe(200);
    expect(r.body.products).toEqual([]);
    expect(r.body.freeScenarios).toEqual(["freight-docs"]);
    expect((await c.get<SiteInfo>(site.GET)).body.presaleOpen).toBe(false);
    const s = await c.get<ScenariosResponse>(scenarios.GET);
    expect(s.body.scenarios.map((x) => x.access)).toEqual(["free"]);
  });
});

describe("配置校验(严格:拼错的键直接报错)", () => {
  it("合法配置:键名转成契约里的驼峰,默认值补齐", () => {
    const c = parseProductsConfig(VALID);
    expect(c.products[1]).toEqual({
      id: "pack",
      name: "场景包",
      priceText: "【待定】",
      description: "解锁付费场景。",
      includes: { scenarios: ["freight-docs", "warehouse"], extraDailySessions: 0, humanReview: false },
      buyUrl: null,
      buyNote: null,
      available: false,
    });
  });

  it("拼错或多出来的键", () => {
    expectInvalid(VALID.replace("price_text: 早鸟价", "prise_text: 早鸟价"), /prise_text|price_text/);
    expectInvalid(`${VALID}\nextra_key: 1\n`, /extra_key/);
    expectInvalid(VALID.replace("extra_daily_sessions: 5", "extra_daily_session: 5"), /extra_daily_session/);
  });

  it("缺字段、类型不对、取值越界", () => {
    expectInvalid(VALID.replace("free_scenarios: [freight-docs]\n", ""), /free_scenarios/);
    expectInvalid(VALID.replace("    available: false\n", ""), /available/);
    expectInvalid(VALID.replace("available: true", "available: yes please"), /available/);
    expectInvalid(VALID.replace("extra_daily_sessions: 5", "extra_daily_sessions: -1"), /extra_daily_sessions/);
    expectInvalid(VALID.replace("scenarios: all", "scenarios: everything"), /scenarios/);
  });

  it("购买链接只能是 http(s);上架的商品要有 buy_url 或 buy_note;id 不能重复", () => {
    expectInvalid(VALID.replace("https://shop.example.com/sprint", "javascript:alert(1)"), /buy_url/);
    expectInvalid(VALID.replace("    buy_url: https://shop.example.com/sprint\n", ""), /buy_url 或 buy_note/);
    expect(parseProductsConfig(VALID.replace("buy_url: https://shop.example.com/sprint", "buy_note: 加微信 fde-sim")).products[0]?.buyNote).toBe("加微信 fde-sim");
    expectInvalid(VALID.replace("id: pack", "id: sprint"), /重复/);
    expectInvalid(VALID.replace("id: pack", "id: 场景包"), /products\.1\.id/);
  });

  it("不是合法的 YAML、空文件", () => {
    expectInvalid("free_scenarios: [freight-docs\n", /YAML/);
    expectInvalid("free_scenarios: []\nfree_scenarios: []\n", /YAML/);
    expectInvalid("", /\(根\)/);
  });
});

describe("文件不存在或写错时:所有场景免费、没有商品", () => {
  it("文件不存在", async () => {
    process.env.FDE_PRODUCTS_CONFIG = join(tmp, "no-such-products.yaml");
    expect(productsConfig().configured).toBe(false);
    expect(presaleOpen()).toBe(false);
    expect(scenarioAccess("freight-docs")).toBe("free");
    const c = new Client();
    const r = await c.get<ProductsResponse>(products.GET);
    expect(r.body).toEqual({ products: [], freeScenarios: ["freight-docs"], humanReviewHowTo: null });
    expect((await c.get<ScenariosResponse>(scenarios.GET)).body.scenarios[0]?.access).toBe("free");
  });

  it("写错:只打一次错误日志,站点照常运行;改对之后不用重启就生效", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = useConfig(VALID.replace("price_text: 早鸟价", "prise_text: 早鸟价").replace("free_scenarios: [freight-docs]", "free_scenarios: []"));
    const c = new Client();
    for (let i = 0; i < 3; i++) {
      expect((await c.get<ProductsResponse>(products.GET)).body.products).toEqual([]);
      expect((await c.get<SiteInfo>(site.GET)).body.presaleOpen).toBe(false);
      expect((await c.get<ScenariosResponse>(scenarios.GET)).body.scenarios[0]?.access).toBe("free");
    }
    const productErrors = errors.mock.calls.filter((args) => String(args[0]).includes("[products]"));
    expect(productErrors).toHaveLength(1);
    expect(String(productErrors[0]?.[0])).toMatch(/prise_text/);

    // 改对:文件的修改时间变了,下次请求重新读取
    writeFileSync(file, VALID);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect((await c.get<ProductsResponse>(products.GET)).body.products.map((p) => p.id)).toEqual(["sprint"]);
    expect(errors.mock.calls.filter((args) => String(args[0]).includes("[products]"))).toHaveLength(1);
  });
});

describe("上架与未上架", () => {
  it("GET /api/products 只返回上架的商品;有上架商品时 presaleOpen 为 true", async () => {
    useConfig(VALID);
    const c = new Client();
    const r = await c.get<ProductsResponse>(products.GET);
    expect(r.status).toBe(200);
    expect(r.body.products).toEqual([
      {
        id: "sprint",
        name: "求职冲刺包",
        priceText: "早鸟价 ¥399",
        description: "全部场景,外加一次真人复盘。",
        includes: { scenarios: "all", extraDailySessions: 5, humanReview: true },
        buyUrl: "https://shop.example.com/sprint",
        buyNote: null,
        available: true,
      },
    ]);
    expect(r.body.freeScenarios).toEqual(["freight-docs"]);
    // 预约方式只给兑换了含真人复盘商品的人,公开接口不给
    expect(r.body.humanReviewHowTo).toBeNull();
    expect((await c.get<SiteInfo>(site.GET)).body.presaleOpen).toBe(true);
  });

  it("全部未上架:没有商品、预售不开", async () => {
    useConfig(VALID.replace("available: true", "available: false"));
    const c = new Client();
    expect((await c.get<ProductsResponse>(products.GET)).body.products).toEqual([]);
    expect((await c.get<SiteInfo>(site.GET)).body.presaleOpen).toBe(false);
  });

  it("不在 free_scenarios 里的场景是 paid;包含它的商品上架的排在前面", async () => {
    useConfig(VALID.replace("free_scenarios: [freight-docs]", "free_scenarios: []"));
    expect(scenarioAccess("freight-docs")).toBe("paid");
    expect((await new Client().get<ScenariosResponse>(scenarios.GET)).body.scenarios[0]?.access).toBe("paid");
    // 场景包在配置里排第一,但没上架
    useConfig(VALID.replace(/products:\n([\s\S]*?)(  - id: pack[\s\S]*)$/, "products:\n$2$1"));
    expect(productsConfig().products.map((p) => p.id)).toEqual(["pack", "sprint"]);
    expect(productsIncluding("freight-docs").map((p) => p.id)).toEqual(["sprint", "pack"]);
    expect(productsIncluding("warehouse").map((p) => p.id)).toEqual(["sprint", "pack"]);
    expect(productsIncluding("other").map((p) => p.id)).toEqual(["sprint"]);
  });
});
