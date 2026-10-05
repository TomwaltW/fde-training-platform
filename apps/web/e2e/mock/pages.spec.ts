// 每个页面:页脚有 aiNotice、模型公示、备案号;手机 390 宽下没有横向滚动。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectCompliance, expectNoHorizontalScroll, trackPageErrors } from "./helpers";
import { MockApi, SESSION_ID, type Auth } from "./mock-api";

const LEGAL_DIR = join(import.meta.dirname, "..", "..", "content", "legal");

const PAGES: { path: string; auth: Auth; ready: (page: Page) => Promise<void> }[] = [
  { path: "/", auth: "anon", ready: (p) => expect(p.getByTestId("scenario-card")).toBeVisible() },
  { path: "/login", auth: "anon", ready: (p) => expect(p.getByRole("heading", { name: "登录" })).toBeVisible() },
  { path: `/play/${SESSION_ID}`, auth: "user", ready: (p) => expect(p.getByTestId("time-left")).toBeVisible() },
  { path: `/report/${SESSION_ID}`, auth: "user", ready: (p) => expect(p.getByTestId("report-total")).toBeVisible() },
  { path: "/me", auth: "user", ready: (p) => expect(p.getByTestId("my-sessions")).toBeVisible() },
  { path: "/admin", auth: "admin", ready: (p) => expect(p.getByTestId("score-histogram")).toBeVisible() },
  { path: `/admin/sessions/${SESSION_ID}`, auth: "admin", ready: (p) => expect(p.getByTestId("admin-session")).toBeVisible() },
  { path: "/legal/terms", auth: "anon", ready: (p) => expect(p.getByTestId("legal-doc")).toBeVisible() },
  { path: "/legal/privacy", auth: "anon", ready: (p) => expect(p.getByTestId("legal-doc")).toBeVisible() },
  { path: "/legal/ai-notice", auth: "anon", ready: (p) => expect(p.getByTestId("legal-doc")).toBeVisible() },
];

for (const { path, auth, ready } of PAGES) {
  test(`合规标识与窄屏:${path}`, async ({ page }, info) => {
    const errors = trackPageErrors(page);
    const mock = new MockApi({ auth, reportReady: true });
    await mock.install(page);
    await page.goto(path);
    await ready(page);
    await expectCompliance(page);
    await expectNoHorizontalScroll(page, info);
    expect(mock.unhandled).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("页脚:模型与备案号未配置时显示待填写,配置了就显示", async ({ page }) => {
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  // 先覆盖 /api/site:模型公示和 ICP 都没配置
  await page.route("**/api/site", (route) =>
    route.fulfill({ json: { aiNotice: "对话内容由 AI 生成", modelDisclosure: null, icpNumber: null, publicSecurityNumber: null, inviteOnly: true } }),
  );
  await page.goto("/");
  const footer = page.getByTestId("site-footer");
  await expect(footer.getByTestId("footer-model")).toHaveText("模型备案信息:待填写");
  await expect(footer.getByTestId("footer-icp")).toHaveText("备案号:待填写");

  await page.unroute("**/api/site");
  await page.route("**/api/site", (route) =>
    route.fulfill({
      json: { aiNotice: "对话内容由 AI 生成", modelDisclosure: "通义千问 qwen-plus(备案号 Zhejiang-123)", icpNumber: "浙ICP备2026000001号", publicSecurityNumber: "浙公网安备 33010002000001号", inviteOnly: true },
    }),
  );
  await page.goto("/login");
  await expect(footer.getByTestId("footer-model")).toHaveText("所用模型:通义千问 qwen-plus(备案号 Zhejiang-123)");
  await expect(footer.getByTestId("footer-icp")).toContainText("备案号:浙ICP备2026000001号");
  await expect(footer.getByTestId("footer-icp")).toContainText("公安联网备案号:浙公网安备 33010002000001号");
});

test("协议页:读 content/legal/<slug>.md,文件不在时显示正在起草;不认识的 slug 是 404", async ({ page }) => {
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  for (const slug of ["terms", "privacy", "ai-notice"]) {
    await page.goto(`/legal/${slug}`);
    const doc = page.getByTestId("legal-doc");
    await expect(doc).toBeVisible();
    if (existsSync(join(LEGAL_DIR, `${slug}.md`))) await expect(doc).not.toContainText("该文档正在起草");
    else await expect(doc).toContainText("该文档正在起草");
  }
  const res = await page.goto("/legal/secret");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "没有这个页面" })).toBeVisible();
  await expectCompliance(page);
});
