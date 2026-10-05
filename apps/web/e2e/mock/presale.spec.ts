// 预售与兑换码(第三轮 F3):预售页(上架 / 未上架)、外链属性、兑换页成功与失败、我的权益卡片、
// 管理页生成兑换码、落地页的付费场景。MockApi 之外需要的响应在这里用 page.route 覆盖(后注册的先匹配)。
import { expect, test, type Page } from "@playwright/test";
import type { AdminRedeemCodesResponse, EntitlementsResponse, Product, ProductsResponse, ScenariosResponse, SiteInfo } from "@fde/contracts";
import { expectCompliance, expectNoHorizontalScroll, trackPageErrors } from "./helpers";
import { MOCK_REDEEM_CODE, MockApi, fixture } from "./mock-api";

/** 站点信息:预售开着(顶栏出现"预售")。 */
async function presaleOpen(page: Page) {
  await page.route("**/api/site", (route) => route.fulfill({ json: { ...fixture<SiteInfo>("site"), presaleOpen: true } satisfies SiteInfo }));
}

async function products(page: Page, body: ProductsResponse) {
  await page.route("**/api/products", (route) => route.fulfill({ json: body }));
}

/** fixture 里的冲刺包(只有购买说明)之外,再放一个有第三方购买链接的场景包。 */
function twoProducts(): ProductsResponse {
  const base = fixture<ProductsResponse>("products");
  const pack: Product = {
    id: "scenario-pack",
    name: "场景包",
    priceText: "¥199",
    description: "解锁**付费场景**。",
    includes: { scenarios: ["freight-docs"], extraDailySessions: 2, humanReview: false },
    buyUrl: "https://shop.example.com/fde/scenario-pack",
    buyNote: null,
    available: true,
  };
  return { ...base, products: [...base.products, pack] };
}

test("预售页(上架):商品卡片、外链新标签页打开、购买说明、去兑换、站内不收款、presale_viewed", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await presaleOpen(page);
  await products(page, twoProducts());
  await page.goto("/presale");

  const cards = page.getByTestId("product-card");
  await expect(cards).toHaveCount(2);
  const sprint = cards.filter({ hasText: "求职冲刺包" });
  await expect(sprint.getByTestId("product-price")).toHaveText("早鸟价 ¥399(原价 ¥699)");
  await expect(sprint.getByTestId("includes")).toContainText("全部场景");
  await expect(sprint.getByTestId("includes")).toContainText("每天多开 5 局");
  await expect(sprint.getByTestId("includes")).toContainText("一次真人复盘");
  // 没有 buyUrl:不放按钮,显示购买说明
  await expect(sprint.getByRole("link", { name: "去购买" })).toHaveCount(0);
  await expect(sprint.getByTestId("buy-note")).toContainText("加微信 fde-sim(备注「冲刺包」),转账后发兑换码。");

  const pack = cards.filter({ hasText: "场景包" });
  await expect(pack.locator("strong")).toHaveText("付费场景");
  await expect(pack.getByTestId("includes")).toContainText("场景:货代公司的「单据识别」");
  const buy = pack.getByRole("link", { name: "去购买" });
  await expect(buy).toHaveAttribute("href", "https://shop.example.com/fde/scenario-pack");
  await expect(buy).toHaveAttribute("target", "_blank");
  await expect(buy).toHaveAttribute("rel", "noopener noreferrer");
  await expect(pack.getByTestId("buy-note")).toHaveCount(0);

  await expect(page.getByTestId("no-payment-note")).toContainText("本站不收款,也没有支付按钮");
  await expect(page.getByRole("button", { name: /支付|付款|购买/ })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("link", { name: "去兑换" })).toHaveAttribute("href", "/redeem");
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "预售" })).toHaveAttribute("href", "/presale");
  await expect.poll(() => mock.events).toContainEqual({ type: "presale_viewed" });

  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("预售页(未上架):显示预售还没开始,引到候补名单;仍然可以去兑换", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await products(page, { products: [], freeScenarios: ["freight-docs"], humanReviewHowTo: null });
  await page.goto("/presale");

  const closed = page.getByTestId("presale-closed");
  await expect(closed).toContainText("预售还没开始");
  await expect(closed.getByRole("link", { name: "加入候补名单" })).toHaveAttribute("href", "/waitlist");
  await expect(page.getByTestId("product-card")).toHaveCount(0);
  await expect(page.getByTestId("no-payment-note")).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "去兑换" })).toHaveAttribute("href", "/redeem");
  // 预售没开:顶栏没有"预售"
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "预售" })).toHaveCount(0);
  await expect.poll(() => mock.events).toContainEqual({ type: "presale_viewed" });

  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("兑换页:没登录先去登录(带着兑换码回来)", async ({ page }) => {
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await page.goto("/redeem?code=abcd-efgh-jklm");
  await expect(page).toHaveURL(/\/login\?next=%2Fredeem%3Fcode%3Dabcd-efgh-jklm$/);
  expect(mock.callsTo("POST", /^\/api\/redeem$/)).toHaveLength(0);

  // 登录了但还没同意协议:同样先去登录页(登录页接着做同意那一步)
  mock.auth = "pending";
  await page.goto("/redeem");
  await expect(page).toHaveURL(/\/login\?next=%2Fredeem$/);
});

