// Store 一致性测试(冻结契约的一部分,实现方不得修改)。两套实现跑同一套断言。第三轮的用例在最后。
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionBusyError, VersionConflictError, normalizeRedeemCode, type Store } from "@fde/contracts";
import { createSession, loadScenario, type SessionReport } from "@fde/engine";

const scn = loadScenario(resolve(import.meta.dirname, "../../../scenarios/freight-docs"));
const T = (min: number) => new Date(Date.UTC(2026, 9, 5, 8, min)).toISOString();
const sampleState = (id: string) => {
  const st = createSession(scn, { sessionId: id });
  st.transcript.push({ ref: "U1", turn: 1, speaker: "user", roleId: "zhou", text: "周总好,「引号」与 emoji 🚢 和换行\n都要原样存回来", phase: "kickoff" });
  return st;
};
const sampleReport = (total: number): SessionReport =>
  ({
    score: { dimensions: [], rawTotal: total, total, caps: [], badges: [], band: "x" },
    judge: { claims: [], T: [], S: [], W: [], key_moments: [], npc_inconsistencies: [] },
    judgeIssues: [],
    debrief: {} as SessionReport["debrief"],
    markdown: `# 复盘 ${total}`,
  }) as SessionReport;

export function runStoreConformance(name: string, make: () => Promise<Store>) {
  describe(`Store conformance: ${name}`, () => {
    const withStore = (fn: (s: Store) => Promise<void>) => async () => {
      const s = await make();
      try {
        await s.migrate();
        await s.migrate(); // 可重复调用
        await fn(s);
      } finally {
        await s.close();
      }
    };
    const user = async (s: Store, email = "a@example.com") => s.createUser(email);

    it(
      "邀请码:格式、次数、无效码、并发不超用",
      withStore(async (s) => {
        const codes = await s.createInvites(3, 1, "batch1");
        expect(codes).toHaveLength(3);
        expect(new Set(codes).size).toBe(3);
        for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
        expect(await s.inviteAvailable(codes[0]!)).toBe(true);
        expect(await s.inviteAvailable(codes[0]!)).toBe(true); // 只看不用
        expect(await s.redeemInvite(codes[0]!)).toBe(true);
        expect(await s.inviteAvailable(codes[0]!)).toBe(false);
        expect(await s.inviteAvailable("NOPE2345")).toBe(false);
        expect(await s.redeemInvite(codes[0]!)).toBe(false);
        expect(await s.redeemInvite("NOPE2345")).toBe(false);
        const [multi] = await s.createInvites(1, 2);
        const results = await Promise.all(Array.from({ length: 5 }, () => s.redeemInvite(multi!)));
        expect(results.filter(Boolean)).toHaveLength(2);
      }),
    );

    it(
      "用户:邮箱小写、重复报错、同意协议、计数",
      withStore(async (s) => {
        const u = await s.createUser("Alice@Example.COM");
        expect(u.email).toBe("alice@example.com");
        expect(u.consentAt).toBeNull();
        expect(u.id).toBeTruthy();
        expect((await s.getUserByEmail("ALICE@example.com"))?.id).toBe(u.id);
        expect((await s.getUser(u.id))?.email).toBe("alice@example.com");
        expect(await s.getUser("missing")).toBeNull();
        expect(await s.getUserByEmail("nobody@example.com")).toBeNull();
        await expect(s.createUser("alice@example.com")).rejects.toThrow();
        await s.setConsent(u.id, T(1));
        expect(new Date((await s.getUser(u.id))!.consentAt!).toISOString()).toBe(T(1));
        await s.createUser("bob@example.com");
        expect(await s.countUsers()).toBe(2);
      }),
    );

    it(
      "登录验证码:错一次计数、对了就删、过期无效、错满 5 次作废",
      withStore(async (s) => {
        await s.saveLoginCode("a@example.com", "h-right", T(10));
        expect(await s.verifyLoginCode("a@example.com", "h-wrong", T(1))).toBe(false);
        expect(await s.verifyLoginCode("a@example.com", "h-right", T(1))).toBe(true);
        expect(await s.verifyLoginCode("a@example.com", "h-right", T(1))).toBe(false); // 已删
        await s.saveLoginCode("a@example.com", "h2", T(10));
        expect(await s.verifyLoginCode("a@example.com", "h2", T(11))).toBe(false); // 过期
        await s.saveLoginCode("a@example.com", "h3", T(10));
        for (let i = 0; i < 5; i++) expect(await s.verifyLoginCode("a@example.com", "bad", T(1))).toBe(false);
        expect(await s.verifyLoginCode("a@example.com", "h3", T(1))).toBe(false); // 错满 5 次
        await s.saveLoginCode("a@example.com", "h4", T(10)); // 重新发码,计数清零
        expect(await s.verifyLoginCode("a@example.com", "h4", T(1))).toBe(true);
        expect(await s.verifyLoginCode("x@example.com", "h4", T(1))).toBe(false);
      }),
    );

    it(
      "登录态:有效、过期、删除",
      withStore(async (s) => {
        const u = await user(s);
        await s.createAuthToken(u.id, "tok1", T(30));
        expect((await s.getUserByAuthToken("tok1", T(1)))?.id).toBe(u.id);
        expect(await s.getUserByAuthToken("tok1", T(31))).toBeNull();
        expect(await s.getUserByAuthToken("nope", T(1))).toBeNull();
        await s.deleteAuthToken("tok1");
        expect(await s.getUserByAuthToken("tok1", T(1))).toBeNull();
      }),
    );

    it(
      "对局:创建、原样读回、乐观锁、结束、排序、计数",
      withStore(async (s) => {
        const u = await user(s);
        const created = await s.createSession({ id: "s1", userId: u.id, scenarioId: "freight-docs", state: sampleState("s1"), startedAt: T(1) });
        expect(created).toMatchObject({ id: "s1", version: 1, status: "active", endedAt: null });
        const got = await s.getSession("s1");
        expect(got?.state).toEqual(sampleState("s1"));
        expect(await s.getSession("missing")).toBeNull();

        const st = got!.state;
        st.turn = 5;
        expect(await s.saveSession("s1", st, 1)).toBe(2);
        await expect(s.saveSession("s1", st, 1)).rejects.toBeInstanceOf(VersionConflictError);
        expect((await s.getSession("s1"))?.state.turn).toBe(5);
        expect(await s.saveSession("s1", st, 2, { endedAt: T(40) })).toBe(3);
        const ended = await s.getSession("s1");
        expect(ended?.status).toBe("ended");
        expect(new Date(ended!.endedAt!).toISOString()).toBe(T(40));

        await s.createSession({ id: "s2", userId: u.id, scenarioId: "freight-docs", state: sampleState("s2"), startedAt: T(50) });
        await s.createSession({ id: "s3", userId: u.id, scenarioId: "freight-docs", state: sampleState("s3"), startedAt: T(20) });
        expect((await s.listSessions(u.id)).map((x) => x.id)).toEqual(["s2", "s3", "s1"]);
        expect(await s.countSessionsSince(u.id, T(10))).toBe(2);
        const other = await user(s, "b@example.com");
        await s.createSession({ id: "s4", userId: other.id, scenarioId: "freight-docs", state: sampleState("s4"), startedAt: T(55) });
        expect((await s.listAllSessions(10)).map((x) => x.id)).toEqual(["s4", "s2", "s3", "s1"]);
        expect((await s.listAllSessions(2)).map((x) => x.id)).toEqual(["s4", "s2"]);
        expect((await s.listAllSessions(10, T(50))).map((x) => x.id)).toEqual(["s3", "s1"]);
        expect(await s.countSessionsSince(other.id, T(0))).toBe(1);
      }),
    );

    it(
      "会话锁:同一局串行、不同局并行、出错释放、超时抛 SessionBusyError",
      withStore(async (s) => {
        const log: string[] = [];
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const job = (id: string, tag: string, ms: number) =>
          s.withSessionLock(id, async () => {
            log.push(`${tag}+`);
            await sleep(ms);
            log.push(`${tag}-`);
            return tag;
          });
        expect(await Promise.all([job("x", "a", 30), job("x", "b", 1)])).toEqual(["a", "b"]);
        expect(log).toEqual(["a+", "a-", "b+", "b-"]);

        log.length = 0;
        await Promise.all([job("p", "p", 30), job("q", "q", 30)]);
        expect(log.slice(0, 2).sort()).toEqual(["p+", "q+"]);

        await expect(s.withSessionLock("y", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
        expect(await s.withSessionLock("y", async () => "free")).toBe("free");

        const hold = s.withSessionLock("z", () => sleep(200));
        await expect(s.withSessionLock("z", async () => "late", 20)).rejects.toBeInstanceOf(SessionBusyError);
        await hold;
      }),
    );

    it(
      "复盘:存取、覆盖",
      withStore(async (s) => {
        const u = await user(s);
        await s.createSession({ id: "s1", userId: u.id, scenarioId: "freight-docs", state: sampleState("s1"), startedAt: T(1) });
        expect(await s.getReport("s1")).toBeNull();
        await s.saveReport("s1", sampleReport(40), T(2));
        await s.saveReport("s1", sampleReport(62), T(3));
        const r = await s.getReport("s1");
        expect(r?.report.score.total).toBe(62);
        expect(r?.report.markdown).toBe("# 复盘 62");
      }),
    );

    it(
      "反馈、模型调用日志、总花费",
      withStore(async (s) => {
        const u = await user(s);
        await s.createSession({ id: "s1", userId: u.id, scenarioId: "freight-docs", state: sampleState("s1"), startedAt: T(1) });
        await s.createSession({ id: "s2", userId: u.id, scenarioId: "freight-docs", state: sampleState("s2"), startedAt: T(2) });
        await s.addFeedback({ sessionId: "s1", userId: u.id, rating: 9, text: "好", dispute: null, wantNext: true, createdAt: T(3) });
        await s.addFeedback({ sessionId: "s2", userId: u.id, rating: null, text: null, dispute: { dimension: "D3", reason: "不服" }, wantNext: null, createdAt: T(4) });
        expect((await s.listFeedback({ sessionId: "s2" }))[0]?.dispute).toEqual({ dimension: "D3", reason: "不服" });
        expect(await s.listFeedback()).toHaveLength(2);
        expect(await s.listFeedback({ limit: 1 })).toHaveLength(1);
        const call = { at: T(5), stage: "actor", provider: "bailian", model: "qwen-plus", tokensIn: 1000, tokensOut: 100, cachedTokens: 0, latencyMs: 900, ok: true, error: null };
        await s.logLlmCall({ ...call, sessionId: "s1", costYuan: 0.0123 });
        await s.logLlmCall({ ...call, sessionId: "s1", costYuan: null, ok: false, error: "timeout" });
        await s.logLlmCall({ ...call, sessionId: null, costYuan: 0.5 });
        const calls = await s.listLlmCalls("s1");
        expect(calls).toHaveLength(2);
        expect(calls.find((c) => !c.ok)?.error).toBe("timeout");
        expect(await s.totalCostYuan()).toBeCloseTo(0.5123, 6);
      }),
    );

    it(
      "删除本人数据:对局、复盘、反馈、调用记录一起删,别人不受影响",
      withStore(async (s) => {
        const u = await user(s);
        const v = await user(s, "b@example.com");
        await s.createSession({ id: "s1", userId: u.id, scenarioId: "freight-docs", state: sampleState("s1"), startedAt: T(1) });
        await s.createSession({ id: "s2", userId: u.id, scenarioId: "freight-docs", state: sampleState("s2"), startedAt: T(2) });
        await s.createSession({ id: "s3", userId: v.id, scenarioId: "freight-docs", state: sampleState("s3"), startedAt: T(3) });
        await s.saveReport("s1", sampleReport(50), T(4));
        await s.addFeedback({ sessionId: "s1", userId: u.id, rating: 5, text: null, dispute: null, wantNext: false, createdAt: T(5) });
        await s.logLlmCall({ sessionId: "s1", at: T(5), stage: "gate", provider: "bailian", model: "m", tokensIn: 1, tokensOut: 1, cachedTokens: 0, costYuan: 0.1, latencyMs: 1, ok: true, error: null });
        const costBefore = await s.totalCostYuan();
        expect(await s.countSessionsSince(u.id, T(0))).toBe(2);
        expect(await s.deleteUserSessions(u.id)).toBe(2);
        expect(await s.getSession("s1")).toBeNull();
        expect(await s.getReport("s1")).toBeNull();
        expect(await s.listFeedback({ sessionId: "s1" })).toEqual([]);
        expect(await s.listLlmCalls("s1")).toEqual([]);
        // 花费保留、每日限额照算:删数据不能清零当天的开局数
        expect(await s.totalCostYuan()).toBeCloseTo(costBefore, 6);
        expect(await s.countSessionsSince(u.id, T(0))).toBe(2);
        expect(await s.listSessions(u.id)).toEqual([]);
        expect(await s.getSession("s3")).not.toBeNull();
        expect(await s.getUser(u.id)).not.toBeNull();
      }),
    );

    it(
      "登录验证码:并发猜测也只有前 5 次会被比对(防暴力破解)",
      withStore(async (s) => {
        await s.saveLoginCode("x@example.com", "right", T(10));
        // 第 10 个才是对的:不管实现怎么交错执行,前 5 次用完后它也必须失败
        const guesses = Array.from({ length: 10 }, (_, i) => (i === 9 ? "right" : `wrong${i}`));
        const results = await Promise.all(guesses.map((g) => s.verifyLoginCode("x@example.com", g, T(1))));
        expect(results.filter(Boolean)).toEqual([]);
        expect(await s.verifyLoginCode("x@example.com", "right", T(1))).toBe(false);
        // 两个并发的正确提交只有一个成功
        await s.saveLoginCode("y@example.com", "ok", T(10));
        const twice = await Promise.all([s.verifyLoginCode("y@example.com", "ok", T(1)), s.verifyLoginCode("y@example.com", "ok", T(1))]);
        expect(twice.filter(Boolean)).toHaveLength(1);
      }),
    );

    // ================================================================ 第三轮

    it(
      "第三轮 用户:手机号用户、邮箱用户的 phone 为 null、登录验证码按手机号存",
      withStore(async (s) => {
        const e = await s.createUser("e@example.com");
        expect(e.phone).toBeNull();
        const p = await s.createUserByPhone("+8613800000001");
        expect(p.email).toBeNull();
        expect(p.phone).toBe("+8613800000001");
        expect(p.consentAt).toBeNull();
        expect((await s.getUserByPhone("+8613800000001"))?.id).toBe(p.id);
        expect(await s.getUserByPhone("+8613800000002")).toBeNull();
        expect((await s.getUser(p.id))?.phone).toBe("+8613800000001");
        await expect(s.createUserByPhone("+8613800000001")).rejects.toThrow();
        expect(await s.countUsers()).toBe(2);
        // 手机号用户也能登录态、同意协议
        await s.createAuthToken(p.id, "th", T(30));
        expect((await s.getUserByAuthToken("th", T(1)))?.phone).toBe("+8613800000001");
        await s.setConsent(p.id, T(2));
        expect((await s.getUser(p.id))?.consentAt).toBe(T(2));
        // 验证码按地址存,邮箱和手机号互不影响
        await s.saveLoginCode("+8613800000001", "h1", T(10));
        await s.saveLoginCode("e@example.com", "h2", T(10));
        expect(await s.verifyLoginCode("+8613800000001", "h2", T(1))).toBe(false);
        expect(await s.verifyLoginCode("+8613800000001", "h1", T(1))).toBe(true);
        expect(await s.verifyLoginCode("E@example.com", "h2", T(1))).toBe(true);
      }),
    );

    it(
      "第三轮 反馈:wantNext 原样存回",
      withStore(async (s) => {
        const u = await user(s);
        await s.createSession({ id: "s1", userId: u.id, scenarioId: "freight-docs", state: sampleState("s1"), startedAt: T(1) });
        await s.addFeedback({ sessionId: "s1", userId: u.id, rating: null, text: null, dispute: null, wantNext: true, createdAt: T(2) });
        await s.addFeedback({ sessionId: "s1", userId: u.id, rating: 3, text: null, dispute: null, wantNext: false, createdAt: T(3) });
        await s.addFeedback({ sessionId: "s1", userId: u.id, rating: 7, text: null, dispute: null, wantNext: null, createdAt: T(4) });
        expect((await s.listFeedback({ sessionId: "s1" })).map((f) => f.wantNext)).toEqual([null, false, true]);
      }),
    );

    it(
      "第三轮 候补名单:邮箱小写、重复不改、按登记时间排序、筛选已邀请",
      withStore(async (s) => {
        expect(await s.addToWaitlist({ email: "B@Example.com", role: "fde", note: "想练", source: "xhs", createdAt: T(2) })).toEqual({ created: true });
        expect(await s.addToWaitlist({ email: "a@example.com", role: null, note: null, source: null, createdAt: T(1) })).toEqual({ created: true });
        expect(await s.addToWaitlist({ email: "b@example.COM", role: "other", note: "改了", source: "jike", createdAt: T(9) })).toEqual({ created: false });
        expect(await s.addToWaitlist({ email: "c@example.com", role: "student", note: null, source: "xhs", createdAt: T(2) })).toEqual({ created: true });
        const all = await s.listWaitlist();
        expect(all.map((w) => w.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
        expect(all[1]).toEqual({ email: "b@example.com", role: "fde", note: "想练", source: "xhs", createdAt: T(2), invitedAt: null, inviteCode: null });
        await s.markWaitlistInvited("B@example.com", "ABCD2345", T(5));
        await s.markWaitlistInvited("nobody@example.com", "ZZZZ2345", T(5));
        expect((await s.listWaitlist({ invited: true })).map((w) => [w.email, w.inviteCode, w.invitedAt])).toEqual([["b@example.com", "ABCD2345", T(5)]]);
        expect((await s.listWaitlist({ invited: false })).map((w) => w.email)).toEqual(["a@example.com", "c@example.com"]);
        expect((await s.listWaitlist({ invited: false, limit: 1 })).map((w) => w.email)).toEqual(["a@example.com"]);
        expect(await s.listWaitlist({ limit: 0 })).toEqual([]);
      }),
    );

    it(
      "第三轮 事件:原样存回、按时间与条件筛选、删除对局时一起删",
      withStore(async (s) => {
        const u = await user(s);
        await s.createSession({ id: "s1", userId: u.id, scenarioId: "freight-docs", state: sampleState("s1"), startedAt: T(1) });
        await s.logEvent({ at: T(3), type: "turn", userId: u.id, sessionId: "s1", visitorId: null, props: { latencyMs: 1200, ok: true } });
        await s.logEvent({ at: T(1), type: "landing_viewed", userId: null, sessionId: null, visitorId: "v1", props: { from: "xhs" } });
        await s.logEvent({ at: T(3), type: "action", userId: u.id, sessionId: "s1", visitorId: "v1", props: {} });
        await s.logEvent({ at: T(5), type: "login", userId: u.id, sessionId: null, visitorId: "v1", props: { method: "email" } });
        const all = await s.listEvents();
        expect(all.map((e) => e.type)).toEqual(["landing_viewed", "turn", "action", "login"]);
        expect(all[1]).toEqual({ at: T(3), type: "turn", userId: u.id, sessionId: "s1", visitorId: null, props: { latencyMs: 1200, ok: true } });
        expect((await s.listEvents({ since: T(3), until: T(5) })).map((e) => e.type)).toEqual(["turn", "action"]);
        expect((await s.listEvents({ types: ["login", "landing_viewed"] })).map((e) => e.type)).toEqual(["landing_viewed", "login"]);
        expect((await s.listEvents({ sessionId: "s1" })).length).toBe(2);
        expect((await s.listEvents({ userId: u.id })).length).toBe(3);
        expect((await s.listEvents({ visitorId: "v1" })).map((e) => e.type)).toEqual(["landing_viewed", "action", "login"]);
        expect((await s.listEvents({ limit: 1 })).map((e) => e.type)).toEqual(["landing_viewed"]);
        expect(await s.listEvents({ types: [] })).toEqual([]);
        await s.deleteUserSessions(u.id);
        expect((await s.listEvents()).map((e) => e.type)).toEqual(["landing_viewed", "login"]);
      }),
    );

    it(
      "第三轮 兑换码:格式、任意写法查询、只能兑一次、并发只成功一次、筛选",
      withStore(async (s) => {
        const u = await user(s);
        const v = await user(s, "b@example.com");
        const codes = await s.createRedeemCodes("sprint", 3, "早鸟");
        expect(codes).toHaveLength(3);
        expect(new Set(codes).size).toBe(3);
        for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
        const [c0, c1] = codes as [string, string];
        const messy = ` ${c0.toLowerCase().replace(/-/g, " ")} `;
        expect(normalizeRedeemCode(messy)).toBe(c0);
        expect(await s.getRedeemCode(messy)).toMatchObject({ code: c0, productId: "sprint", note: "早鸟", redeemedBy: null, redeemedAt: null });
        expect(await s.getRedeemCode("NOPE-NOPE-NOPE")).toBeNull();
        expect(await s.redeemCode("NOPE-NOPE-NOPE", u.id, T(1))).toBeNull();
        const r = await s.redeemCode(messy, u.id, T(2));
        expect(r).toMatchObject({ code: c0, redeemedBy: u.id, redeemedAt: T(2) });
        expect(await s.redeemCode(c0, u.id, T(3))).toBeNull();
        expect(await s.redeemCode(c0, v.id, T(3))).toBeNull();
        const race = await Promise.all([u.id, v.id, u.id, v.id].map((id) => s.redeemCode(c1, id, T(4))));
        expect(race.filter(Boolean)).toHaveLength(1);
        expect((await s.listRedeemCodes({ redeemedBy: u.id })).map((x) => x.code)).toContain(c0);
        expect((await s.listRedeemCodes({ productId: "sprint" })).length).toBe(3);
        await s.createRedeemCodes("pack", 2);
        expect((await s.listRedeemCodes()).length).toBe(5);
        expect((await s.listRedeemCodes({ productId: "pack" })).every((x) => x.productId === "pack" && x.note === null)).toBe(true);
        expect((await s.listRedeemCodes({ limit: 2 })).length).toBe(2);
      }),
    );
  });
}
