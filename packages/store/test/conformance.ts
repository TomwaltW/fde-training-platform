// Store 一致性测试(冻结契约的一部分,T1 不得修改)。两套实现跑同一套断言。
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionBusyError, VersionConflictError, type Store } from "@fde/contracts";
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
        expect(await s.redeemInvite(codes[0]!)).toBe(true);
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
        await s.addFeedback({ sessionId: "s1", userId: u.id, rating: 9, text: "好", dispute: null, createdAt: T(3) });
        await s.addFeedback({ sessionId: "s2", userId: u.id, rating: null, text: null, dispute: { dimension: "D3", reason: "不服" }, createdAt: T(4) });
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
        await s.addFeedback({ sessionId: "s1", userId: u.id, rating: 5, text: null, dispute: null, createdAt: T(5) });
        await s.logLlmCall({ sessionId: "s1", at: T(5), stage: "gate", provider: "bailian", model: "m", tokensIn: 1, tokensOut: 1, cachedTokens: 0, costYuan: 0.1, latencyMs: 1, ok: true, error: null });
        expect(await s.deleteUserSessions(u.id)).toBe(2);
        expect(await s.getSession("s1")).toBeNull();
        expect(await s.getReport("s1")).toBeNull();
        expect(await s.listFeedback({ sessionId: "s1" })).toEqual([]);
        expect(await s.listLlmCalls("s1")).toEqual([]);
        expect(await s.getSession("s3")).not.toBeNull();
        expect(await s.getUser(u.id)).not.toBeNull();
      }),
    );
  });
}
