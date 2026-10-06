// 候补名单(第三轮 F1):落地页没登录时的候补卡片、/waitlist 登记页(?from= 来源、埋点、各种结果)、
// 管理页的候补名单区块(展开才请求、合计与名单、邀请最早 N 位与勾选邀请、没发邮件的复制邀请码、CSV 链接)。
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectCompliance, expectNoHorizontalScroll, trackPageErrors } from "./helpers";
import { MockApi } from "./mock-api";

const WAITLIST_GET = /^\/api\/admin\/waitlist$/;
const WAITLIST_INVITE = /^\/api\/admin\/waitlist\/invite$/;

/** 覆盖 POST /api/waitlist 的响应(别的方法交回 MockApi)。 */
async function overrideJoin(page: Page, respond: (route: Route) => Promise<void>) {
  await page.route("**/api/waitlist", (route) => (route.request().method() === "POST" ? respond(route) : route.fallback()));
}

test("落地页:没登录看到候补卡片,留下邮箱时带上链接里的 ?from=", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await page.goto("/?from=jike");
  const card = page.getByTestId("waitlist-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading")).toHaveText("没有邀请码?留下邮箱,开放时第一时间通知你");
  await expect(card.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "/legal/privacy");
  await expectNoHorizontalScroll(page, info);

  await card.getByLabel("邮箱").fill(" new@example.com ");
  await card.getByLabel("你的身份(选填)").selectOption({ label: "在职,想转 FDE" });
  await card.getByRole("button", { name: "加入候补名单" }).click();
  await expect(card.getByTestId("waitlist-done")).toContainText("登记好了");
  await expect(card.getByTestId("waitlist-done")).toContainText("new@example.com");
  // 落地页卡片不问"想用它做什么";陷阱字段没填就不发
  expect(mock.callsTo("POST", /^\/api\/waitlist$/).map((c) => c.body)).toEqual([{ email: "new@example.com", role: "career_switch", source: "jike" }]);

  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("落地页:登录了不显示候补卡片", async ({ page }) => {
  const mock = new MockApi({ auth: "user" });
  await mock.install(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "我的对局" })).toBeVisible();
  await expect(page.getByTestId("scenario-card")).toBeVisible();
  await expect(page.getByTestId("waitlist-card")).toHaveCount(0);
});

