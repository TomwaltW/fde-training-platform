// 第三轮:管理页的继续/转向/放弃看板(展开才请求、三关表格与状态文字、时间范围参数);
// 复盘页"如果有下一个场景,你想玩吗?"、report_viewed / share_card_saved / share_text_copied 事件、分享文字里没有真相。
import { expect, test, type Page } from "@playwright/test";
import type { FinishResponse, GatesResponse } from "@fde/contracts";
import { expectCompliance, expectNoHorizontalScroll, trackPageErrors } from "./helpers";
import { MockApi, SESSION_ID, fixture } from "./mock-api";

const GATES = /\/api\/admin\/gates(\?|$)/;

type Tracked = { type: string; sessionId?: string; props?: Record<string, unknown> };
const tracked = (mock: MockApi, type: string) => (mock.events as Tracked[]).filter((e) => e.type === type);

/** 剪贴板换成假的:成功时把文字记在 window.__copied;fail 为 true 时两种复制办法都失败。 */
async function fakeClipboard(page: Page, fail = false) {
  await page.addInitScript((fail: boolean) => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          if (fail) return Promise.reject(new Error("NotAllowedError"));
          w.__copied.push(t);
          return Promise.resolve();
        },
      },
    });
    if (fail) document.execCommand = () => false;
  }, fail);
}