test("兑换页:?code= 预填;兑换码无效有提示;兑换成功显示解锁了什么,我的权益随之更新", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "user" });
  await mock.install(page);
  await page.goto("/redeem?code=wrong-code");
  const input = page.getByLabel("兑换码");
  await expect(input).toHaveValue("wrong-code");
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);

  await page.getByRole("button", { name: "兑换", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("兑换码无效或已经被使用");

  await input.fill("");
  await page.getByRole("button", { name: "兑换", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("请输入兑换码");

  const typed = MOCK_REDEEM_CODE.toLowerCase().replace(/-/g, " ");
  await input.fill(typed);
  await page.getByRole("button", { name: "兑换", exact: true }).click();
  const done = page.getByTestId("redeem-success");
  await expect(done).toContainText("兑换成功");
  await expect(done.getByRole("heading", { name: "求职冲刺包" })).toBeVisible();
  await expect(done).toContainText(MOCK_REDEEM_CODE);
  await expect(done.getByTestId("includes")).toContainText("全部场景");
  await expect(done.getByTestId("redeem-daily-limit")).toHaveText("现在每天最多能开 8 局。");
  await expect(done.getByTestId("human-review")).toContainText("兑换后加微信 fde-sim,发送兑换码预约时间。");
  expect(mock.callsTo("POST", /^\/api\/redeem$/).map((c) => c.body)).toEqual([{ code: "wrong-code" }, { code: typed }]);
  await expectNoHorizontalScroll(page, info);

  await done.getByRole("link", { name: "我的对局" }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByTestId("entitlement-list")).toContainText("求职冲刺包");
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("我的权益卡片:没兑换过、兑换过(今天的限额、真人复盘预约方式按 Markdown 显示)", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "user" });
  await mock.install(page);
  await page.goto("/me");
  const card = page.getByTestId("entitlements");
  await expect(card).toContainText("还没有兑换过商品");
  await expect(card.getByTestId("daily-limit")).toContainText("今天最多能开 3 局");
  await expect(card.getByRole("link", { name: "输入兑换码" })).toHaveAttribute("href", "/redeem");
  await expect(card.getByTestId("human-review")).toHaveCount(0);

  const sprint = fixture<EntitlementsResponse>("entitlements-sprint");
  mock.entitlements = { ...sprint, humanReviewHowTo: "加微信 **fde-sim**,或者[在线预约](https://cal.example.com/fde)。" };
  await page.reload();
  await expect(card.getByTestId("entitlement-list")).toContainText("求职冲刺包");
  await expect(card.getByTestId("entitlement-list")).toContainText("ABCD-EFGH-JKLM");
  await expect(card.getByTestId("entitlement-list")).toContainText("2026-10-05 17:10");
  await expect(card.getByTestId("includes")).toContainText("每天多开 5 局");
  await expect(card.getByTestId("daily-limit")).toContainText("今天最多能开 8 局");
  const howTo = card.getByTestId("human-review-how-to");
  await expect(howTo.locator("strong")).toHaveText("fde-sim");
  const cal = howTo.getByRole("link", { name: "在线预约" });
  await expect(cal).toHaveAttribute("href", "https://cal.example.com/fde");
  await expect(cal).toHaveAttribute("rel", "noopener noreferrer");

  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("管理页:兑换码展开才请求;列表与状态;生成兑换码(可选未上架的商品)", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "admin" });
  await mock.install(page);
  // 配置里还有一个未上架、还没生成过码的场景包
  const codes = fixture<AdminRedeemCodesResponse>("admin-redeem-codes");
  let listRequests = 0;
  await page.route("**/api/admin/redeem-codes*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    listRequests += 1;
    return route.fulfill({ json: { ...codes, byProduct: [...codes.byProduct, { productId: "scenario-pack", productName: "场景包", created: 0, redeemed: 0 }] } });
  });
  await page.goto("/admin");
  await expect(page.getByTestId("score-histogram")).toBeVisible();
  const panel = page.getByTestId("redeem-panel");
  await expect(panel).toBeVisible();
  expect(listRequests).toBe(0);
  expect(mock.callsTo("GET", /^\/api\/products$/)).toHaveLength(0);

  const toggle = panel.getByRole("button", { name: /^兑换码/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const table = panel.getByTestId("redeem-codes");
  await expect(table.getByRole("row", { name: /ABCD-EFGH-JKLM/ })).toContainText("已兑换 · player@example.com");
  await expect(table.getByRole("row", { name: /NPQR-STUV-WXYZ/ })).toContainText("未使用");
  await expect(table).toContainText("早鸟第一批");
  const byProduct = panel.getByTestId("redeem-by-product");
  await expect(byProduct.getByRole("row", { name: /求职冲刺包/ }).getByRole("cell")).toHaveText(["求职冲刺包(sprint)", "2", "1"]);
  await expect(byProduct.getByRole("row", { name: /场景包/ })).toContainText("未上架");
  // 开发模式的 StrictMode 会把 effect 跑两遍,这里只要求展开后确实请求了
  expect(listRequests).toBeGreaterThanOrEqual(1);

  const select = panel.getByLabel("商品");
  await expect(select).toHaveValue("sprint");
  await expect(select.locator("option")).toHaveText(["求职冲刺包(sprint)", "场景包(scenario-pack) · 未上架"]);
  await panel.getByLabel("数量").fill("3");
  await panel.getByLabel("备注(选填)").fill("早鸟第二批");
  await panel.getByRole("button", { name: "生成兑换码" }).click();
  await expect(panel.getByTestId("redeem-new-codes").locator("li")).toHaveCount(3);
  await expect(panel.getByTestId("redeem-new-codes")).toContainText("新生成 3 个「求职冲刺包」的兑换码");
  await expect(panel.getByRole("button", { name: "复制全部" })).toBeVisible();

  // 未上架的商品也能生成(比如先发给企业试点)
  await select.selectOption("scenario-pack");
  await panel.getByLabel("数量").fill("1");
  await panel.getByLabel("备注(选填)").fill("");
  await panel.getByRole("button", { name: "生成兑换码" }).click();
  await expect(panel.getByTestId("redeem-new-codes").locator("li")).toHaveCount(1);
  expect(mock.callsTo("POST", /^\/api\/admin\/redeem-codes$/).map((c) => c.body)).toEqual([
    { productId: "sprint", count: 3, note: "早鸟第二批" },
    { productId: "scenario-pack", count: 1 },
  ]);
  await expectNoHorizontalScroll(page, info);

  // 收起
  await toggle.click();
  await expect(panel.getByTestId("redeem-codes")).toHaveCount(0);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("落地页:付费场景标需要兑换码;开局遇到 entitlement_required 给出预售页和兑换的链接", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "user" });
  await mock.install(page);
  await page.goto("/");
  // 默认 fixture 的场景免费:没有标记
  await expect(page.getByTestId("scenario-card")).toBeVisible();
  await expect(page.getByTestId("needs-code")).toHaveCount(0);

  const sc = fixture<ScenariosResponse>("scenarios");
  await page.route("**/api/scenarios", (route) => route.fulfill({ json: { scenarios: sc.scenarios.map((s) => ({ ...s, access: "paid" as const })) } }));
  await page.route("**/api/sessions", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 403, json: { error: { code: "entitlement_required", message: "这个场景需要兑换「求职冲刺包」后才能玩" } } })
      : route.fallback(),
  );
  await page.reload();
  const card = page.getByTestId("scenario-card");
  await expect(card.getByTestId("needs-code")).toHaveText("需要兑换码");
  await card.getByRole("button", { name: "开始这一局" }).click();
  const box = card.getByRole("alert");
  await expect(box).toContainText("这个场景需要兑换「求职冲刺包」后才能玩");
  await expect(box.getByRole("link", { name: "已经有兑换码?去兑换" })).toHaveAttribute("href", "/redeem");
  await expectNoHorizontalScroll(page, info);
  await box.getByRole("link", { name: "去预售页看看" }).click();
  await expect(page).toHaveURL(/\/presale$/);
  await expect(page.getByTestId("product-card")).toHaveCount(1);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});
