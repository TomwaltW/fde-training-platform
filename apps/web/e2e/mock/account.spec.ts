// 登录的错误提示、老用户不填邀请码、我的对局与删除数据、管理页。
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, trackPageErrors } from "./helpers";
import { DEV_CODE, MockApi, SESSION_ID } from "./mock-api";

test("登录:邀请码无效、验证码错误有提示;老用户不填邀请码,已同意过协议直接回去", async ({ page }) => {
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await page.goto("/login?next=/me");
  await page.getByLabel("邮箱").fill("player@example.com");
  await page.getByLabel("邀请码").fill("WRONG");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("邀请码无效或已经用完。第一次登录需要有效的邀请码。");

  // 老用户:不填邀请码,请求体里不带 inviteCode
  await page.getByLabel("邀请码").fill("");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByTestId("dev-code")).toContainText(DEV_CODE);
  expect(mock.callsTo("POST", /request-code$/).at(-1)?.body).toEqual({ email: "player@example.com" });
  await expect(page.getByRole("button", { name: /秒后可以重发/ })).toBeDisabled();

  await page.getByLabel("验证码").fill("000000");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("验证码不对或已经过期");

  // 老用户已经同意过协议:登录后直接回到 next
  mock.auth = "user";
  await page.getByLabel("验证码").fill(DEV_CODE);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
});

test("没同意协议就开局(403 consent_required)会去登录页的同意步骤", async ({ page }) => {
  const mock = new MockApi({ auth: "pending" });
  await mock.install(page);
  await page.goto("/");
  await page.getByRole("button", { name: "开始这一局" }).click();
  await expect(page.getByRole("heading", { name: "开始之前" })).toBeVisible();
  await page.getByRole("checkbox", { name: /用户协议/ }).check();
  await page.getByRole("checkbox", { name: /隐私政策/ }).check();
  await page.getByRole("button", { name: "同意并继续" }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  await page.getByRole("button", { name: "开始这一局" }).click();
  await expect(page).toHaveURL(new RegExp(`/play/${SESSION_ID}$`));
});

test("开局超过每日限额(429)显示服务端的说明", async ({ page }) => {
  const mock = new MockApi({ auth: "user" });
  await mock.install(page);
  await page.route("**/api/sessions", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 429, json: { error: { code: "rate_limited", message: "今天的 3 局已经用完了,明天再来" } } }) : route.fallback(),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "开始这一局" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("今天的 3 局已经用完了,明天再来");
});

test("我的对局:接着玩、看复盘、删除全部对局、退出登录", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "user" });
  await mock.install(page);
  await page.goto("/me");
  const list = page.getByTestId("my-sessions");
  await expect(list.getByRole("link", { name: "看复盘" })).toHaveAttribute("href", "/report/s-fixture-0001");
  await expect(list.getByRole("link", { name: "接着玩" })).toHaveAttribute("href", "/play/s-fixture-0002");
  await expect(list).toContainText("22 分");
  await expectNoHorizontalScroll(page, info);

  await page.getByRole("button", { name: "删除我的全部对局" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确定删除" }).click();
  await expect(page.getByText("已删除 2 局对局和复盘。")).toBeVisible();
  expect(mock.callsTo("DELETE", /^\/api\/me\/data$/)).toHaveLength(1);

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  expect(mock.callsTo("POST", /^\/api\/auth\/logout$/)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("管理页:非管理员显示没有权限", async ({ page }) => {
  const mock = new MockApi({ auth: "user" });
  await mock.install(page);
  await page.goto("/admin");
  await expect(page.getByTestId("admin-forbidden")).toContainText("没有权限");
  expect(mock.callsTo("GET", /^\/api\/admin\//)).toHaveLength(0);
});

test("管理页:统计卡片、分数直方图、流失轮次、对局详情、生成邀请码、反馈", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "admin" });
  await mock.install(page);
  await page.goto("/admin");
  const stats = page.getByTestId("admin-stats");
  await expect(stats).toContainText("20 / 9");
  await expect(stats).toContainText("45%");
  await expect(stats).toContainText("¥7.42");
  await expect(page.getByTestId("score-histogram").locator("path")).toHaveCount(8);
  await expect(page.getByTestId("dropoff")).toContainText("第 3 轮");
  await expect(page.getByTestId("admin-feedback")).toContainText("周总记账那段很真实");
  await expect(page.getByTestId("admin-feedback")).toContainText("我问了很多量化问题");
  await expectNoHorizontalScroll(page, info);

  // 生成邀请码
  await page.getByLabel("数量").fill("3");
  await page.getByLabel("备注(选填)").fill("内测第一批");
  await page.getByRole("button", { name: "生成", exact: true }).click();
  await expect(page.getByTestId("invite-codes").locator("li")).toHaveCount(3);
  expect(mock.callsTo("POST", /^\/api\/admin\/invites$/)[0]?.body).toEqual({ count: 3, maxUses: 1, note: "内测第一批" });

  // 对局详情:对话、事件、账本、复盘、反馈、模型调用
  await page.getByTestId("admin-sessions").getByRole("link", { name: "详情" }).click();
  await expect(page).toHaveURL(/\/admin\/sessions\/s-fixture-0001$/);
  const detail = page.getByTestId("admin-session");
  await expect(detail).toContainText("player@example.com");
  await expect(detail).toContainText("最大客户拓浪");
  await detail.getByRole("tab", { name: "事件" }).click();
  await expect(detail).toContainText("auth_grant");
  await detail.getByRole("tab", { name: "账本" }).click();
  await expect(detail).toContainText("账本是空的");
  await detail.getByRole("tab", { name: "复盘" }).click();
  await expect(detail).toContainText("22 分 · 接了一个会翻车的单");
  await detail.getByRole("tab", { name: "反馈" }).click();
  await expect(detail).toContainText("推荐意愿:8 / 10");
  await detail.getByRole("tab", { name: "模型调用" }).click();
  await expect(detail).toContainText("qwen-plus");
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});
