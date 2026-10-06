// 真后端:手机上玩到一半存档续玩(只在手机视口跑,见 playwright.config.ts 的 testIgnore)。
// 管理员用接口生成邀请码 → 新玩家从落地页点"开始这一局" → 登录、同意协议 → 自动开局 → 说 3 句话
// → 刷新页面,3 句话和剩余时间都还在 → 离开这一局去"我的对局",点"接着玩" → 回到同一局再说 1 句。
// 同时计时"打开落地页 → 第一句话得到回复",必须在 60 秒内(W4 验收的冒烟检查)。
//
// 和 full-flow.spec.ts 共用一个服务、一个内存库:邮箱都是这个文件自己的(验证码请求按邮箱 60 秒限一次),
// 管理员邮箱在 serve.mjs 的 ADMIN_EMAILS 里。所有请求都来自 127.0.0.1,登录接口还按 IP 限频,
// 所以这里只发 2 次验证码请求(管理员、玩家各 1 次)。玩家走登录页,邀请码由页面带上;
// 要是改成接口登录新用户,request-code 和 verify 两次请求都要带 inviteCode。
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { CreateInvitesResponse, RequestCodeResponse, SessionResponse } from "@fde/contracts";
import { expectCompliance, expectNoHorizontalScroll, isMobile, showPanel, trackPageErrors } from "../mock/helpers";

const ADMIN_EMAIL = "admin-resume@e2e.test";
const PLAYER_EMAIL = "player-resume@e2e.test";

// 前三句和 full-flow.spec.ts 一样:离线引擎(关键词闸门 + 模板演员)下已知会得到回话
const FIRST = "周总您好,我不是来追责的。为什么现在想做这件事?最近出过什么事吗?";
const ASK_LIN = "小林你好,周总说样本单据在你这儿,能给我看看吗?";
const ASK_VISIT = "周总,能不能让我去操作部现场看半小时?";
const FOURTH = "这些单据出了错,一般是谁最先发现的?";

/** 打开落地页 → 第一句话得到回复的上限(W4 验收)。 */
const FIRST_REPLY_BUDGET_MS = 60_000;

/** 管理员接口登录(ADMIN_EMAILS 里的邮箱首次登录不要邀请码),生成一个一次性邀请码。 */
async function inviteFromAdmin(request: APIRequestContext): Promise<string> {
  const r1 = await request.post("/api/auth/request-code", { data: { email: ADMIN_EMAIL } });
  expect(r1.status()).toBe(200);
  const { devCode } = (await r1.json()) as RequestCodeResponse;
  expect(devCode).toMatch(/^\d{6}$/);
  expect((await request.post("/api/auth/verify", { data: { email: ADMIN_EMAIL, code: devCode } })).status()).toBe(200);
  expect((await request.post("/api/me/consent")).status()).toBe(200);
  const r2 = await request.post("/api/admin/invites", { data: { count: 1, note: "e2e resume" } });
  expect(r2.status()).toBe(201);
  const { codes } = (await r2.json()) as CreateInvitesResponse;
  expect(codes).toHaveLength(1);
  expect(codes[0]).toMatch(/^[A-Z2-9]{8}$/);
  return codes[0]!;
}

/** 登录页:填邮箱和邀请码 → 发验证码 → 读开发模式回显的验证码 → 登录 → 勾选同意。 */
async function loginWithInvite(page: Page, email: string, inviteCode: string) {
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("邀请码").fill(inviteCode);
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
}