test("/waitlist:打开记 waitlist_viewed,提交成功,?from= 带进请求", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await page.goto("/waitlist?from=xhs");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("没有邀请码?先登记");
  await expect(main.getByText(/邮箱只用来给你发邀请码/)).toBeVisible();
  await expect(main.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "/legal/privacy");
  await expect.poll(() => mock.events).toContainEqual({ type: "waitlist_viewed", props: { from: "xhs" } });
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);

  // 邮箱不对:页面上就拦下,不发请求
  await main.getByLabel("邮箱").fill("not-an-email");
  await main.getByRole("button", { name: "加入候补名单" }).click();
  await expect(main.getByRole("alert")).toHaveText("邮箱格式不对");
  expect(mock.callsTo("POST", /^\/api\/waitlist$/)).toHaveLength(0);

  await main.getByLabel("邮箱").fill("Student@Example.com");
  await main.getByLabel("你的身份(选填)").selectOption({ label: "学生" });
  await main.getByLabel("想用它做什么(选填)").fill("  毕业想做解决方案,先练练  ");
  await main.getByRole("button", { name: "加入候补名单" }).click();
  await expect(main.getByTestId("waitlist-done")).toContainText("登记好了");
  await expect(main.getByRole("alert")).toHaveCount(0);
  expect(mock.callsTo("POST", /^\/api\/waitlist$/).map((c) => c.body)).toEqual([
    { email: "Student@Example.com", role: "student", note: "毕业想做解决方案,先练练", source: "xhs" },
  ]);
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("/waitlist:不带来源、只填邮箱;已经在名单里、暂停登记、太频繁各有提示", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  const responses = [
    { status: 200, json: { ok: true, alreadyJoined: true } },
    { status: 403, json: { error: { code: "forbidden", message: "候补名单暂停登记" } } },
    { status: 429, json: { error: { code: "rate_limited", message: "提交太频繁了,请 7 分钟后再试" } } },
  ];
  const bodies: unknown[] = [];
  await overrideJoin(page, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill(responses.shift()!);
  });

  await page.goto("/waitlist");
  const main = page.getByRole("main");
  await expect.poll(() => mock.events).toContainEqual({ type: "waitlist_viewed" });
  await main.getByLabel("邮箱").fill("early@example.com");
  await main.getByRole("button", { name: "加入候补名单" }).click();
  await expect(main.getByTestId("waitlist-done")).toContainText("已经在候补名单里了");
  expect(bodies).toEqual([{ email: "early@example.com" }]);

  await page.reload();
  await main.getByLabel("邮箱").fill("late@example.com");
  await main.getByRole("button", { name: "加入候补名单" }).click();
  await expect(main.getByRole("alert")).toHaveText("候补名单暂停登记");
  // 失败了表单还在,可以再试
  await main.getByRole("button", { name: "加入候补名单" }).click();
  await expect(main.getByRole("alert")).toHaveText("提交太频繁了,请 7 分钟后再试");
  await expect(main.getByTestId("waitlist-done")).toHaveCount(0);
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("管理页:候补名单展开才请求;合计、来源、名单与状态、CSV 链接", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "admin" });
  await mock.install(page);
  await page.goto("/admin");
  await expect(page.getByTestId("admin-stats")).toBeVisible();
  await expect(page.getByTestId("admin-feedback")).toBeVisible();

  const panel = page.getByTestId("waitlist-panel");
  const toggle = panel.getByRole("button", { name: "候补名单", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByTestId("waitlist-rows")).toHaveCount(0);
  expect(mock.callsTo("GET", WAITLIST_GET)).toHaveLength(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const rows = panel.getByTestId("waitlist-rows").locator("tbody tr");
  await expect(rows).toHaveCount(3);
  // next dev 的 StrictMode 会把挂载时的请求发两遍,这里只断言"展开后才有"
  expect(mock.callsTo("GET", WAITLIST_GET).length).toBeGreaterThan(0);

  const stats = panel.getByTestId("waitlist-stats");
  await expect(stats).toContainText("登记3");
  await expect(stats).toContainText("待邀请2");
  await expect(stats).toContainText("已邀请1");
  await expect(stats).toContainText("已注册1");
  await expect(panel.getByTestId("waitlist-sources")).toHaveText("xhs 2·(直接访问) 1");

  // 从早到晚;身份中文;状态
  await expect(rows.nth(0)).toContainText("early@example.com");
  await expect(rows.nth(0)).toContainText("想转 FDE,练练访谈");
  await expect(rows.nth(0)).toContainText("在职,想转 FDE");
  await expect(rows.nth(0)).toContainText("2026-10-05 15:00");
  await expect(rows.nth(0)).toContainText("已注册");
  await expect(rows.nth(1)).toContainText("在做 FDE / 解决方案");
  await expect(rows.nth(1)).toContainText("待邀请");
  await expect(rows.nth(2)).toContainText("third@example.com");
  await expect(rows.nth(2)).toContainText("—");
  // 已经邀请过的不能再勾
  await expect(panel.getByRole("checkbox", { name: "选择 early@example.com" })).toBeDisabled();
  await expect(panel.getByRole("checkbox", { name: "选择 second@example.com" })).toBeEnabled();

  const csv = panel.getByRole("link", { name: "导出 CSV" });
  await expect(csv).toHaveAttribute("href", "/api/admin/waitlist.csv");
  await expect(csv).toHaveAttribute("download", "");
  await expectNoHorizontalScroll(page, info);

  // 筛选:按 status 重新请求
  const invited = page.waitForRequest((r) => r.url().endsWith("/api/admin/waitlist?status=invited"));
  await panel.getByLabel("显示").selectOption({ label: "已邀请" });
  await invited;
  const pending = page.waitForRequest((r) => r.url().endsWith("/api/admin/waitlist?status=pending"));
  await panel.getByLabel("显示").selectOption({ label: "待邀请" });
  await pending;

  // 收起再展开会重新拉一次
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByTestId("waitlist-rows")).toHaveCount(0);
  const again = page.waitForRequest((r) => r.url().endsWith("/api/admin/waitlist?status=all"));
  await toggle.click();
  await again;
  await expect(rows).toHaveCount(3);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("管理页:邀请最早的 N 位与勾选邀请;没发邮件的能复制邀请码", async ({ page, context }, info) => {
  const errors = trackPageErrors(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const mock = new MockApi({ auth: "admin" });
  await mock.install(page);
  await page.goto("/admin");
  const panel = page.getByTestId("waitlist-panel");
  await panel.getByRole("button", { name: "候补名单", exact: true }).click();
  await expect(panel.getByTestId("waitlist-rows").locator("tbody tr")).toHaveCount(3);
  const loads = mock.callsTo("GET", WAITLIST_GET).length;

  // 人数不对:不弹确认、不发请求
  const count = panel.getByLabel("邀请人数");
  await count.fill("0");
  await panel.getByRole("button", { name: "邀请最早的 N 位" }).click();
  await expect(panel.getByText("人数应为 1–200 的整数")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 邀请最早的 2 位:先确认;取消就什么都不发
  await count.fill("2");
  await panel.getByRole("button", { name: "邀请最早的 2 位" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("给最早登记、还没邀请的 2 位发邀请码。");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.callsTo("POST", WAITLIST_INVITE)).toHaveLength(0);

  await panel.getByRole("button", { name: "邀请最早的 2 位" }).click();
  await dialog.getByRole("button", { name: "确定发送" }).click();
  const result = panel.getByTestId("waitlist-invited");
  await expect(result).toContainText("发出 2 个邀请码,其中 2 个没有发邮件");
  await expect(result.locator("li")).toHaveCount(2);
  await expect(result.locator("li").nth(0)).toContainText("second@example.com");
  await expect(result.locator("li").nth(0)).toContainText("WAIT2222");
  await expect(result.locator("li").nth(0)).toContainText("未发邮件");
  await expect(result.locator("li").nth(1)).toContainText("WAIT2223");
  expect(mock.callsTo("POST", WAITLIST_INVITE).map((c) => c.body)).toEqual([{ count: 2 }]);
  // 邀请完重新拉名单
  await expect.poll(() => mock.callsTo("GET", WAITLIST_GET).length).toBeGreaterThan(loads);

  await result.getByRole("button", { name: "复制 second@example.com 的邀请码" }).click();
  await expect(result.getByRole("button", { name: "复制 second@example.com 的邀请码" })).toHaveText("已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("WAIT2222");
  await expectNoHorizontalScroll(page, info);

  // 勾选邀请;这次假装邮件都发出了
  const selectedBodies: unknown[] = [];
  await page.route("**/api/admin/waitlist/invite", (route) => {
    const body = route.request().postDataJSON() as { emails: string[] };
    selectedBodies.push(body);
    return route.fulfill({ json: { invited: body.emails.map((email) => ({ email, inviteCode: "MAIL2345", mailed: true })) } });
  });
  const inviteSelected = panel.getByRole("button", { name: /^邀请选中的/ });
  await expect(inviteSelected).toBeDisabled();
  await panel.getByRole("checkbox", { name: "全选待邀请的" }).check();
  await expect(inviteSelected).toHaveText("邀请选中的(2)");
  await panel.getByRole("checkbox", { name: "选择 second@example.com" }).uncheck();
  await expect(inviteSelected).toHaveText("邀请选中的(1)");
  await inviteSelected.click();
  await expect(dialog).toContainText("给选中的 1 位发邀请码。");
  await dialog.getByRole("button", { name: "确定发送" }).click();
  await expect(result).toContainText("发出 1 个邀请码,邀请邮件都已发出。");
  await expect(result.locator("li")).toHaveCount(1);
  await expect(result.locator("li")).toContainText("third@example.com");
  await expect(result.locator("li")).toContainText("已发邮件");
  await expect(result.getByRole("button")).toHaveCount(0);
  expect(selectedBodies).toEqual([{ emails: ["third@example.com"] }]);
  // 发完清空勾选
  await expect(inviteSelected).toHaveText("邀请选中的(0)");
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});
