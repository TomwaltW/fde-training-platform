// 手机号登录(第三轮 F4):smsLogin 关着时登录页和以前一样只有邮箱;开着时有"手机号 / 邮箱"两个入口(默认手机号),
// 手机号登录全流程;链接里的 ?invite=&email= 预填(候补名单的邀请邮件)。
// MockApi 的 request-code / verify 只认邮箱,这里用 page.route 覆盖带 phone 的请求(后注册的先匹配,不处理的交回 MockApi)。
import { expect, test, type Page } from "@playwright/test";
import type { Me, SiteInfo } from "@fde/contracts";
import { expectCompliance, expectNoHorizontalScroll, trackPageErrors } from "./helpers";
import { DEV_CODE, MockApi, fixture } from "./mock-api";

const PHONE_USER: Me = { id: "u-phone-1", email: null, phone: "+8613812345678", isAdmin: false, consentAt: null };

/** 打开手机号登录(覆盖 /api/site 的 smsLogin)。 */
async function enableSmsLogin(page: Page) {
  await page.route("**/api/site", (route) => route.fulfill({ json: { ...fixture<SiteInfo>("site"), smsLogin: true } }));
}

interface PhoneCall {
  path: "request-code" | "verify";
  body: Record<string, unknown>;
}

/** 带 phone 的 request-code / verify 由这里响应(邀请码只认 FDE-INVITE,验证码只认 DEV_CODE);其余交回 MockApi。 */
async function mockPhoneAuth(page: Page, mock: MockApi, opts: { requestCode?: { status: number; code: string; message: string } } = {}): Promise<PhoneCall[]> {
  const calls: PhoneCall[] = [];
  await page.route("**/api/auth/request-code", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    if (!body?.phone) return route.fallback();
    calls.push({ path: "request-code", body });
    if (opts.requestCode) return route.fulfill({ status: opts.requestCode.status, json: { error: { code: opts.requestCode.code, message: opts.requestCode.message } } });
    if (body.inviteCode !== undefined && body.inviteCode !== "FDE-INVITE") return route.fulfill({ status: 400, json: { error: { code: "invite_invalid", message: "邀请码无效或已用完" } } });
    return route.fulfill({ json: { ok: true, devCode: DEV_CODE } });
  });
  await page.route("**/api/auth/verify", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    if (!body?.phone) return route.fallback();
    calls.push({ path: "verify", body });
    if (body.code !== DEV_CODE) return route.fulfill({ status: 400, json: { error: { code: "code_invalid", message: "验证码错误或已过期" } } });
    // 新的手机号用户:还没同意协议(之后 /api/me/consent 由 MockApi 处理)
    mock.auth = "pending";
    return route.fulfill({ json: { user: PHONE_USER } });
  });
  return calls;
}

