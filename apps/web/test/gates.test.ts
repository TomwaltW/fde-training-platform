// 方案 6.3 继续/转向/放弃的指标(第三轮,spec 2.1「埋点与指标」):门槛配置的校验、每个指标在构造数据上的
// 数值与状态(含样本不足、中位时长"修"的两段)、在线时长的空闲截断、新用户第一句话的匹配规则、时间范围筛选,
// 以及 GET /api/admin/gates 接口(权限、参数、配置写错、从真实存储取数)。
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateSessionResponse, GateMetric, GatesResponse, RequestCodeResponse, StoredEvent } from "@fde/contracts";
import * as adminGates from "../app/api/admin/gates/route.ts";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import * as events from "../app/api/events/route.ts";
import { resetEventQuotaForTests } from "../app/api/events/rate-limit.ts";
import * as consent from "../app/api/me/consent/route.ts";
import * as feedback from "../app/api/reports/[id]/feedback/route.ts";
import * as finish from "../app/api/sessions/[id]/finish/route.ts";
import * as turns from "../app/api/sessions/[id]/turns/route.ts";
import * as sessions from "../app/api/sessions/route.ts";
import {
  activeMinutes,
  computeGates,
  firstTurnSeconds,
  firstTurnVisitorIds,
  gateStatus,
  judge,
  latestAnswers,
  loadGatesConfig,
  parseGatesRange,
  percentile,
  thresholdsText,
  type GatesConfig,
  type GatesInput,
  type GatesRange,
} from "../lib/server/gates.ts";
import { resetForTests } from "../lib/server/runtime.ts";
import { getStore } from "../lib/server/store.ts";
import { Client, errorCode } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const REPO_CONFIG = join(ROOT, "config/gates.yaml");
const tmp = mkdtempSync(join(tmpdir(), "fde-gates-test-"));
const cfg = loadGatesConfig(REPO_CONFIG);
/** 只看数值和门槛、不看样本量时用。 */
const anySample: GatesConfig = { ...cfg, min_sample: 1 };

// ---------------------------------------------------------------- 构造数据

type Ev = Pick<StoredEvent, "at" | "type" | "userId" | "sessionId" | "visitorId" | "props">;

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const atMin = (m: number) => new Date(T0 + m * 60_000).toISOString();
const atSec = (s: number) => new Date(T0 + s * 1000).toISOString();
const DAY_MIN = 24 * 60;
const ALL: GatesRange = { since: null, until: null };
/** 第一周:[T0, T0 + 7 天)。 */
const WEEK: GatesRange = { since: atMin(0), until: atMin(7 * DAY_MIN) };

function ev(type: string, at: string, o: Partial<Ev> = {}): Ev {
  return { at, type, userId: null, sessionId: null, visitorId: null, props: {}, ...o };
}

function input(o: Partial<GatesInput> = {}): GatesInput {
  return { range: ALL, waitlist: [], userIdByEmail: new Map(), redeemers: new Set(), sessions: [], feedback: [], events: [], ...o };
}

/** n 局,前 finished 局出了复盘;开局时间从 startMin 起每分钟一局。 */
function sessionsOf(n: number, finished: number, prefix = "s", startMin = 60): GatesInput["sessions"] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, userId: `u-${prefix}${i}`, startedAt: atMin(startMin + i), finished: i < finished }));
}

/** 一局的活动事件:开局,之后每 step 分钟说一句,第 total 分钟收工(间隔都不超过 10 分钟时在线时长 = total)。 */
function played(sessionId: string, total: number, startMin = 100, step = 5): Ev[] {
  const out = [ev("session_created", atMin(startMin), { sessionId })];
  for (let m = step; m < total; m += step) out.push(ev("turn", atMin(startMin + m), { sessionId, props: { latencyMs: 1000 } }));
  out.push(ev("session_finished", atMin(startMin + total), { sessionId }));
  return out;
}

type Fb = GatesInput["feedback"][number];
function fb(sessionId: string, minute: number, o: Partial<Fb>): Fb {
  return { sessionId, rating: null, dispute: null, wantNext: null, createdAt: atMin(minute), ...o };
}

function metricOf(res: GatesResponse, id: string): GateMetric {
  const m = [...res.gate1, ...res.gate2, ...res.gate3].find((x) => x.id === id);
  if (!m) throw new Error(`没有指标 ${id}`);
  return m;
}

