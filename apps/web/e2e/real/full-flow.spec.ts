// 真后端从登录走到复盘:不拦截接口,浏览器打到 standalone 产物(离线引擎 + MemoryStore,见 serve.mjs)。
// 管理员首次登录(不要邀请码)→ 生成邀请码 → 新玩家凭邀请码登录、同意协议 → 开局 → 说话、换人、拿资料、
// 看真实的单据文件 → 去现场 → 做验证 → 提交判断 → 收工 → 复盘、申诉、打分 → 我的对局 → 管理页看到这一局 → 删除数据。
// 一路上记下所有接口响应,收工前不能出现真相(诊断结论)和引擎内部字段。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { parse } from "yaml";
import { expectCompliance, expectNoHorizontalScroll, isMobile, showPanel, trackPageErrors } from "../mock/helpers";

const scenario = parse(readFileSync(join(import.meta.dirname, "../../../../scenarios/freight-docs/scenario.yaml"), "utf8")) as {
  truth: { diagnosis_items: { statement: string }[] };
  traps: { id: string; beat: string }[];
};
/** 收工前任何接口响应里都不能出现的:真相里的诊断结论、压力时刻的导演说明(含"红鲱鱼"这类作者注)。 */
const TRUTH = [...scenario.truth.diagnosis_items.map((d) => d.statement), ...scenario.traps.map((t) => t.beat), "红鲱鱼"];
/** 引擎内部状态的字段名(PublicView 里不该有)。 */
const INTERNAL_KEYS = ["truth", "facts", "ledger", "trust", "directive", "guardFlags", "flags", "traps"];

const FIRST = "周总您好,我不是来追责的。为什么现在想做这件事?最近出过什么事吗?";
const ASK_LIN = "小林你好,周总说样本单据在你这儿,能给我看看吗?";
const ASK_VISIT = "周总,能不能让我去操作部现场看半小时?";

/** 登录页:填邮箱(和邀请码)→ 发验证码 → 读开发模式回显的验证码 → 登录 → 勾选同意。 */
async function loginViaUi(page: Page, email: string, inviteCode?: string) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  if (inviteCode) await page.getByLabel("邀请码").fill(inviteCode);
  await page.getByRole("button", { name: "发送验证码" }).click();
  const dev = page.getByTestId("dev-code");
  await expect(dev).toContainText(/\d{6}/);
  const code = (await dev.textContent())!.match(/\d{6}/)![0];
  await page.getByLabel("验证码").fill(code);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "开始之前" })).toBeVisible();
  await page.getByRole("checkbox", { name: /用户协议/ }).check();
  await page.getByRole("checkbox", { name: /隐私政策/ }).check();
  await page.getByRole("button", { name: "同意并继续" }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
}

/** 接口登录(不走页面),用来造一个"别人"。 */
async function loginViaApi(request: APIRequestContext, email: string, inviteCode: string) {
  const r1 = await request.post("/api/auth/request-code", { data: { email, inviteCode } });
  expect(r1.status()).toBe(200);
  const { devCode } = (await r1.json()) as { devCode?: string };
  expect(devCode).toMatch(/^\d{6}$/);
  // 新用户的邀请码在验证通过时才消耗,所以校验时也要带上
  expect((await request.post("/api/auth/verify", { data: { email, code: devCode, inviteCode } })).status()).toBe(200);
  expect((await request.post("/api/me/consent")).status()).toBe(200);
}

async function newDesktopPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  return ctx.newPage();
}

