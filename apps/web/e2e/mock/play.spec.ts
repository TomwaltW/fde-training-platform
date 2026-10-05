// 对局页的细节:409 session_busy 提示、去现场不可用时置灰并说明、资料图片全屏左右翻、判断阶段锁输入。
import { expect, test } from "@playwright/test";
import type { ArtifactResponse, PublicView } from "@fde/contracts";
import { expectNoHorizontalScroll, showPanel, trackPageErrors } from "./helpers";
import { MockApi, SESSION_ID, fixture } from "./mock-api";

test("并发 409 session_busy 时提示「上一句还在处理」,并保留输入", async ({ page }) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi();
  mock.busyNext = true;
  await mock.install(page);
  await page.goto(`/play/${SESSION_ID}`);
  const composer = page.locator("#composer");
  await composer.fill("周总,最近出过什么事吗?");
  await composer.press("Enter");
  await expect(page.getByTestId("notices")).toContainText("上一句还在处理");
  await expect(composer).toHaveValue("周总,最近出过什么事吗?");
  await expect(composer).toBeEnabled();
  // 再发一次就正常了
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("chat-panel")).toContainText("最大客户拓浪");
  expect(errors).toEqual([]);
});

test("[去现场看看] 不可用时置灰并说明原因;[做个验证] 说明还没解锁的", async ({ page }) => {
  const mock = new MockApi(); // 刚开局:site_visit available=false,没有可做的验证,锁着 5 个
  await mock.install(page);
  await page.goto(`/play/${SESSION_ID}`);
  await expect(page.locator("#site-note")).toHaveText("去现场:现在还去不了:得先有人点头,或者有人带你过去。");
  await page.getByRole("button", { name: "去现场看看" }).click();
  const dialog = page.getByTestId("actions-dialog");
  await expect(dialog.getByRole("button", { name: "去", exact: true })).toBeDisabled();
  await expect(dialog).toContainText("现在还去不了");
  await dialog.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "做个验证" }).click();
  const exps = page.getByTestId("experiments-dialog");
  await expect(exps).toContainText("现在还没有能做的验证");
  await expect(exps.getByTestId("locked-experiments")).toHaveText("还有 5 个验证没解锁:拿到相应资料后才能做。");
  expect(mock.callsTo("POST", /\/actions$/)).toHaveLength(0);
});

test("资料查看器:已看过的资料不再记时间;图片全屏可左右翻,Esc 只关看图层", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const view = fixture<{ view: PublicView }>("action-open-response").view; // A1 已经看过
  const mock = new MockApi({ view });
  const a1 = fixture<ArtifactResponse>("artifact-A1");
  a1.artifact.files.push(
    { name: "04_bl_LT2609-0412.jpg", kind: "image", bytes: 380_000 },
    { name: "05_packing_LT2609-0412_v2.jpg", kind: "image", bytes: 401_000 },
  );
  mock.artifactOverride = a1;
  await mock.install(page);
  await page.goto(`/play/${SESSION_ID}`);
  await showPanel(page, info, "资料");
  await page.getByTestId("artifact-A1").click();
  const viewer = page.getByTestId("artifact-viewer");
  await expect(viewer).toContainText("图片(3)");
  expect(mock.callsTo("POST", /\/actions$/)).toHaveLength(0);

  await viewer.getByRole("button", { name: /查看图片 02_packing/ }).click();
  const counter = page.getByTestId("lightbox-counter");
  await expect(counter).toHaveText("1 / 3");
  await page.getByRole("button", { name: "下一张" }).click();
  await expect(counter).toHaveText("2 / 3");
  await expect(page.getByTestId("lightbox").getByRole("img")).toHaveAttribute("alt", "04_bl_LT2609-0412.jpg");
  await page.keyboard.press("ArrowRight");
  await expect(counter).toHaveText("3 / 3");
  await page.getByRole("button", { name: "下一张" }).click();
  await expect(counter).toHaveText("1 / 3");
  await page.getByRole("button", { name: "上一张" }).click();
  await expect(counter).toHaveText("3 / 3");
  await page.getByRole("button", { name: "看原图" }).click();
  await expect(page.getByRole("button", { name: "适应屏幕" })).toBeVisible();
  await expectNoHorizontalScroll(page, info);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("时间用完进入判断阶段:输入框锁住,提示先提交判断", async ({ page }) => {
  const view = fixture<{ view: PublicView }>("action-visit-response").view;
  view.phase = "judgment";
  view.minutesLeft = 0;
  const mock = new MockApi({ view });
  await mock.install(page);
  await page.goto(`/play/${SESSION_ID}`);
  await expect(page.getByTestId("time-left")).toHaveText("时间用完了");
  await expect(page.locator("#composer")).toBeDisabled();
  await page.getByRole("button", { name: "填写判断" }).click();
  await expect(page.getByTestId("judgment-dialog")).toBeVisible();
  // 只填一项也能交,但会提示还有几项空着
  await page.getByTestId("judgment-dialog").getByLabel(/真正的问题是什么/).fill("改单不同步");
  await expect(page.getByTestId("judgment-dialog")).toContainText("还有 4 项空着");
});

test("已经结束的对局:打开对局页直接收工生成复盘并跳转", async ({ page }) => {
  const mock = new MockApi({ view: fixture<{ view: PublicView }>("view-ended").view, finishDelayMs: 500 });
  await mock.install(page);
  await page.goto(`/play/${SESSION_ID}`);
  await expect(page.getByTestId("finishing")).toContainText("正在生成复盘,可能要几十秒");
  await expect(page).toHaveURL(new RegExp(`/report/${SESSION_ID}$`));
  await expect(page.getByTestId("report-total")).toHaveText("22");
  expect(mock.callsTo("POST", /\/finish$/)).toHaveLength(1);
});

test("没登录打开对局页会跳到登录页,并带上回跳地址", async ({ page }) => {
  const mock = new MockApi({ auth: "anon" });
  await mock.install(page);
  await page.goto(`/play/${SESSION_ID}`);
  await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fplay%2F${SESSION_ID}$`));
});