const waitlistOf = (n: number, startMin = 60, prefix = "w") =>
  Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.com`, createdAt: atMin(startMin + i) }));

// ---------------------------------------------------------------- 门槛配置

function writeConfig(name: string, text: string): string {
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
}
const repoYaml = readFileSync(REPO_CONFIG, "utf8");

describe("门槛配置 config/gates.yaml", () => {
  it("数值照抄方案 6.3,注释里写明来源", () => {
    expect(cfg).toEqual({
      min_sample: 10,
      idle_cap_minutes: 10,
      gate1: { waitlist_7d: { pass_at_least: 100, fail_below: 30 } },
      gate2: {
        completion: { pass_at_least: 0.4, fail_below: 0.2 },
        median_minutes: { pass_between: [15, 35], fail_outside: [8, 50] },
        promoters: { pass_at_least: 0.3, fail_below: 0.15 },
        want_next: { pass_at_least: 0.6, fail_below: 0.4 },
        share: { pass_at_least: 0.15, fail_below: 0.05 },
        dispute: { pass_below: 0.2, fail_above: 0.4 },
      },
      gate3: { waitlist_to_paid: { pass_at_least: 0.05, fail_below: 0.02 } },
    });
    expect(repoYaml).toContain("6.3");
    expect(repoYaml).toContain("【待验证】");
  });

  it("min_sample、idle_cap_minutes 省略时默认 10", () => {
    const p = writeConfig("defaults.yaml", repoYaml.replace(/^min_sample:.*$/m, "").replace(/^idle_cap_minutes:.*$/m, ""));
    const c = loadGatesConfig(p);
    expect(c.min_sample).toBe(10);
    expect(c.idle_cap_minutes).toBe(10);
    expect(c.gate2).toEqual(cfg.gate2);
  });

  it("写错直接报错,并指出是哪一项", () => {
    const cases: [string, string, RegExp][] = [
      ["typo.yaml", repoYaml.replace("  completion:", "  completoin:"), /completoin/],
      ["percent.yaml", repoYaml.replace("pass_at_least: 0.40", "pass_at_least: 40"), /gate2\.completion\.pass_at_least/],
      ["reversed.yaml", repoYaml.replace("pass_below: 0.20", "pass_below: 0.50"), /gate2\.dispute.*pass_below 不能大于 fail_above/],
      ["band.yaml", repoYaml.replace("pass_between: [15, 35]", "pass_between: [5, 35]"), /gate2\.median_minutes/],
      ["missing.yaml", repoYaml.replace(/^gate3:[\s\S]*$/m, ""), /gate3/],
      ["string.yaml", repoYaml.replace("min_sample: 10", 'min_sample: "10"'), /min_sample/],
      ["extra.yaml", `${repoYaml}\nmin_samples: 5\n`, /min_samples/],
      ["people.yaml", repoYaml.replace("pass_at_least: 100", "pass_at_least: 99.5"), /gate1\.waitlist_7d\.pass_at_least/],
    ];
    for (const [name, text, re] of cases) {
      expect(() => loadGatesConfig(writeConfig(name, text)), name).toThrow(re);
    }
    expect(() => loadGatesConfig(join(tmp, "nope.yaml"))).toThrow(/找不到门槛配置/);
    expect(() => loadGatesConfig(writeConfig("broken.yaml", "gate1: [oops"))).toThrow(/不是合法的 YAML/);
    expect(() => loadGatesConfig(writeConfig("empty.yaml", ""))).toThrow(/有误/);
  });
});

// ---------------------------------------------------------------- 判定

describe("判定与门槛文字", () => {
  it("越高越好:≥ 过的线为过,< 不过的线为不过,中间为修", () => {
    const r = cfg.gate2.completion;
    expect(judge(r, 0.4)).toBe("pass");
    expect(judge(r, 1)).toBe("pass");
    expect(judge(r, 0.39)).toBe("fix");
    expect(judge(r, 0.2)).toBe("fix");
    expect(judge(r, 0.19)).toBe("fail");
    expect(judge(r, 0)).toBe("fail");
  });

  it("越低越好(申诉率):<20% 过,20–40% 修(含两端),>40% 不过", () => {
    const r = cfg.gate2.dispute;
    expect(judge(r, 0)).toBe("pass");
    expect(judge(r, 0.19)).toBe("pass");
    expect(judge(r, 0.2)).toBe("fix");
    expect(judge(r, 0.4)).toBe("fix");
    expect(judge(r, 0.41)).toBe("fail");
  });

  it("中位时长:15–35 过;35–50 和 8–15 两段都是修;>50 或 <8 不过", () => {
    const r = cfg.gate2.median_minutes;
    for (const v of [15, 20, 35]) expect(judge(r, v), String(v)).toBe("pass");
    for (const v of [35.1, 42, 50]) expect(judge(r, v), String(v)).toBe("fix");
    for (const v of [8, 10, 14.9]) expect(judge(r, v), String(v)).toBe("fix");
    for (const v of [50.1, 90, 7.9, 0]) expect(judge(r, v), String(v)).toBe("fail");
  });

  it("样本不足:值算不出来,或分母小于 min_sample;不设 min_sample 时只看值", () => {
    const r = cfg.gate2.completion;
    expect(gateStatus(r, null, 100, 10)).toBe("insufficient");
    expect(gateStatus(r, 0.9, 9, 10)).toBe("insufficient");
    expect(gateStatus(r, 0.9, 10, 10)).toBe("pass");
    expect(gateStatus(cfg.gate1.waitlist_7d, 3, 1, null)).toBe("fail");
  });

  it("门槛文字", () => {
    expect(thresholdsText(cfg.gate1.waitlist_7d, "people")).toBe("过 ≥100 人 · 修 30–100 人 · 不过 <30 人");
    expect(thresholdsText(cfg.gate2.completion, "ratio")).toBe("过 ≥40% · 修 20–40% · 不过 <20%");
    expect(thresholdsText(cfg.gate2.median_minutes, "minutes")).toBe("过 15–35 分钟 · 修 35–50 或 8–15 分钟 · 不过 >50 或 <8 分钟");
    expect(thresholdsText(cfg.gate2.promoters, "ratio")).toBe("过 ≥30% · 修 15–30% · 不过 <15%");
    expect(thresholdsText(cfg.gate2.want_next, "ratio")).toBe("过 ≥60% · 修 40–60% · 不过 <40%");
    expect(thresholdsText(cfg.gate2.share, "ratio")).toBe("过 ≥15% · 修 5–15% · 不过 <5%");
    expect(thresholdsText(cfg.gate2.dispute, "ratio")).toBe("过 <20% · 修 20–40% · 不过 >40%");
    expect(thresholdsText(cfg.gate3.waitlist_to_paid, "ratio")).toBe("过 ≥5% · 修 2–5% · 不过 <2%");
    expect(thresholdsText({ pass_at_least: 0.025, fail_below: 0.01 }, "ratio")).toBe("过 ≥2.5% · 修 1–2.5% · 不过 <1%");
  });

  it("分位数:线性插值,P50 就是中位数", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 10);
  });
});

// ---------------------------------------------------------------- 第一关

describe("第一关:候补人数", () => {
  it("只数登记时间在范围内的(since 含、until 不含);没有样本门槛", () => {
    const wl = [
      ...waitlistOf(40),
      { email: "early@example.com", createdAt: atMin(-1) },
      { email: "edge-since@example.com", createdAt: WEEK.since! },
      { email: "edge-until@example.com", createdAt: WEEK.until! },
      { email: "late@example.com", createdAt: atMin(8 * DAY_MIN) },
    ];
    const m = metricOf(computeGates(input({ range: WEEK, waitlist: wl }), cfg), "waitlist_7d");
    expect(m).toMatchObject({ value: 41, display: "41 人", numerator: 41, denominator: 1, status: "fix", thresholds: "过 ≥100 人 · 修 30–100 人 · 不过 <30 人" });
    expect(m.label).toBe("首条内容 7 天内的候补名单人数");

    const status = (n: number) => metricOf(computeGates(input({ waitlist: waitlistOf(n) }), cfg), "waitlist_7d").status;
    expect(status(100)).toBe("pass");
    expect(status(99)).toBe("fix");
    expect(status(30)).toBe("fix");
    expect(status(29)).toBe("fail");
    expect(status(0)).toBe("fail");
    expect(metricOf(computeGates(input(), cfg), "waitlist_7d")).toMatchObject({ value: 0, display: "0 人" });
  });
});

// ---------------------------------------------------------------- 第二关

describe("第二关:体验", () => {
  it("完成率:开局时间在范围内的对局,出了复盘的 / 开局的", () => {
    const ss = [
      ...sessionsOf(20, 9),
      // 范围外的不算(含 until 那一刻开的)
      { id: "old", userId: "u", startedAt: atMin(-5), finished: true },
      { id: "edge", userId: "u", startedAt: WEEK.until!, finished: true },
    ];
    const m = metricOf(computeGates(input({ range: WEEK, sessions: ss }), cfg), "completion");
    expect(m).toMatchObject({ value: 0.45, display: "45%", numerator: 9, denominator: 20, status: "pass" });

    const status = (n: number, f: number) => metricOf(computeGates(input({ sessions: sessionsOf(n, f) }), cfg), "completion");
    expect(status(10, 4).status).toBe("pass");
    expect(status(10, 3)).toMatchObject({ status: "fix", display: "30%" });
    expect(status(10, 2).status).toBe("fix");
    expect(status(10, 1).status).toBe("fail");
    expect(status(9, 9)).toMatchObject({ value: 1, status: "insufficient" }); // 开局不到 10 局
    expect(status(0, 0)).toMatchObject({ value: null, display: "—", numerator: 0, denominator: 0, status: "insufficient" });
    expect(status(3, 2).display).toBe("66.7%");
  });

  it("在线时长:事件按时间排序后相邻间隔累加,每段最多按 idle_cap_minutes 计", () => {
    const evs = [
      ev("turn", atMin(32)),
      ev("session_created", atMin(0)),
      ev("action", atMin(5)),
      ev("session_finished", atMin(30)), // 5 → 30 的 25 分钟按 10 分钟计
    ];
    expect(activeMinutes(evs, 10)).toBe(5 + 10 + 2);
    expect(activeMinutes(evs, 30)).toBe(32);
    expect(activeMinutes([ev("session_finished", atMin(3))], 10)).toBe(0);
    expect(activeMinutes([], 10)).toBe(0);
    expect(activeMinutes([ev("turn", atSec(0)), ev("turn", atSec(90))], 10)).toBe(1.5);
  });

  it("中位时长:只看完成者,截断空闲,没有事件的老对局不计入样本", () => {
    const ss = sessionsOf(14, 12);
    const evs: Ev[] = [];
    // s0–s9:在线 10、12、20、25、30、40、45、50、55、60 分钟 → 中位数 (30 + 40) / 2 = 35 → 过(边界)
    [10, 12, 20, 25, 30, 40, 45, 50, 55, 60].forEach((t, i) => evs.push(...played(`s${i}`, t)));
    // s10:中间走开了 3 小时,只按 10 分钟算 → 5 + 10 + 5 = 20
    evs.push(ev("session_created", atMin(0), { sessionId: "s10" }), ev("turn", atMin(5), { sessionId: "s10" }));
    evs.push(ev("turn", atMin(185), { sessionId: "s10" }), ev("session_finished", atMin(190), { sessionId: "s10" }));
    // s11:第三轮之前开的老对局,没有事件 → 不计入;s12、s13 没完成 → 不看
    evs.push(...played("s12", 300), ...played("s13", 1));
    // 别的事件类型(看复盘、分享)不算在线
    evs.push(ev("report_viewed", atMin(900), { sessionId: "s0" }));

    const m = metricOf(computeGates(input({ sessions: ss, events: evs }), cfg), "median_minutes");
    // 样本 11 局:10、12、20、20、25、30、40、45、50、55、60 → 中位数 30
    expect(m).toMatchObject({ value: 30, display: "30 分钟", numerator: 30, denominator: 11, status: "pass" });
    expect(m.note).toContain("超过 10 分钟的按 10 分钟计");

    // 空闲上限改成 240 分钟:s10 算 190 分钟,中位数变成 40 → 修
    const loose = computeGates(input({ sessions: ss, events: evs }), { ...cfg, idle_cap_minutes: 240 });
    expect(metricOf(loose, "median_minutes")).toMatchObject({ value: 40, status: "fix" });
    expect(metricOf(loose, "median_minutes").note).toContain("超过 240 分钟的按 240 分钟计");
  });

  it("中位时长的四种状态,含「修」的两段区间和样本不足", () => {
    const median = (total: number, n = 10) => {
      const ss = sessionsOf(n, n);
      const evs = ss.flatMap((s) => played(s.id, total));
      return metricOf(computeGates(input({ sessions: ss, events: evs }), cfg), "median_minutes");
    };
    expect(median(20)).toMatchObject({ value: 20, status: "pass" });
    expect(median(40)).toMatchObject({ value: 40, status: "fix" }); // 35–50
    expect(median(10)).toMatchObject({ value: 10, status: "fix" }); // 8–15
    expect(median(60)).toMatchObject({ value: 60, status: "fail" });
    expect(median(5)).toMatchObject({ value: 5, status: "fail" });
    expect(median(20, 9)).toMatchObject({ value: 20, denominator: 9, status: "insufficient" });
    // 完成者都没有事件:算不出来
    expect(metricOf(computeGates(input({ sessions: sessionsOf(12, 12) }), cfg), "median_minutes")).toMatchObject({
      value: null,
      display: "—",
      numerator: 0,
      denominator: 0,
      status: "insufficient",
    });
    // 小数保留一位
    const ss = sessionsOf(1, 1);
    const odd = metricOf(computeGates(input({ sessions: ss, events: [ev("turn", atSec(0), { sessionId: "s0" }), ev("turn", atSec(1234), { sessionId: "s0" })] }), anySample), "median_minutes");
    expect(odd).toMatchObject({ value: 10, status: "fix" }); // 20.6 分钟的间隔按 10 分钟计
    const odd2 = metricOf(computeGates(input({ sessions: ss, events: [ev("turn", atSec(0), { sessionId: "s0" }), ev("turn", atSec(500), { sessionId: "s0" })] }), anySample), "median_minutes");
    expect(odd2).toMatchObject({ value: 8.3, display: "8.3 分钟", status: "fix" });
  });

  it("推荐者:每局看最近一次打的分,9–10 分算;没打分的算不推荐", () => {
    const ss = [...sessionsOf(10, 10), { id: "x", userId: "u", startedAt: atMin(70), finished: false }];
    const feedback = [
      fb("s0", 1, { rating: 9 }),
      fb("s1", 1, { rating: 10 }),
      fb("s2", 1, { rating: 10 }),
      fb("s2", 2, { rating: 6 }), // 后来改成 6 → 不算
      fb("s3", 1, { rating: 6 }),
      fb("s3", 2, { rating: 9 }), // 后来改成 9 → 算
      fb("s4", 1, { rating: 9 }),
      fb("s4", 2, {}), // 后来只写了文字(这条没有分数),分数还是 9
      fb("s5", 1, { rating: 8 }),
      fb("x", 1, { rating: 10 }), // 没完成的局不看
    ];
    const res = computeGates(input({ sessions: ss, feedback }), cfg);
    expect(metricOf(res, "promoters")).toMatchObject({ value: 0.4, display: "40%", numerator: 4, denominator: 10, status: "pass" });

    const rate = (n: number) =>
      metricOf(computeGates(input({ sessions: sessionsOf(10, 10), feedback: Array.from({ length: n }, (_, i) => fb(`s${i}`, 1, { rating: 10 })) }), cfg), "promoters");
    expect(rate(3).status).toBe("pass");
    expect(rate(2).status).toBe("fix");
    expect(rate(1).status).toBe("fail");
    expect(metricOf(computeGates(input({ sessions: sessionsOf(10, 0) }), cfg), "promoters")).toMatchObject({ value: null, denominator: 0, status: "insufficient" });
  });

  it("最近一次:同一时间的多条,排在前面的算新(和 listFeedback 的顺序一致)", () => {
    const { rating, wantNext } = latestAnswers([
      fb("a", 5, { rating: 7, wantNext: false }),
      fb("a", 5, { rating: 10, wantNext: true }),
      fb("a", 3, { rating: 2 }),
      fb("b", 1, { wantNext: true }),
    ]);
    expect(rating.get("a")).toBe(7);
    expect(wantNext.get("a")).toBe(false);
    expect(rating.has("b")).toBe(false);
    expect(wantNext.get("b")).toBe(true);
  });

  it("想玩下一个场景:每局看最近一次回答;分母是全部完成者", () => {
    const feedback = [
      fb("s0", 1, { wantNext: true }),
      fb("s1", 1, { wantNext: true }),
      fb("s2", 1, { wantNext: true }),
      fb("s2", 2, { wantNext: false }), // 改成不想
      fb("s3", 1, { wantNext: false }),
      fb("s3", 2, { wantNext: true }), // 改成想
      fb("s4", 1, { wantNext: true }),
      fb("s4", 2, { rating: 3 }), // 只打了分,回答不变
      fb("s5", 1, { wantNext: false }),
    ];
    const m = metricOf(computeGates(input({ sessions: sessionsOf(10, 10), feedback }), cfg), "want_next");
    expect(m).toMatchObject({ value: 0.4, numerator: 4, denominator: 10, status: "fix", label: "完成者中表示想玩下一个场景的比例" });

    const rate = (n: number) =>
      metricOf(computeGates(input({ sessions: sessionsOf(10, 10), feedback: Array.from({ length: n }, (_, i) => fb(`s${i}`, 1, { wantNext: true })) }), cfg), "want_next")
        .status;
    expect(rate(6)).toBe("pass");
    expect(rate(5)).toBe("fix");
    expect(rate(3)).toBe("fail");
  });

  it("分享:完成者中这一局保存过分享图或复制过分享文字的", () => {
    const evs = [
      ev("share_card_saved", atMin(500), { sessionId: "s0" }),
      ev("share_text_copied", atMin(500), { sessionId: "s1" }),
      ev("share_text_copied", atMin(501), { sessionId: "s1" }), // 同一局多次只算一次
      ev("report_viewed", atMin(500), { sessionId: "s2" }), // 看复盘不算分享
      ev("share_card_saved", atMin(500)), // 没有 sessionId 的不算
      ev("share_card_saved", atMin(500), { sessionId: "s10" }), // 没完成的局
      ev("share_card_saved", atMin(9 * DAY_MIN), { sessionId: "s3" }), // 分享发生在范围之后也算(范围只筛开局时间)
    ];
    const m = metricOf(computeGates(input({ range: WEEK, sessions: sessionsOf(12, 10), events: evs }), cfg), "share");
    expect(m).toMatchObject({ value: 0.3, numerator: 3, denominator: 10, status: "pass" });

    const rate = (n: number) =>
      metricOf(computeGates(input({ sessions: sessionsOf(10, 10), events: Array.from({ length: n }, (_, i) => ev("share_card_saved", atMin(500), { sessionId: `s${i}` })) }), cfg), "share")
        .status;
    expect(rate(2)).toBe("pass");
    expect(rate(1)).toBe("fix");
    expect(rate(0)).toBe("fail");
  });

  it("申诉率:完成者中提过申诉的(越低越好)", () => {
    const dispute = { dimension: "D3", reason: "我问过" };
    const rate = (n: number) =>
      metricOf(
        computeGates(
          input({
            sessions: sessionsOf(10, 10),
            feedback: [
              ...Array.from({ length: n }, (_, i) => fb(`s${i}`, 1, { dispute })),
              fb("s0", 2, { dispute }), // 同一局两次申诉只算一局
              fb("s9", 1, { rating: 3 }), // 只打分不算
            ],
          }),
          cfg,
        ),
        "dispute",
      );
    expect(rate(1)).toMatchObject({ value: 0.1, numerator: 1, denominator: 10, status: "pass" });
    expect(rate(2)).toMatchObject({ value: 0.2, status: "fix" });
    expect(rate(4)).toMatchObject({ value: 0.4, status: "fix" });
    expect(rate(5)).toMatchObject({ value: 0.5, status: "fail" });
  });
});

// ---------------------------------------------------------------- 第三关

describe("第三关:候补到付费", () => {
  it("范围内登记的候补里,邮箱对应的用户兑换过兑换码的人数 / 范围内候补人数", () => {
    const wl = [...waitlistOf(40), { email: "old@example.com", createdAt: atMin(-10) }];
    const userIdByEmail = new Map([
      ["w0@example.com", "u0"],
      ["w1@example.com", "u1"], // 注册了但没兑换
      ["old@example.com", "u-old"], // 兑换了,但不在范围内登记
    ]);
    const redeemers = new Set(["u0", "u-old", "u-stranger"]);
    const m = metricOf(computeGates(input({ range: WEEK, waitlist: wl, userIdByEmail, redeemers }), cfg), "waitlist_to_paid");
    expect(m).toMatchObject({ value: 0.025, display: "2.5%", numerator: 1, denominator: 40, status: "fix", thresholds: "过 ≥5% · 修 2–5% · 不过 <2%" });

    const run = (n: number, paid: number) =>
      metricOf(
        computeGates(
          input({
            waitlist: waitlistOf(n),
            userIdByEmail: new Map(waitlistOf(n).map((w, i) => [w.email, `u${i}`])),
            redeemers: new Set(Array.from({ length: paid }, (_, i) => `u${i}`)),
          }),
          cfg,
        ),
        "waitlist_to_paid",
      );
    expect(run(20, 1)).toMatchObject({ value: 0.05, status: "pass" });
    expect(run(100, 1)).toMatchObject({ value: 0.01, status: "fail" });
    expect(run(9, 9)).toMatchObject({ value: 1, status: "insufficient" });
    expect(run(0, 0)).toMatchObject({ value: null, display: "—", status: "insufficient" });
  });
});

// ---------------------------------------------------------------- 其他数字

describe("每轮耗时与第一句话", () => {
  it("每轮耗时:范围内 turn 事件的 latencyMs,P50 与 P90", () => {
    const evs = [
      ...Array.from({ length: 10 }, (_, i) => ev("turn", atMin(100 + i), { props: { latencyMs: (i + 1) * 1000 } })),
      ev("turn", atMin(-1), { props: { latencyMs: 99_999 } }), // 范围外
      ev("action", atMin(100), { props: { latencyMs: 50_000 } }), // 不是说话
      ev("turn", atMin(100), { props: { latencyMs: "fast" } }), // 不是数
      ev("turn", atMin(100), { props: {} }),
    ];
    const { extra } = computeGates(input({ range: WEEK, events: evs }), cfg);
    expect(extra.turnLatencyMsP50).toBe(5500);
    expect(extra.turnLatencyMsP90).toBe(9100);
    const none = computeGates(input({ range: WEEK }), cfg).extra;
    expect(none).toEqual({ turnLatencyMsP50: null, turnLatencyMsP90: null, firstTurnSecondsP50: null, firstTurnSample: 0 });
  });

  it("第一句话:最早登录的访客 → 它最早的落地页;和最早的一句话相减;顺序要对、间隔小于 24 小时", () => {
    const DAY = 24 * 60 * 60;
    const u = (id: string) => ({ userId: id });
    const v = (id: string) => ({ visitorId: id });
    const evs: Ev[] = [
      // A:落地页 100 → 第一句话 148 = 48 秒;之后的落地页、说话、换访客的登录都不影响
      ev("landing_viewed", atSec(100), v("vA")),
      ev("login", atSec(120), { ...u("A"), ...v("vA") }),
      ev("session_created", atSec(140), u("A")),
      ev("turn", atSec(148), u("A")),
      ev("landing_viewed", atSec(500), v("vA")),
      ev("turn", atSec(600), u("A")),
      ev("login", atSec(700), { ...u("A"), ...v("vA-2") }),
      ev("landing_viewed", atSec(690), v("vA-2")),
      // H:30 秒
      ev("landing_viewed", atSec(1000), v("vH")),
      ev("login", atSec(1010), { ...u("H"), ...v("vH") }),
      ev("session_created", atSec(1020), u("H")),
      ev("turn", atSec(1030), u("H")),
      // J:开局正好在 since 那一刻(含)→ 120 秒
      ev("landing_viewed", atSec(-60), v("vJ")),
      ev("login", atSec(-30), { ...u("J"), ...v("vJ") }),
      ev("session_created", atSec(0), u("J")),
      ev("turn", atSec(60), u("J")),
      // B:登录时没有访客 id → 不算
      ev("landing_viewed", atSec(190), v("vB")),
      ev("login", atSec(200), u("B")),
      ev("session_created", atSec(210), u("B")),
      ev("turn", atSec(220), u("B")),
      // C:落地页在第一句话之后 → 不算
      ev("login", atSec(300), { ...u("C"), ...v("vC") }),
      ev("session_created", atSec(310), u("C")),
      ev("turn", atSec(350), u("C")),
      ev("landing_viewed", atSec(400), v("vC")),
      // D:间隔正好 24 小时 → 不算
      ev("landing_viewed", atSec(0), v("vD")),
      ev("login", atSec(10), { ...u("D"), ...v("vD") }),
      ev("session_created", atSec(DAY - 10), u("D")),
      ev("turn", atSec(DAY), u("D")),
      // E:范围内没有开局(开局在 since 之前)→ 不算
      ev("landing_viewed", atSec(-2000), v("vE")),
      ev("login", atSec(-1900), { ...u("E"), ...v("vE") }),
      ev("session_created", atSec(-1000), u("E")),
      ev("turn", atSec(-990), u("E")),
      // F:最早那次登录的访客没有落地页记录(后来那次有)→ 不算
      ev("login", atSec(50), { ...u("F"), ...v("vF1") }),
      ev("login", atSec(60), { ...u("F"), ...v("vF2") }),
      ev("landing_viewed", atSec(40), v("vF2")),
      ev("session_created", atSec(70), u("F")),
      ev("turn", atSec(80), u("F")),
      // G:开了局但一句话没说 → 不算
      ev("landing_viewed", atSec(0), v("vG")),
      ev("login", atSec(5), { ...u("G"), ...v("vG") }),
      ev("session_created", atSec(6), u("G")),
      // I:开局正好在 until 那一刻(不含)→ 不算
      ev("landing_viewed", atSec(7 * DAY - 100), v("vI")),
      ev("login", atSec(7 * DAY - 50), { ...u("I"), ...v("vI") }),
      ev("session_created", atSec(7 * DAY), u("I")),
      ev("turn", atSec(7 * DAY + 10), u("I")),
    ];
    const shuffled = [...evs].reverse();
    expect(firstTurnSeconds(shuffled, WEEK).sort((a, b) => a - b)).toEqual([30, 48, 120]);
    expect(firstTurnVisitorIds(shuffled, WEEK)).toEqual(new Set(["vA", "vH", "vJ", "vC", "vD", "vF1", "vG"]));
    expect(computeGates(input({ range: WEEK, events: shuffled }), cfg).extra).toMatchObject({ firstTurnSecondsP50: 48, firstTurnSample: 3 });
    // 不限范围:E(1010 秒)、I(110 秒)也算进来
    expect(firstTurnSeconds(evs, ALL).sort((a, b) => a - b)).toEqual([30, 48, 110, 120, 1010]);
  });
});

describe("时间范围参数", () => {
  const params = (q: string) => parseGatesRange(new URLSearchParams(q));

  it("ISO 时间(Z 或带时区)转成 UTC 的 ISO;省略或空为 null", () => {
    expect(params("")).toEqual({ since: null, until: null });
    expect(params("since=&until=")).toEqual({ since: null, until: null });
    expect(params(`since=${encodeURIComponent("2026-10-01T00:00:00+08:00")}&until=2026-10-08T00:00:00Z`)).toEqual({
      since: "2026-09-30T16:00:00.000Z",
      until: "2026-10-08T00:00:00.000Z",
    });
  });

  it("不是 ISO 时间、开始晚于结束 → 400", () => {
    for (const q of ["since=2026-10-01", "since=yesterday", "until=2026-10-01T00:00:00", "since=2026-10-08T00:00:00Z&until=2026-10-01T00:00:00Z"]) {
      expect(() => params(q), q).toThrow(expect.objectContaining({ code: "bad_request" }));
    }
  });
});

// ---------------------------------------------------------------- 接口

describe("GET /api/admin/gates", () => {
  const ENV_KEYS = ["FDE_ROOT", "FDE_ENGINE_MODE", "FDE_DEV_LOGIN_CODES", "FDE_MEMORY_STORE_FILE", "ADMIN_EMAILS", "FDE_AUTH_SECRET", "DATABASE_URL", "FDE_GATES_CONFIG", "FDE_DAILY_SESSION_LIMIT"] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let admin: Client;
  let player: Client;
  let finished = "";
  let playerId = "";

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, {
      FDE_ROOT: ROOT,
      FDE_ENGINE_MODE: "offline",
      FDE_DEV_LOGIN_CODES: "1",
      FDE_MEMORY_STORE_FILE: join(tmp, "store.json"),
      ADMIN_EMAILS: "admin@example.com",
      FDE_AUTH_SECRET: "test-secret",
    });
    await resetForTests();
    resetEventQuotaForTests();
  });

  afterAll(async () => {
    await resetForTests();
    resetEventQuotaForTests();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** 登录;visitorId 给出时带着访客 cookie 登录(login 事件记下访客),之后的请求也带着。 */
  async function login(email: string, visitorId?: string): Promise<Client> {
    const store = await getStore();
    const [invite] = await store.createInvites(1, 1);
    const vc = visitorId ? `fde_vid=${visitorId}` : undefined;
    const c = new Client(vc);
    const r1 = await c.post<RequestCodeResponse>(requestCode.POST, { body: { email, inviteCode: invite } });
    expect(r1.status).toBe(200);
    // 新用户的邀请码在验证通过时才消耗,校验时也要带上
    expect((await c.post(verify.POST, { body: { email, code: r1.body.devCode, inviteCode: invite } })).status).toBe(200);
    if (vc) c.cookie = `${c.cookie}; ${vc}`;
    return c;
  }

  it("没登录 401,不是管理员 403", async () => {
    admin = await login("admin@example.com");
    const anon = await new Client().get(adminGates.GET, { path: "/api/admin/gates" });
    expect(anon.status).toBe(401);
    expect(errorCode(anon)).toBe("unauthorized");

    // 玩家:先匿名打开落地页拿到访客 cookie,再带着它登录
    const landing = await new Client().post(events.POST, { body: { type: "landing_viewed" } });
    const visitorId = /^fde_vid=([^;]+)/.exec(landing.res.headers.get("set-cookie") ?? "")![1]!;
    player = await login("player@example.com", visitorId);
    playerId = (await (await getStore()).getUserByEmail("player@example.com"))!.id;
    const forbidden = await player.get(adminGates.GET, { path: "/api/admin/gates" });
    expect(forbidden.status).toBe(403);
    expect(errorCode(forbidden)).toBe("forbidden");
  });

  it("从存储取数:开局、说话、收工、反馈、分享、候补、兑换都算进去", async () => {
    const sid = (id: string) => ({ params: { id } });
    expect((await player.post(consent.POST)).status).toBe(200);
    const s1 = await player.post<CreateSessionResponse>(sessions.POST, { body: { scenarioId: "freight-docs" } });
    finished = s1.body.sessionId;
    expect((await player.post(turns.POST, { ...sid(finished), body: { text: "周总您好。为什么现在想做这件事?" } })).status).toBe(200);
    expect((await player.post(finish.POST, sid(finished))).status).toBe(200);
    expect((await player.post(feedback.POST, { ...sid(finished), body: { rating: 10, wantNext: true } })).status).toBe(201);
    expect((await player.post(feedback.POST, { ...sid(finished), body: { dispute: { dimension: "D3", reason: "我问过" } } })).status).toBe(201);
    expect((await player.post(events.POST, { body: { type: "share_text_copied", sessionId: finished } })).status).toBe(204);
    // 第二局开了没收工
    expect((await player.post(sessions.POST, { body: { scenarioId: "freight-docs" } })).status).toBe(201);

    const store = await getStore();
    const now = new Date().toISOString();
    await store.addToWaitlist({ email: "player@example.com", role: null, note: null, source: null, createdAt: now });
    await store.addToWaitlist({ email: "someone@example.com", role: null, note: null, source: "xhs", createdAt: now });
    const [code] = await store.createRedeemCodes("sprint", 1);
    expect(await store.redeemCode(code!, playerId, now)).not.toBeNull();

    const r = await admin.get<GatesResponse>(adminGates.GET, { path: "/api/admin/gates" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.range).toEqual({ since: null, until: null });
    expect(r.body.gate1.map((m) => m.id)).toEqual(["waitlist_7d"]);
    expect(r.body.gate2.map((m) => m.id)).toEqual(["completion", "median_minutes", "promoters", "want_next", "share", "dispute"]);
    expect(r.body.gate3.map((m) => m.id)).toEqual(["waitlist_to_paid"]);
    expect(metricOf(r.body, "waitlist_7d")).toMatchObject({ value: 2, status: "fail" });
    expect(metricOf(r.body, "completion")).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, status: "insufficient" });
    expect(metricOf(r.body, "median_minutes")).toMatchObject({ denominator: 1, status: "insufficient" });
    expect(metricOf(r.body, "promoters")).toMatchObject({ numerator: 1, denominator: 1 });
    expect(metricOf(r.body, "want_next")).toMatchObject({ numerator: 1, denominator: 1 });
    expect(metricOf(r.body, "share")).toMatchObject({ numerator: 1, denominator: 1 });
    expect(metricOf(r.body, "dispute")).toMatchObject({ numerator: 1, denominator: 1 });
    expect(metricOf(r.body, "waitlist_to_paid")).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, status: "insufficient" });
    for (const m of [...r.body.gate1, ...r.body.gate2, ...r.body.gate3]) {
      expect(m.label).toBeTruthy();
      expect(m.thresholds).toMatch(/^过 .* · 修 .* · 不过 /);
      expect(m.note).toBeTruthy();
    }
    expect(typeof r.body.extra.turnLatencyMsP50).toBe("number");
    expect(typeof r.body.extra.turnLatencyMsP90).toBe("number");
    // 落地页 → 登录 → 第一句话:测试里几乎是同时发生的
    expect(r.body.extra.firstTurnSample).toBe(1);
    expect(r.body.extra.firstTurnSecondsP50).toBeGreaterThanOrEqual(0);
    expect(r.body.extra.firstTurnSecondsP50).toBeLessThan(60);
  });

  it("时间范围:按开局 / 登记时间筛;范围原样(转成 UTC)返回;不合法 400", async () => {
    const future = "2099-01-01T00:00:00+08:00";
    const r = await admin.get<GatesResponse>(adminGates.GET, { path: `/api/admin/gates?since=${encodeURIComponent(future)}` });
    expect(r.status).toBe(200);
    expect(r.body.range).toEqual({ since: "2098-12-31T16:00:00.000Z", until: null });
    expect(metricOf(r.body, "waitlist_7d")).toMatchObject({ value: 0, status: "fail" });
    expect(metricOf(r.body, "completion")).toMatchObject({ value: null, numerator: 0, denominator: 0, status: "insufficient" });
    expect(r.body.extra).toEqual({ turnLatencyMsP50: null, turnLatencyMsP90: null, firstTurnSecondsP50: null, firstTurnSample: 0 });

    const past = await admin.get<GatesResponse>(adminGates.GET, { path: "/api/admin/gates?since=2020-01-01T00:00:00Z&until=2099-01-01T00:00:00Z" });
    expect(metricOf(past.body, "completion")).toMatchObject({ numerator: 1, denominator: 2 });

    for (const q of ["since=2026-10-01", "until=not-a-date", "since=2099-01-02T00:00:00Z&until=2099-01-01T00:00:00Z"]) {
      const bad = await admin.get(adminGates.GET, { path: `/api/admin/gates?${q}` });
      expect(bad.status, q).toBe(400);
      expect(errorCode(bad)).toBe("bad_request");
    }
  });

  it("门槛配置写错或找不到:500,并告诉管理员是哪一项", async () => {
    const original = console.error;
    console.error = () => undefined; // 这里的错误日志是预期内的
    try {
      process.env.FDE_GATES_CONFIG = writeConfig("route-typo.yaml", repoYaml.replace("  share:", "  shares:"));
      const typo = await admin.get<{ error: { code: string; message: string } }>(adminGates.GET, { path: "/api/admin/gates" });
      expect(typo.status).toBe(500);
      expect(typo.body.error.code).toBe("internal");
      expect(typo.body.error.message).toContain("shares");

      process.env.FDE_GATES_CONFIG = join(tmp, "does-not-exist.yaml");
      const missing = await admin.get<{ error: { code: string; message: string } }>(adminGates.GET, { path: "/api/admin/gates" });
      expect(missing.status).toBe(500);
      expect(missing.body.error.message).toContain("找不到门槛配置");

      // 门槛改了立刻生效(每次请求都重新读)
      process.env.FDE_GATES_CONFIG = writeConfig("route-low.yaml", repoYaml.replace("pass_at_least: 100", "pass_at_least: 2").replace("fail_below: 30", "fail_below: 1"));
      const low = await admin.get<GatesResponse>(adminGates.GET, { path: "/api/admin/gates" });
      expect(metricOf(low.body, "waitlist_7d")).toMatchObject({ value: 2, status: "pass", thresholds: "过 ≥2 人 · 修 1–2 人 · 不过 <1 人" });
    } finally {
      console.error = original;
      delete process.env.FDE_GATES_CONFIG;
    }
  });
});
