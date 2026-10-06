// 主流程:落地页 → 登录(勾选同意)→ 开局 → 说一句话看到"正在说话"和回复 → 换人 → 要资料 →
// 打开资料查看器 → 去现场 → 提交判断 → 收工 → 复盘(雷达图、分享卡)→ 申诉一个维度 → 推荐意愿。
import { expect, test } from "@playwright/test";
import { expectCompliance, expectNoHorizontalScroll, isMobile, showPanel, trackPageErrors } from "./helpers";
import { DEV_CODE, MockApi, SESSION_ID } from "./mock-api";

test("完整一局:从落地页走到复盘和申诉", async ({ page }, info) => {
  const errors = trackPageErrors(page);
  const mock = new MockApi({ auth: "anon", turnDelayMs: 1200, finishDelayMs: 800 });
  await mock.install(page);
  // 新用户:还没有任何对局(fixtures 里的对局列表是老用户的)
  await page.route("**/api/sessions", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { sessions: [] } }) : r.fallback()));

  // ---- 落地页
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "可以翻车的客户现场" })).toBeVisible();
  await expect(page.getByTestId("scenario-card")).toContainText("货代公司的「单据识别」");
  await expect(page.getByTestId("scenario-card")).toContainText("我们单据太多了");
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);
  await page.getByRole("button", { name: "开始这一局" }).click();

  // ---- 登录(没登录开局 → 401 → 登录页,回跳地址带着选好的场景)
  await expect(page).toHaveURL(/\/login\?next=%2F%3Fstart%3Dfreight-docs$/);
  await expectCompliance(page);
  await page.getByLabel("邮箱").fill("player@example.com");
  await page.getByLabel("邀请码").fill("FDE-INVITE");
  await expectNoHorizontalScroll(page, info);
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByTestId("dev-code")).toContainText(DEV_CODE);
  expect(mock.callsTo("POST", /^\/api\/auth\/request-code$/)[0]?.body).toEqual({ email: "player@example.com", inviteCode: "FDE-INVITE" });
  await page.getByLabel("验证码").fill(DEV_CODE);
  await page.getByRole("button", { name: "登录", exact: true }).click();

  // 首次登录必须勾选同意两份文件
  await expect(page.getByRole("heading", { name: "开始之前" })).toBeVisible();
  const agree = page.getByRole("button", { name: "同意并继续" });
  await expect(agree).toBeDisabled();
  await page.getByRole("checkbox", { name: /用户协议/ }).check();
  await expect(agree).toBeDisabled();
  await page.getByRole("checkbox", { name: /隐私政策/ }).check();
  await expectNoHorizontalScroll(page, info);
  await agree.click();
  await expect.poll(() => mock.callsTo("POST", /^\/api\/me\/consent$/).length).toBe(1);

  // ---- 回到落地页后直接开局(不用再点一次)
  await expect(page).toHaveURL(new RegExp(`/play/${SESSION_ID}$`));
  expect(mock.callsTo("POST", /^\/api\/sessions$/)).toHaveLength(2);

  // ---- 对局页
  await expect(page.getByTestId("time-left")).toHaveText("今天还剩 6 小时");
  await expect(page.getByTestId("current-role")).toContainText("周总");
  await expect(page.getByTestId("ai-badge")).toHaveText("对话内容由 AI 生成");
  await expect(page.getByTestId("chat-panel")).toContainText("下个月行业大会我要拿出来讲");
  if (isMobile(info)) await expect(page.getByTestId("mobile-hint")).toContainText("在电脑上玩更顺手,进度会自动保存");
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);

  // 说一句话:等待时显示"周总正在说话…",输入框禁用,回复出来后消失
  const composer = page.locator("#composer");
  const first = "周总您好。为什么现在想做这件事?最近出过什么事吗?";
  await composer.fill(first);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("typing")).toHaveText(/周总正在说话…/);
  await expect(page.getByTestId("pending-line")).toHaveText(first);
  await expect(composer).not.toBeEditable();
  await expect(page.getByTestId("chat-panel").locator('[data-speaker="npc"]').last()).toContainText("最大客户拓浪");
  await expect(page.getByTestId("typing")).toHaveCount(0);
  await expect(page.getByTestId("time-left")).toHaveText("今天还剩 5 小时 52 分");
  expect(mock.callsTo("POST", /\/turns$/)[0]?.body).toEqual({ text: first });

  // 换人:点人物 = switch_role
  await showPanel(page, info, "人物");
  const people = page.getByTestId("people-panel");
  await expect(people.getByTestId("person-zhou")).toHaveAttribute("aria-current", "true");
  await people.getByTestId("person-lin").click();
  await expect(page.getByTestId("current-role")).toContainText("小林");
  expect(mock.callsTo("POST", /\/actions$/).at(-1)?.body).toEqual({ type: "switch_role", role: "lin" });
  await showPanel(page, info, "人物");
  await expect(people.getByTestId("person-lin")).toHaveAttribute("aria-current", "true");
  await expect(people).toContainText("刘姐");
  await showPanel(page, info, "对话");

  // [要资料] 往输入框填一句,发出去拿到样本包
  await page.getByRole("button", { name: "要资料" }).click();
  await expect(composer).toHaveValue("能给我看看相关的资料吗?");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTestId("typing")).toHaveText(/小林正在说话…/);
  await expect(page.getByTestId("notices")).toContainText("拿到资料:「样本单据包(14 份)」");

  // 打开资料:open_artifact 动作 + GET artifact 列文件
  await showPanel(page, info, "资料");
  await page.getByTestId("artifact-A1").click();
  const viewer = page.getByTestId("artifact-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "样本单据包(14 份)" })).toBeVisible();
  expect(mock.callsTo("POST", /\/actions$/).at(-1)?.body).toEqual({ type: "open_artifact", artifact: "A1" });
  expect(mock.callsTo("GET", /\/artifacts\/A1$/)).toHaveLength(1);
  const pdf = viewer.getByRole("link", { name: "新标签页打开" });
  await expect(pdf).toHaveAttribute("target", "_blank");
  await expect(pdf).toHaveAttribute("href", `/api/sessions/${SESSION_ID}/artifacts/A1/files/01_invoice_LT2609-0387.pdf`);
  await expect(viewer.getByRole("link", { name: "下载" })).toHaveAttribute("download", "03_import_template.xlsx");
  await expectNoHorizontalScroll(page, info);
  // 图片全屏查看
  await viewer.getByRole("button", { name: /查看图片 02_packing_LT2609-0387\.jpg/ }).click();
  const lightbox = page.getByTestId("lightbox");
  await expect(lightbox).toBeVisible();
  await expect(page.getByTestId("lightbox-counter")).toHaveText("1 / 1");
  await expect(lightbox.getByRole("img", { name: "02_packing_LT2609-0387.jpg" })).toBeVisible();
  await lightbox.getByRole("button", { name: "关闭图片" }).click();
  await expect(lightbox).toHaveCount(0);
  await viewer.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await showPanel(page, info, "资料");
  await expect(page.getByTestId("artifact-A1")).toContainText("看过了");

  // [去现场看看]:动作对话框里点"去"
  await showPanel(page, info, "对话");
  await page.getByRole("button", { name: "去现场看看" }).click();
  const actions = page.getByTestId("actions-dialog");
  await expect(actions).toContainText("去操作部现场看半小时");
  await actions.getByRole("button", { name: "去", exact: true }).click();
  await expect(page.getByTestId("chat-panel")).toContainText("单证组十几个工位挨着");
  await expect(page.getByTestId("notices")).toContainText("新认识:小陈(单证员,2 年)");
  expect(mock.callsTo("POST", /\/actions$/).at(-1)?.body).toEqual({ type: "action", action: "site_visit" });

  // [做个验证]:列出可做的验证,并说明还有几个没解锁
  await page.getByRole("button", { name: "做个验证" }).click();
  const exps = page.getByTestId("experiments-dialog");
  await expect(exps).toContainText("用样本包做一次识别测试");
  await expect(exps).toContainText("抽 30 票做发票、装箱单、提单交叉核对");
  await expect(exps.getByTestId("locked-experiments")).toHaveText("还有 3 个验证没解锁:拿到相应资料后才能做。");
  await exps.getByRole("button", { name: "关闭" }).click();

  // [我的判断是…]:五项表单 → submit_judgment
  await page.getByRole("button", { name: "我的判断是…" }).click();
  const judgment = page.getByTestId("judgment-dialog");
  const answers: Record<string, string> = {
    J1: "改单不同步和资料自相矛盾,其次是 HS 归类",
    J2: "样本包里 LT2609-0387 发票 1200 件、装箱单 1150 件",
    J3: "大会能演示,拓浪不再被查验,年底前不加人",
    J4: "先做三单一致性校验和改单同步;验收看异常件数;不做全自动识别",
    J5: "各类错误的金额分布还要找财务核对",
  };
  await judgment.getByLabel(/真正的问题是什么/).fill(answers.J1!);
  await judgment.getByLabel(/你的证据/).fill(answers.J2!);
  await judgment.getByLabel(/「做成」对周总意味着什么/).fill(answers.J3!);
  await judgment.getByLabel(/建议的第一步/).fill(answers.J4!);
  await judgment.getByLabel(/还不确定/).fill(answers.J5!);
  await expectNoHorizontalScroll(page, info);
  await judgment.getByRole("button", { name: "提交判断" }).click();
  await expect(page.getByRole("button", { name: "已提交判断" })).toBeDisabled();
  await expect(page.getByTestId("chat-panel")).toContainText("说吧,到底怎么回事?");
  expect(mock.callsTo("POST", /\/actions$/).at(-1)?.body).toEqual({ type: "submit_judgment", form: answers });

  // [收工]:确认 → end 动作 → POST finish(显示"正在生成复盘")→ 跳复盘页
  await page.getByRole("button", { name: "收工", exact: true }).click();
  await page.getByTestId("end-dialog").getByRole("button", { name: "收工,看复盘" }).click();
  await expect(page.getByTestId("finishing")).toContainText("正在生成复盘,可能要几十秒");
  await expect(page).toHaveURL(new RegExp(`/report/${SESSION_ID}$`));
  expect(mock.callsTo("POST", /\/actions$/).at(-1)?.body).toEqual({ type: "end" });
  expect(mock.callsTo("POST", /\/finish$/)).toHaveLength(1);

  // ---- 复盘页
  await expect(page.getByTestId("report-total")).toHaveText("22");
  await expect(page.getByTestId("report-band")).toHaveText("接了一个会翻车的单");
  await expect(page.getByTestId("radar-chart")).toBeVisible();
  await expect(page.getByTestId("radar-chart").locator("polygon")).toHaveCount(5);
  await expect(page.getByTestId("dimensions").locator("li[data-testid^=dimension-]")).toHaveCount(7);
  await expect(page.getByTestId("report-markdown").getByRole("heading", { name: "真相" })).toBeVisible();
  const card = page.getByTestId("share-card");
  await expect(card.getByRole("img", { name: /分享卡:货代公司的「单据识别」,22 分/ })).toBeVisible();
  await expect(card.getByRole("link", { name: "保存图片" })).toHaveAttribute("download", /\.png$/);
  await expect(page.getByTestId("ai-badge")).toHaveText("本复盘由 AI 生成,仅供训练参考。");
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);

  // 申诉一个维度
  const d3 = page.getByTestId("dimension-D3");
  await d3.getByRole("button", { name: "我不同意:提问与访谈质量" }).click();
  await d3.getByLabel(/为什么不同意/).fill("我第 2 轮问了出错记录在谁那儿");
  await d3.getByRole("button", { name: "提交申诉" }).click();
  await expect(d3).toContainText("已提交申诉");
  expect(mock.feedback).toContainEqual({ dispute: { dimension: "D3", reason: "我第 2 轮问了出错记录在谁那儿" } });

  // 推荐意愿 0–10
  const rating = page.getByTestId("rating");
  await rating.getByRole("radio", { name: "8" }).click();
  await rating.getByRole("button", { name: "提交" }).click();
  await expect(rating).toContainText("收到,谢谢。");
  expect(mock.feedback).toContainEqual({ rating: 8 });

  expect(mock.unhandled).toEqual([]);
  expect(errors).toEqual([]);
});