test("真后端:管理员发邀请码 → 玩家登录、玩一局、看复盘 → 管理员看到这一局 → 玩家删除数据", async ({ page, browser, baseURL }, info) => {
  const tag = info.project.name;
  const adminEmail = `admin-${tag}@e2e.test`;
  const playerEmail = `player-${tag}@e2e.test`;
  const otherEmail = `other-${tag}@e2e.test`;

  // ---- 管理员:首次登录不需要邀请码,生成两个邀请码(一个给玩家,一个给"别人")
  const admin = await newDesktopPage(browser);
  const adminErrors = trackPageErrors(admin);
  await loginViaUi(admin, adminEmail);
  await admin.goto("/admin");
  await expect(admin.getByTestId("admin-stats")).toBeVisible();
  await admin.getByLabel("数量").fill("2");
  await admin.getByLabel("备注(选填)").fill(`e2e ${tag}`);
  await admin.getByRole("button", { name: "生成", exact: true }).click();
  const codes = admin.getByTestId("invite-codes").locator("li");
  await expect(codes).toHaveCount(2);
  const [invite, otherInvite] = (await codes.allTextContents()).map((c) => c.trim());
  expect(invite).toMatch(/^[A-Z2-9]{8}$/);

  // ---- 玩家:没有邀请码登录不了;凭邀请码登录并同意协议
  const errors = trackPageErrors(page);
  const bodies: { url: string; text: string }[] = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/") || !(res.headers()["content-type"] ?? "").includes("json")) return;
    bodies.push({ url: res.url(), text: await res.text().catch(() => "") });
  });

  await page.goto("/login");
  await page.getByLabel("邮箱").fill(playerEmail);
  await page.getByRole("button", { name: "发送验证码" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("邀请码");
  await loginViaUi(page, playerEmail, invite);

  // ---- 落地页开局
  await expect(page.getByTestId("scenario-card")).toContainText("货代公司的「单据识别」");
  await expectCompliance(page);
  await page.getByRole("button", { name: "开始这一局" }).click();
  await expect(page).toHaveURL(/\/play\/[^/]+$/);
  const sessionId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByTestId("current-role")).toContainText("周总");
  await expect(page.getByTestId("time-left")).toHaveText("今天还剩 6 小时");
  await expect(page.getByTestId("ai-badge")).toHaveText("对话内容由 AI 生成");
  if (isMobile(info)) await page.getByTestId("mobile-hint").getByRole("button", { name: "知道了" }).click();
  await expectNoHorizontalScroll(page, info);

  const composer = page.locator("#composer");
  const npcLines = page.getByTestId("chat-panel").locator('[data-speaker="npc"]');
  const say = async (text: string) => {
    const before = await npcLines.count();
    await composer.fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(npcLines).toHaveCount(before + 1);
    await expect(composer).toBeEnabled();
  };

  // 第一句:关键词闸门 + 模板演员,周总说出拓浪的事
  await say(FIRST);
  await expect(npcLines.last()).toContainText("拓浪");
  await expect(page.getByTestId("time-left")).not.toHaveText("今天还剩 6 小时");

  // 换人找小林要样本单据
  await showPanel(page, info, "人物");
  await page.getByTestId("people-panel").getByTestId("person-lin").click();
  await expect(page.getByTestId("current-role")).toContainText("小林");
  await showPanel(page, info, "对话");
  await say(ASK_LIN);
  await expect(page.getByTestId("notices")).toContainText("拿到资料:「样本单据包(14 份)」");

  // 资料查看器:列出磁盘上真实的 14 个文件(9 张图、3 个 pdf、2 个 xlsx),图片和 pdf 真的能下下来
  await showPanel(page, info, "资料");
  await page.getByTestId("artifact-A1").click();
  const viewer = page.getByTestId("artifact-viewer");
  await expect(viewer.getByRole("heading", { name: "样本单据包(14 份)" })).toBeVisible();
  await expect(viewer.getByRole("button", { name: /^查看图片 / })).toHaveCount(9);
  await expect(viewer.getByRole("link", { name: "新标签页打开" })).toHaveCount(3);
  await expect(viewer.getByRole("link", { name: "下载" })).toHaveCount(2);
  await viewer.getByRole("button", { name: "查看图片 LT2609-0387_invoice_photo.jpg" }).click();
  const photo = page.getByTestId("lightbox").getByRole("img", { name: "LT2609-0387_invoice_photo.jpg" });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(500);
  await page.getByTestId("lightbox").getByRole("button", { name: "关闭图片" }).click();
  const pdfHref = await viewer.getByRole("link", { name: "新标签页打开" }).first().getAttribute("href");
  const pdf = await page.request.get(pdfHref!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await viewer.getByRole("button", { name: "关闭", exact: true }).click();

  // 还没拿到的资料:403;不存在的文件名(含路径穿越):404
  expect((await page.request.get(`/api/sessions/${sessionId}/artifacts/A8`)).status()).toBe(403);
  expect((await page.request.get(`/api/sessions/${sessionId}/artifacts/A1/files/..%2F..%2Fscenario.yaml`)).status()).toBe(404);

  // 回去找周总,请他同意去现场:旁白、新认识小陈、拿到 FMS 截图
  await showPanel(page, info, "人物");
  await page.getByTestId("people-panel").getByTestId("person-zhou").click();
  await expect(page.getByTestId("current-role")).toContainText("周总");
  await showPanel(page, info, "对话");
  await say(ASK_VISIT);
  await expect(page.getByTestId("chat-panel")).toContainText("单证组十几个工位挨着");
  await expect(page.getByTestId("notices")).toContainText("新认识:小陈(单证员,2 年)");

  // 做个验证:用样本包做一次识别测试
  await page.getByRole("button", { name: "做个验证" }).click();
  const exps = page.getByTestId("experiments-dialog");
  await expect(exps).toContainText("用样本包做一次识别测试");
  await exps.locator("li", { hasText: "用样本包做一次识别测试" }).getByRole("button", { name: "做这个" }).click();
  await expect(page.getByTestId("chat-panel")).toContainText("只覆盖 17% 的来料");
  if (await exps.isVisible()) await exps.getByRole("button", { name: "关闭" }).click();

  // 提交判断
  await page.getByRole("button", { name: "我的判断是…" }).click();
  const judgment = page.getByTestId("judgment-dialog");
  await judgment.getByLabel(/真正的问题是什么/).fill("单据之间、版本之间对不上,不是识别");
  await judgment.getByLabel(/你的证据/).fill("样本包里 LT2609-0387 发票 1200 件、装箱单 1150 件;现场小陈大部分时间在核对");
  await judgment.getByLabel(/「做成」对周总意味着什么/).fill("大会能演示,拓浪不再被查验");
  await judgment.getByLabel(/建议的第一步/).fill("先做三单一致性校验和改单同步,不做全自动识别");
  await judgment.getByLabel(/还不确定/).fill("各类错误的金额分布还要找刘姐的出错记录");
  await judgment.getByRole("button", { name: "提交判断" }).click();
  await expect(page.getByRole("button", { name: "已提交判断" })).toBeDisabled();

  // 别人:不能看也不能操作这一局;没登录:401
  const other = await browser.newContext({ baseURL });
  await loginViaApi(other.request, otherEmail, otherInvite!);
  const peek = await other.request.get(`/api/sessions/${sessionId}`);
  expect(peek.status()).toBe(403);
  expect(((await peek.json()) as { error: { code: string } }).error.code).toBe("forbidden");
  expect((await other.request.post(`/api/sessions/${sessionId}/turns`, { data: { text: "你好" } })).status()).toBe(403);
  await other.close();
  const anon = await browser.newContext({ baseURL });
  expect((await anon.request.get(`/api/sessions/${sessionId}`)).status()).toBe(401);
  expect((await anon.request.get(pdfHref!)).status()).toBe(401);
  await anon.close();

  // 收工前:接口响应里没有真相、没有引擎内部字段
  expect(bodies.length).toBeGreaterThan(10);
  for (const { url, text } of bodies) {
    for (const s of TRUTH) expect(text, `${url} 泄露了真相`).not.toContain(s);
    for (const k of INTERNAL_KEYS) expect(text, `${url} 带了内部字段 ${k}`).not.toContain(`"${k}":`);
  }

  // ---- 收工 → 复盘
  await page.getByRole("button", { name: "收工", exact: true }).click();
  await page.getByTestId("end-dialog").getByRole("button", { name: "收工,看复盘" }).click();
  await expect(page).toHaveURL(new RegExp(`/report/${sessionId}$`), { timeout: 60_000 });
  await expect(page.getByTestId("report-total")).toHaveText(/^\d+$/);
  const total = Number(await page.getByTestId("report-total").textContent());
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(100);
  await expect(page.getByTestId("dimensions").locator("li[data-testid^=dimension-]")).toHaveCount(7);
  await expect(page.getByTestId("radar-chart")).toBeVisible();
  await expect(page.getByTestId("report-markdown").getByRole("heading", { name: "真相" })).toBeVisible();
  await expect(page.getByTestId("share-card").getByRole("img", { name: new RegExp(`分享卡:货代公司的「单据识别」,${total} 分`) })).toBeVisible();
  await expect(page.getByTestId("ai-badge")).toHaveText("本复盘由 AI 生成,仅供训练参考。");
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);

  // 申诉一个维度、打推荐分
  const d3 = page.getByTestId("dimension-D3");
  await d3.getByRole("button", { name: /^我不同意/ }).click();
  await d3.getByLabel(/为什么不同意/).fill("我第一句就问了为什么现在要做");
  await d3.getByRole("button", { name: "提交申诉" }).click();
  await expect(d3).toContainText("已提交申诉");
  const rating = page.getByTestId("rating");
  await rating.getByRole("radio", { name: "8" }).click();
  await rating.getByRole("button", { name: "提交" }).click();
  await expect(rating).toContainText("收到,谢谢。");

  // 复盘落盘了:刷新还在,结束的对局不能再说话
  await page.reload();
  await expect(page.getByTestId("report-total")).toHaveText(String(total));
  const late = await page.request.post(`/api/sessions/${sessionId}/turns`, { data: { text: "还有一个问题" } });
  expect(late.status()).toBe(409);

  // ---- 我的对局
  await page.goto("/me");
  const mine = page.getByTestId("my-sessions");
  await expect(mine.getByRole("link", { name: "看复盘" })).toHaveAttribute("href", `/report/${sessionId}`);
  await expect(mine).toContainText(`${total} 分`);

  // ---- 管理员:统计和对局详情里有这一局(管理员能看,但不能替玩家操作)
  await admin.goto("/admin");
  const row = admin.getByTestId("admin-sessions").locator("tr", { hasText: playerEmail });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "详情" }).click();
  await expect(admin).toHaveURL(new RegExp(`/admin/sessions/${sessionId}$`));
  const detail = admin.getByTestId("admin-session");
  await expect(detail).toContainText(playerEmail);
  await expect(detail).toContainText(FIRST);
  await detail.getByRole("tab", { name: "复盘" }).click();
  await expect(detail).toContainText(`${total} 分`);
  await detail.getByRole("tab", { name: "反馈" }).click();
  await expect(detail).toContainText("推荐意愿:8 / 10");
  await expect(detail).toContainText("我第一句就问了为什么现在要做");
  expect((await admin.request.get(`/api/sessions/${sessionId}`)).status()).toBe(200);
  expect((await admin.request.post(`/api/sessions/${sessionId}/turns`, { data: { text: "你好" } })).status()).toBe(403);

  // ---- 玩家删除全部对局:复盘也没了
  await page.getByRole("button", { name: "删除我的全部对局" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确定删除" }).click();
  await expect(page.getByText("已删除 1 局对局和复盘。")).toBeVisible();
  expect((await page.request.get(`/api/reports/${sessionId}`)).status()).toBe(404);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  expect((await page.request.get("/api/me")).status()).toBe(401);

  expect(errors).toEqual([]);
  expect(adminErrors).toEqual([]);
  await admin.context().close();
});
