// 截图:两个视口各截一张 /play/[id] 和 /report/[id](mock 数据)。
// 默认写进本次运行的输出目录(test-results/mock/…,被 .gitignore 忽略),并挂到报告上,跑完工作区不会有改动;
// 只有 UPDATE_SCREENSHOTS=1 时才覆盖仓库里提交的 e2e/mock/__screenshots__/(界面改了、要更新提交的截图时用)。
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { PublicView } from "@fde/contracts";
import { isMobile } from "./helpers";
import { MockApi, SESSION_ID, fixture } from "./mock-api";

const COMMITTED_DIR = join(import.meta.dirname, "__screenshots__");
const UPDATE = process.env.UPDATE_SCREENSHOTS === "1";

/** 截图存哪:默认是本测试的输出目录;UPDATE_SCREENSHOTS=1 时是仓库里的 __screenshots__/。 */
function shotPath(info: TestInfo, name: string): string {
  return UPDATE ? join(COMMITTED_DIR, name) : info.outputPath(name);
}

/** 截好的图挂到报告上(CI 的 HTML 报告里能直接看)。 */
async function attachShot(info: TestInfo, name: string, path: string) {
  await info.attach(name, { path, contentType: "image/png" });
}

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
  const name = `play-${info.project.name}.png`;
  const path = shotPath(info, name);
  await page.screenshot({ path });
  await attachShot(info, name, path);
});

test("截图:复盘页", async ({ page }, info) => {
  const mock = new MockApi({ reportReady: true });
  await mock.install(page);
  await page.goto(`/report/${SESSION_ID}`);
  await expect(page.getByTestId("report-total")).toHaveText("22");
  await expect(page.getByTestId("share-card").getByRole("img")).toBeVisible();
  await hideDevTools(page);
  const name = `report-${info.project.name}.png`;
  const path = shotPath(info, name);
  await page.screenshot({ path, fullPage: true, scale: "css" });
  await attachShot(info, name, path);
});
