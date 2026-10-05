// mock e2e 共用的断言和小工具。
import { expect, type Page, type TestInfo } from "@playwright/test";

export const isMobile = (info: TestInfo) => info.project.name === "mobile";

/** 合规标识:页脚有 aiNotice、模型公示、备案号(未配置时"备案号:待填写")。 */
export async function expectCompliance(page: Page) {
  const footer = page.getByTestId("site-footer");
  await expect(footer.getByTestId("footer-ai-notice")).toBeVisible();
  await expect(footer.getByTestId("footer-ai-notice")).toContainText("对话内容由 AI 生成");
  await expect(footer.getByTestId("footer-model")).toContainText("通义千问 qwen-plus");
  await expect(footer.getByTestId("footer-icp")).toHaveText(/备案号/);
  await expect(footer.getByRole("link", { name: "用户协议" })).toBeVisible();
  await expect(footer.getByRole("link", { name: "隐私政策" })).toBeVisible();
}

/** 手机视口(390 宽)下不能有横向滚动。 */
export async function expectNoHorizontalScroll(page: Page, info: TestInfo) {
  if (!isMobile(info)) return;
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, "390 宽下页面不应横向滚动").toBeLessThanOrEqual(390);
}

/** 手机上点底部标签切面板;电脑上三栏都在,不用切。 */
export async function showPanel(page: Page, info: TestInfo, name: "对话" | "人物" | "资料") {
  if (!isMobile(info)) return;
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
}

/**
 * 收集页面里未捕获的异常和 console.error(React 的水合、key 等警告都走这里);测试结束时应该为空。
 * 接口按设计返回 4xx 时浏览器会打一条 "Failed to load resource",那是预期内的,不算。
 */
export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
    errors.push(text);
  });
  return errors;
}