test("真后端(手机):新用户登录、说 3 句 → 刷新存档还在 → 我的对局「接着玩」回到同一局再说 1 句;落地页到第一句回复 60 秒内", async ({
  page,
  request,
}, info) => {
  expect(isMobile(info), "存档续玩只在手机视口跑").toBe(true);
  const invite = await inviteFromAdmin(request);
  const errors = trackPageErrors(page);

  const chat = page.getByTestId("chat-panel");
  const userLines = chat.locator('[data-speaker="user"]');
  const npcLines = chat.locator('[data-speaker="npc"]');
  const composer = page.locator("#composer");
  const timeLeft = page.getByTestId("time-left");
  const say = async (text: string) => {
    const before = await npcLines.count();
    await composer.fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(npcLines).toHaveCount(before + 1);
    await expect(composer).toBeEnabled();
  };
  const switchTo = async (personId: string, name: string) => {
    await showPanel(page, info, "人物");
    await page.getByTestId("people-panel").getByTestId(personId).click();
    await expect(page.getByTestId("current-role")).toContainText(name);
    await showPanel(page, info, "对话");
  };

  // ---- 计时开始:打开落地页。没登录点"开始这一局"会先去登录页,登录(和同意协议)后直接开局,不用再点一次
  const openedAt = Date.now();
  await page.goto("/");
  await page.getByRole("button", { name: "开始这一局" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2F%3Fstart%3Dfreight-docs$/);
  await loginWithInvite(page, PLAYER_EMAIL, invite);
  await expect(page).toHaveURL(/\/play\/[^/]+$/);
  const sessionId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(timeLeft).toHaveText("今天还剩 6 小时");
  await page.getByTestId("mobile-hint").getByRole("button", { name: "知道了" }).click();

  // 第一句:周总说出拓浪的事。到这里计时结束
  await say(FIRST);
  const firstReplyMs = Date.now() - openedAt;
  const seconds = (firstReplyMs / 1000).toFixed(1);
  info.annotations.push({ type: "落地页 → 第一句回复", description: `${seconds} 秒` });
  console.log(`[resume] 打开落地页 → 第一句话得到回复:${seconds} 秒(上限 ${FIRST_REPLY_BUDGET_MS / 1000} 秒)`);
  expect(firstReplyMs, `打开落地页到第一句回复用了 ${seconds} 秒`).toBeLessThan(FIRST_REPLY_BUDGET_MS);
  await expect(npcLines.last()).toContainText("拓浪");

  // 第二句找小林,第三句回去找周总
  await switchTo("person-lin", "小林");
  await say(ASK_LIN);
  await switchTo("person-zhou", "周总");
  await say(ASK_VISIT);

  const said = [FIRST, ASK_LIN, ASK_VISIT];
  const expectSaid = async (lines: string[]) => {
    await expect(userLines).toHaveCount(lines.length);
    for (const [i, text] of lines.entries()) await expect(userLines.nth(i)).toContainText(text);
  };
  await expectSaid(said);
  const npcCount = await npcLines.count();
  const left = (await timeLeft.textContent())!;
  expect(left).toMatch(/^今天还剩 /);
  expect(left).not.toBe("今天还剩 6 小时");

  // ---- 刷新:3 句话、对方的回话、剩余时间都还在
  await page.reload();
  await expectSaid(said);
  await expect(npcLines).toHaveCount(npcCount);
  await expect(timeLeft).toHaveText(left);
  await expectNoHorizontalScroll(page, info);

  // ---- 离开这一局,去"我的对局"点"接着玩"
  await showPanel(page, info, "人物");
  await page.getByRole("link", { name: /离开这一局/ }).click();
  await expect(page).toHaveURL(/\/me$/);
  const mine = page.getByTestId("my-sessions");
  await expect(mine.getByRole("listitem")).toHaveCount(1);
  const resume = mine.getByRole("link", { name: "接着玩" });
  await expect(resume).toHaveAttribute("href", `/play/${sessionId}`);
  await expectCompliance(page);
  await expectNoHorizontalScroll(page, info);
  await resume.click();

  // ---- 回到同一局:存档原样,再说 1 句
  await expect(page).toHaveURL(new RegExp(`/play/${sessionId}$`));
  await expectSaid(said);
  await expect(npcLines).toHaveCount(npcCount);
  await expect(timeLeft).toHaveText(left);
  await say(FOURTH);
  await expectSaid([...said, FOURTH]);
  await expect(timeLeft).not.toHaveText(left);

  // 服务端也是同一局、4 句话
  const r = await page.request.get(`/api/sessions/${sessionId}`);
  expect(r.status()).toBe(200);
  const { view } = (await r.json()) as SessionResponse;
  expect(view.transcript.filter((l) => l.speaker === "user").map((l) => l.text)).toEqual([...said, FOURTH]);

  expect(errors).toEqual([]);
});