test("管理页:看板展开才请求;三关表格、状态文字、其他数字;时间范围参数", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "admin" });
  await mock.install(page);
  // 记下每次请求的查询参数;带了时间范围的返回一份"不过"的数据,没带的交回 MockApi(fixture)
  const queries: string[] = [];
  await page.route(GATES, (route) => {
    const url = new URL(route.request().url());
    queries.push(url.search);
    if (!url.searchParams.has("since")) return route.fallback();
    const body = fixture<GatesResponse>("admin-gates");
    body.range = { since: url.searchParams.get("since"), until: url.searchParams.get("until") };
    Object.assign(body.gate2.find((m) => m.id === "dispute")!, { value: 0.5, display: "50%", numerator: 5, denominator: 10, status: "fail" });
    return route.fulfill({ json: body });
  });

  await page.goto("/admin");
  await expect(page.getByTestId("score-histogram")).toBeVisible();
  await expect(page.getByTestId("admin-feedback")).toBeVisible();
  const panel = page.getByTestId("gates-panel");
  const toggle = panel.getByRole("button", { name: /继续 \/ 转向 \/ 放弃/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByRole("table")).toHaveCount(0);
  expect(queries).toEqual([]);
  expect(mock.callsTo("GET", GATES)).toHaveLength(0);

  // ---- 展开:请求一次(不带时间范围)
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByTestId("gates-range")).toHaveText("范围:全部时间");
  expect(queries).toEqual([""]);

  const row = (id: string) => panel.getByTestId(`gate-${id}`);
  const status = (id: string) => row(id).locator("td").last();

  // 第一关
  const gate1 = panel.getByTestId("gates-gate1");
  await expect(gate1.getByRole("heading", { name: /第一关:兴趣/ })).toBeVisible();
  await expect(gate1.getByRole("columnheader")).toHaveText(["指标", "数值", "分子/分母", "门槛", "状态"]);
  await expect(row("waitlist_7d")).toContainText("首条内容 7 天内的候补名单人数");
  await expect(row("waitlist_7d")).toContainText("118 人");
  await expect(row("waitlist_7d")).toContainText("过 ≥100 人 · 修 30–100 人 · 不过 <30 人");
  await expect(status("waitlist_7d")).toHaveText("过");

  // 第二关:六项,过与修都有
  const gate2 = panel.getByTestId("gates-gate2");
  await expect(gate2.getByRole("heading", { name: /第二关:体验/ })).toBeVisible();
  await expect(gate2.locator("tbody tr")).toHaveCount(6);
  await expect(row("completion")).toContainText("45%");
  await expect(row("completion")).toContainText("9 / 20");
  await expect(row("completion")).toContainText("过 ≥40% · 修 20–40% · 不过 <20%");
  await expect(status("completion")).toHaveText("过");
  await expect(row("median_minutes")).toContainText("27 分钟");
  await expect(row("median_minutes")).toContainText("9 局");
  await expect(row("promoters")).toContainText("2 / 9");
  await expect(status("promoters")).toHaveText("修");
  await expect(status("want_next")).toHaveText("过");
  await expect(status("share")).toHaveText("修");
  await expect(status("dispute")).toHaveText("过");
  await expect(row("dispute")).toContainText("过 <20% · 修 20–40% · 不过 >40%");

  // 第三关:0 / 118,低于 2% → 不过
  const gate3 = panel.getByTestId("gates-gate3");
  await expect(gate3.getByRole("heading", { name: /第三关:付费/ })).toBeVisible();
  await expect(row("waitlist_to_paid")).toContainText("0 / 118");
  await expect(status("waitlist_to_paid")).toHaveText("不过");

  // 其他数字和门槛来源
  const extra = panel.getByTestId("gates-extra");
  await expect(extra).toContainText("2.4 秒");
  await expect(extra).toContainText("4.1 秒");
  await expect(extra).toContainText("48 秒");
  await expect(extra).toContainText("样本 7 人");
  await expect(panel).toContainText("门槛在 config/gates.yaml");
  await expectNoHorizontalScroll(page, info);

  // 收起再展开不重复请求
  await toggle.click();
  await expect(panel.getByRole("table")).toHaveCount(0);
  await toggle.click();
  await expect(panel.getByRole("table")).toHaveCount(3);
  expect(queries).toHaveLength(1);

  // ---- 时间范围:北京时间的日期 → ISO;结束日期含当天(until 是第二天 0 点)
  await panel.getByLabel("开始日期").fill("2026-10-01");
  await panel.getByLabel("结束日期(含当天)").fill("2026-10-07");
  await panel.getByRole("button", { name: "查询" }).click();
  await expect(panel.getByTestId("gates-range")).toHaveText("范围:2026-10-01 00:00 至 2026-10-08 00:00(不含)");
  const q = new URLSearchParams(queries[1]);
  expect(q.get("since")).toBe("2026-09-30T16:00:00.000Z");
  expect(q.get("until")).toBe("2026-10-07T16:00:00.000Z");
  await expect(row("dispute")).toContainText("50%");
  await expect(row("dispute")).toContainText("5 / 10");
  await expect(status("dispute")).toHaveText("不过");

  // 只填开始日期
  await panel.getByLabel("结束日期(含当天)").fill("");
  await panel.getByRole("button", { name: "查询" }).click();
  await expect(panel.getByTestId("gates-range")).toHaveText("范围:2026-10-01 00:00 至 现在");
  expect(Object.fromEntries(new URLSearchParams(queries[2]))).toEqual({ since: "2026-09-30T16:00:00.000Z" });

  // 清空日期:回到全部时间
  await panel.getByRole("button", { name: "清空日期" }).click();
  await expect(panel.getByTestId("gates-range")).toHaveText("范围:全部时间");
  expect(queries[3]).toBe("");
  await expect(status("dispute")).toHaveText("过");

  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("复盘页:想玩下一个场景、report_viewed、保存图片与复制分享文字的事件,分享文字里没有真相", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  await fakeClipboard(page);
  const mock = new MockApi({ reportReady: true });
  await mock.install(page);
  await page.goto(`/report/${SESSION_ID}`);
  await expect(page.getByTestId("report-total")).toHaveText("22");

  // 复盘加载成功后记一次 report_viewed
  await expect.poll(() => tracked(mock, "report_viewed")).toEqual([{ type: "report_viewed", sessionId: SESSION_ID }]);

  // 想玩下一个场景(在推荐意愿旁边)
  const wantNext = page.getByTestId("want-next");
  await expect(wantNext.getByRole("heading", { name: "如果有下一个场景,你想玩吗?" })).toBeVisible();
  await expectNoHorizontalScroll(page, info);
  await wantNext.getByRole("button", { name: "想", exact: true }).click();
  await expect(wantNext).toContainText("已收到,谢谢。");
  await expect(wantNext.getByRole("button")).toHaveCount(0);
  expect(mock.feedback).toEqual([{ wantNext: true }]);
  // 推荐意愿那块不受影响
  await expect(page.getByTestId("rating").getByRole("button", { name: "提交" })).toBeDisabled();

  // 保存图片
  const card = page.getByTestId("share-card");
  await expect(card.getByRole("img", { name: /分享卡:货代公司的「单据识别」,22 分/ })).toBeVisible();
  await card.getByRole("link", { name: "保存图片" }).click();
  await expect.poll(() => tracked(mock, "share_card_saved")).toEqual([{ type: "share_card_saved", sessionId: SESSION_ID }]);

  // 复制分享文字:只有场景名、总分、评语、站点地址和 AI 标识
  await card.getByRole("button", { name: "复制分享文字" }).click();
  await expect(card.getByRole("status")).toHaveText("已复制,可以粘贴到朋友圈或群聊。");
  await expect.poll(() => tracked(mock, "share_text_copied")).toEqual([{ type: "share_text_copied", sessionId: SESSION_ID }]);
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  const origin = new URL(page.url()).origin;
  expect(copied).toEqual([
    `我在 FDE 训练场玩了一局:货代公司的「单据识别」\n得分 22 / 100 · 接了一个会翻车的单\n可以翻车的客户现场,来试试:${origin}\n(内容由 AI 生成,不含剧情答案)`,
  ]);
  // 复盘正文"真相"一节里的任何一条都不能出现
  const markdown = fixture<FinishResponse>("finish-response").report.markdown;
  const truth = markdown.split("## 真相")[1]!.split("\n## ")[0]!;
  const truthLines = truth
    .split("\n")
    .map((l) => l.replace(/^[-*\s]+/, "").trim())
    .filter((l) => l.length >= 6);
  expect(truthLines.length).toBeGreaterThan(5);
  for (const line of truthLines) expect(copied[0]).not.toContain(line);
  for (const word of ["真相", "拓浪", "HS 编码", "改单", "自相矛盾", "年底前不加人"]) expect(copied[0]).not.toContain(word);

  // 事件只记了这几条,每种一次
  expect((mock.events as Tracked[]).map((e) => e.type).sort()).toEqual(["report_viewed", "share_card_saved", "share_text_copied"]);
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});