test("smsLogin 关:只有邮箱入口(和以前一样);?invite=&email= 预填到输入框", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await page.goto(`/login?invite=FDE-INVITE&email=${encodeURIComponent("first+tag@example.com")}`);
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  await expect(page.getByText("用邮箱收验证码登录,不用设密码。")).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByLabel("手机号")).toHaveCount(0);
  await expect(page.getByLabel("邮箱")).toHaveValue("first+tag@example.com");
  await expect(page.getByLabel("邀请码")).toHaveValue("FDE-INVITE");
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);

  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByTestId("dev-code")).toContainText(DEV_CODE);
  expect(mock.callsTo("POST", /^\/api\/auth\/request-code$/).at(-1)?.body).toEqual({ email: "first+tag@example.com", inviteCode: "FDE-INVITE" });
  await expect(page.getByRole("button", { name: "换个邮箱" })).toBeVisible();
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("smsLogin 开:手机号 / 邮箱两个入口,默认手机号;手机号登录全流程,同意协议后回到 next", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await enableSmsLogin(page);
  const calls = await mockPhoneAuth(page, mock);
  await page.goto("/login?next=/me");

  const tabs = page.getByRole("tablist", { name: "登录方式" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "手机号" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: "邮箱" })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByText("用手机号收短信验证码登录,不用设密码。")).toBeVisible();
  await expect(page.getByLabel("邮箱")).toHaveCount(0);
  const phone = page.getByLabel("手机号");
  await expect(phone).toHaveAttribute("type", "tel");
  await expect(phone).toHaveAttribute("inputmode", "numeric");
  await expect(phone).toHaveAttribute("autocomplete", "tel");
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);

  // 格式不对:不发请求
  await phone.fill("138 1234");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("手机号格式不对,请填 11 位大陆手机号");
  expect(calls).toHaveLength(0);

  // 邀请码不对:服务端的 invite_invalid
  await phone.fill("138-1234-5678");
  await page.getByLabel("邀请码").fill("WRONG");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("邀请码无效或已经用完。第一次登录需要有效的邀请码(买了兑换码的话,填兑换码也行)。");

  await page.getByLabel("邀请码").fill("FDE-INVITE");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByRole("heading", { name: "输入验证码" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("验证码已通过短信发到 13812345678,10 分钟内有效。");
  await expect(page.getByTestId("dev-code")).toContainText(DEV_CODE);
  expect(calls.at(-1)).toEqual({ path: "request-code", body: { phone: "13812345678", inviteCode: "FDE-INVITE" } });
  await expect(page.getByRole("button", { name: /秒后可以重发/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "换个手机号" })).toBeVisible();
  await expectNoHorizontalScroll(page, info);

  await page.getByLabel("验证码").fill("000000");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("验证码不对或已经过期");

  await page.getByLabel("验证码").fill(DEV_CODE);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  // 新用户的邀请码在校验时才消耗,所以校验也带着它
  expect(calls.at(-1)).toEqual({ path: "verify", body: { phone: "13812345678", code: DEV_CODE, inviteCode: "FDE-INVITE" } });

  await expect(page.getByRole("heading", { name: "开始之前" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("手机号或邮箱只用来发验证码和识别你的账号。");
  await expect(page.getByRole("main")).not.toContainText("不需要手机号");
  await page.getByRole("checkbox", { name: /用户协议/ }).check();
  await page.getByRole("checkbox", { name: /隐私政策/ }).check();
  await expectNoHorizontalScroll(page, info);
  await page.getByRole("button", { name: "同意并继续" }).click();
  await expect(page).toHaveURL(/\/me$/);
  expect(mock.callsTo("POST", /^\/api\/me\/consent$/)).toHaveLength(1);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("smsLogin 开 + ?invite=&email=:停在邮箱入口并预填;切到手机号邀请码还在;邮箱登录照常", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await enableSmsLogin(page);
  await mockPhoneAuth(page, mock);
  await page.goto(`/login?invite=WAIT2222&email=${encodeURIComponent("first@example.com")}`);

  const tabs = page.getByRole("tablist", { name: "登录方式" });
  await expect(tabs.getByRole("tab", { name: "邮箱" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("邮箱")).toHaveValue("first@example.com");
  await expect(page.getByLabel("邀请码")).toHaveValue("WAIT2222");
  await expectNoHorizontalScroll(page, info);

  // 切到手机号:邮箱输入框换成手机号,邀请码不变
  await tabs.getByRole("tab", { name: "手机号" }).click();
  await expect(tabs.getByRole("tab", { name: "手机号" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("手机号")).toHaveValue("");
  await expect(page.getByLabel("邀请码")).toHaveValue("WAIT2222");
  // 方向键在两个入口之间切换
  await tabs.getByRole("tab", { name: "手机号" }).press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "邮箱" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: "邮箱" })).toBeFocused();
  await expect(page.getByLabel("邮箱")).toHaveValue("first@example.com");

  // 邮箱入口照常走邮箱的请求(这个邀请码 mock 不认)
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("邀请码无效或已经用完。第一次登录需要有效的邀请码(买了兑换码的话,填兑换码也行)。");
  expect(mock.callsTo("POST", /^\/api\/auth\/request-code$/).at(-1)?.body).toEqual({ email: "first@example.com", inviteCode: "WAIT2222" });
  await expectCompliance(page);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("手机号:服务端限频(429)和短信发送失败(500)的说明原样显示", async ({ page }) => {
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await enableSmsLogin(page);
  await mockPhoneAuth(page, mock, { requestCode: { status: 429, code: "rate_limited", message: "这个手机号今天收验证码的次数用完了,明天再试,或者改用邮箱登录" } });
  await page.goto("/login");
  await page.getByLabel("手机号").fill("13812345678");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("这个手机号今天收验证码的次数用完了,明天再试,或者改用邮箱登录");

  await page.unroute("**/api/auth/request-code");
  await mockPhoneAuth(page, mock, { requestCode: { status: 500, code: "internal", message: "验证码短信没有发出去,请稍后再试,或者改用邮箱登录" } });
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("验证码短信没有发出去,请稍后再试,或者改用邮箱登录");
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
});
