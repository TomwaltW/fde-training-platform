// 截图:两个视口各截一张 /play/[id] 和 /report/[id](mock 数据),存到 e2e/mock/__screenshots__/ 并提交进仓库。
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { PublicView } from "@fde/contracts";
import { isMobile } from "./helpers";
import { MockApi, SESSION_ID, fixture } from "./mock-api";

const DIR = join(import.meta.dirname, "__screenshots__");

/** 截图里不要 next dev 的开发指示器。 */
async function hideDevTools(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

test("截图:对局页", async ({ page }, info) => {
  // 用去过现场之后的视图:人多、资料多、有旁白,能看出三种消息样式
  const mock = new MockApi({ view: fixture<{ view: PublicView }>("action-visit-response").view });
  await mock.install(page);
  await page.goto(`/play/${SESSION_ID}`);
  await expect(page.getByTestId("time-left")).toHaveText("今天还剩 4 小时 34 分");
  if (isMobile(info)) await page.getByTestId("mobile-hint").getByRole("button", { name: "知道了" }).click();
  await page.locator("#composer").fill("刘姐您好,Q3 出错的记录在您这儿吗?能看看吗?");
  await hideDevTools(page);
  // 等滚动动画结束
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(DIR, `play-${info.project.name}.png`) });
});

test("截图:复盘页", async ({ page }, info) => {
  const mock = new MockApi({ reportReady: true });
  await mock.install(page);
  await page.goto(`/report/${SESSION_ID}`);
  await expect(page.getByTestId("report-total")).toHaveText("22");
  await expect(page.getByTestId("share-card").getByRole("img")).toBeVisible();
  await hideDevTools(page);
  await page.screenshot({ path: join(DIR, `report-${info.project.name}.png`), fullPage: true, scale: "css" });
});