test("复盘页:不能自动复制时把文字摆出来、不记事件;想玩下一个场景提交失败可以重试", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  await fakeClipboard(page, true);
  const mock = new MockApi({ reportReady: true });
  await mock.install(page);
  // 第一次提交反馈被限频
  await page.route(
    /\/api\/reports\/[^/]+\/feedback$/,
    (route) => route.fulfill({ status: 429, json: { error: { code: "rate_limited", message: "操作太频繁,稍后再试" } } }),
    { times: 1 },
  );
  await page.goto(`/report/${SESSION_ID}`);
  await expect(page.getByTestId("report-total")).toHaveText("22");

  const card = page.getByTestId("share-card");
  await card.getByRole("button", { name: "复制分享文字" }).click();
  const manual = card.getByTestId("share-text-manual");
  await expect(manual).toContainText("请长按或选中下面的文字手动复制");
  const text = manual.getByRole("textbox", { name: "分享文字" });
  await expect(text).toHaveValue(/^我在 FDE 训练场玩了一局:货代公司的「单据识别」\n得分 22 \/ 100 · 接了一个会翻车的单\n/);
  await expect(text).not.toHaveValue(/真相|拓浪/);
  await expectNoHorizontalScroll(page, info);

  const wantNext = page.getByTestId("want-next");
  await wantNext.getByRole("button", { name: "不想" }).click();
  await expect(wantNext).toContainText("操作太频繁,稍后再试");
  await wantNext.getByRole("button", { name: "不想" }).click();
  await expect(wantNext).toContainText("已收到,谢谢。");
  expect(mock.feedback).toEqual([{ wantNext: false }]);

  await expect.poll(() => tracked(mock, "report_viewed")).toHaveLength(1);
  expect(tracked(mock, "share_text_copied")).toEqual([]);
  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});
