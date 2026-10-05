// 真后端:运营流程(只在电脑视口跑,见 playwright.config.ts 的 testIgnore)。
// 访客从带 ?from= 的链接进落地页登记候补名单 → 管理员在管理页勾选他发邀请码(没配 SMTP,页面上显示码)
// → 访客凭邀请码注册 → 管理页里他变成"已注册" → 方案 6.3 的看板里第一关数到了这次登记。
//
// 和其他 spec 共用一个服务和内存库,所有请求都来自 127.0.0.1(验证码接口按 IP 限频):
// 这里只发 2 次验证码请求(管理员、访客各 1 次)。
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { trackPageErrors } from "../mock/helpers";

const ADMIN = "admin-growth@e2e.test";
const VISITOR = "wl-visitor@e2e.test";

async function apiLogin(request: APIRequestContext, email: string) {
  const r1 = await request.post("/api/auth/request-code", { data: { email } });
  expect(r1.status(), await r1.text()).toBe(200);
  const { devCode } = (await r1.json()) as { devCode: string };
  expect((await request.post("/api/auth/verify", { data: { email, code: devCode } })).status()).toBe(200);
  expect((await request.post("/api/me/consent")).status()).toBe(200);
}

async function adminPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  await apiLogin(ctx.request, ADMIN);
  return ctx.newPage();
}

test("候补名单 → 管理员发邀请码 → 凭邀请码注册 → 看板计入", async ({ page, browser, baseURL }) => {
  const errors = trackPageErrors(page);

  // ---- 访客:落地页上的候补卡片(没登录才有),来源取链接里的 ?from=
  await page.goto("/?from=e2e");
  const card = page.getByTestId("waitlist-card");
  await card.getByLabel("邮箱").fill(VISITOR);
  await card.getByLabel("你的身份(选填)").selectOption({ label: "学生" });
  await card.getByRole("button", { name: "加入候补名单" }).click();
  await expect(card.getByTestId("waitlist-done")).toContainText("登记好了");
  // 同一个邮箱再登记一次:不报错,提示已经在名单里
  await page.goto("/waitlist");
  await page.getByRole("main").getByLabel("邮箱").fill(VISITOR);
  await page.getByRole("main").getByRole("button", { name: "加入候补名单" }).click();
  await expect(page.getByRole("main").getByTestId("waitlist-done")).toContainText("已经在候补名单里了");

  // ---- 管理员:展开候补名单,勾选这位访客发邀请码
  const admin = await adminPage(browser, baseURL);
  const adminErrors = trackPageErrors(admin);
  await admin.goto("/admin");
  const panel = admin.getByTestId("waitlist-panel");
  await panel.getByRole("button", { name: "候补名单", exact: true }).click();
  const row = panel.getByTestId("waitlist-rows").locator("tbody tr", { hasText: VISITOR });
  await expect(row).toContainText("e2e");
  await expect(row).toContainText("学生");
  await expect(row).toContainText("待邀请");
  await panel.getByRole("checkbox", { name: `选择 ${VISITOR}` }).check();
  await panel.getByRole("button", { name: /^邀请选中的/ }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "确定发送" }).click();
  const invited = panel.getByTestId("waitlist-invited").locator("li", { hasText: VISITOR });
  await expect(invited).toContainText("未发邮件");
  const inviteCode = (await invited.locator("code").textContent())!.trim();
  expect(inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  await expect(row).toContainText(`已邀请`);

  // CSV 导出里有这一行(带 BOM,公式注入防护在单元测试里)
  const csv = await admin.request.get("/api/admin/waitlist.csv");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain(`${VISITOR},student,`);

  // ---- 访客:凭邀请码注册(邀请码在验证通过时才消耗)
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(VISITOR);
  await page.getByLabel("邀请码").fill(inviteCode);
  await page.getByRole("button", { name: "发送验证码" }).click();
  const dev = page.getByTestId("dev-code");
  await expect(dev).toContainText(/\d{6}/);
  await page.getByLabel("验证码").fill((await dev.textContent())!.match(/\d{6}/)![0]);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("checkbox", { name: /用户协议/ }).check();
  await page.getByRole("checkbox", { name: /隐私政策/ }).check();
  await page.getByRole("button", { name: "同意并继续" }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  // 登录了就不再显示候补卡片
  await expect(page.getByTestId("scenario-card")).toBeVisible();
  await expect(page.getByTestId("waitlist-card")).toHaveCount(0);
  // 邀请码只能用一次
  const reuse = await page.request.post("/api/auth/request-code", { data: { email: "someone-else@e2e.test", inviteCode } });
  expect(reuse.status()).toBe(400);

  // ---- 管理员:名单里变成已注册;看板第一关数到这次登记
  await admin.reload();
  await panel.getByRole("button", { name: "候补名单", exact: true }).click();
  await expect(panel.getByTestId("waitlist-rows").locator("tbody tr", { hasText: VISITOR })).toContainText("已注册");
  const gates = admin.getByTestId("gates-panel");
  await gates.getByRole("button", { name: /继续 \/ 转向 \/ 放弃/ }).click();
  await expect(gates.getByTestId("gate-waitlist_7d")).toContainText("1 人");
  await expect(gates.getByTestId("gates-gate2")).toBeVisible();
  await expect(gates.getByTestId("gates-gate3")).toBeVisible();

  expect(errors).toEqual([]);
  expect(adminErrors).toEqual([]);
  await admin.context().close();
});
