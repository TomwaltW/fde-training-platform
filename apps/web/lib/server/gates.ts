// 方案 6.3「继续、转向、放弃」的指标(第三轮):门槛配置 config/gates.yaml 的读取与校验、各项指标的计算。
// 口径见 docs/dev-spec-r3-2026-10-05.md 2.1 节「埋点与指标」。
// 计算部分是纯函数(输入普通数据,不碰存储),单测直接喂构造的数据;gatherGatesInput() 负责从存储里取数。
import { existsSync, readFileSync } from "node:fs";
import type { GateMetric, GateStatus, GatesResponse, Store, StoredEvent, StoredFeedback, WaitlistEntry } from "@fde/contracts";
import { parse } from "yaml";
import { z } from "zod";
import { allSessions, median } from "./admin.ts";
import { gatesConfigPath } from "./env.ts";
import { HttpError } from "./http.ts";

// ---------------------------------------------------------------- 门槛配置

const ratio = z.number().min(0).max(1);
const people = z.number().int().min(0);
const minutes = z.number().min(0);

/** 越高越好:值 ≥ pass_at_least 过;值 < fail_below 不过;其余修。 */
function atLeast(n: z.ZodNumber) {
  return z
    .strictObject({ pass_at_least: n, fail_below: n })
    .refine((r) => r.fail_below <= r.pass_at_least, "fail_below 不能大于 pass_at_least");
}

/** 越低越好:值 < pass_below 过;值 > fail_above 不过;其余修。 */
function below(n: z.ZodNumber) {
  return z
    .strictObject({ pass_below: n, fail_above: n })
    .refine((r) => r.pass_below <= r.fail_above, "pass_below 不能大于 fail_above");
}

/** 落在区间里最好:pass_between 内(含两端)过;fail_outside 外不过;其余修。 */
function between(n: z.ZodNumber) {
  return z
    .strictObject({ pass_between: z.tuple([n, n]), fail_outside: z.tuple([n, n]) })
    .refine(
      ({ pass_between: [a, b], fail_outside: [c, d] }) => c <= a && a <= b && b <= d,
      "要满足 fail_outside[0] ≤ pass_between[0] ≤ pass_between[1] ≤ fail_outside[1]",
    );
}

/** 键名拼错、少键、比例写成百分数、上下限颠倒都直接报错。 */
export const GatesConfigSchema = z.strictObject({
  /** 分母小于它时不下结论(第一关不设)。 */
  min_sample: z.number().int().min(1).default(10),
  /** 在线时长里相邻两次操作的间隔最多按多少分钟计。 */
  idle_cap_minutes: z.number().positive().default(10),
  gate1: z.strictObject({ waitlist_7d: atLeast(people) }),
  gate2: z.strictObject({
    completion: atLeast(ratio),
    median_minutes: between(minutes),
    promoters: atLeast(ratio),
    want_next: atLeast(ratio),
    share: atLeast(ratio),
    dispute: below(ratio),
  }),
  gate3: z.strictObject({ waitlist_to_paid: atLeast(ratio) }),
});
export type GatesConfig = z.infer<typeof GatesConfigSchema>;

export type GateRule =
  | { pass_at_least: number; fail_below: number }
  | { pass_below: number; fail_above: number }
  | { pass_between: [number, number]; fail_outside: [number, number] };

/** 读 config/gates.yaml(或 FDE_GATES_CONFIG)。不存在或写错时抛错,错误信息里列出哪一项不对。 */
export function loadGatesConfig(path: string = gatesConfigPath()): GatesConfig {
  if (!existsSync(path)) throw new Error(`找不到门槛配置 ${path}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`门槛配置 ${path} 不是合法的 YAML:${e instanceof Error ? e.message : String(e)}`);
  }
  const r = GatesConfigSchema.safeParse(raw ?? {});
  if (!r.success) {
    throw new Error(`门槛配置 ${path} 有误:\n${r.error.issues.map((i) => `  - ${i.path.join(".") || "(根)"}: ${i.message}`).join("\n")}`);
  }
  return r.data;
}

/** 接口里用:配置有问题时打日志,并把原因直接告诉管理员(而不是笼统的"服务器出错了")。 */
export function gatesConfigForRequest(): GatesConfig {
  try {
    return loadGatesConfig();
  } catch (e) {
    console.error("[gates] 门槛配置读取失败", e);
    throw new HttpError("internal", e instanceof Error ? e.message : "门槛配置读取失败");
  }
}

// ---------------------------------------------------------------- 时间范围

export interface GatesRange {
  /** 含。 */
  since: string | null;
  /** 不含。 */
  until: string | null;
}

const isoDateTime = z.iso.datetime({ offset: true });

/** GET /api/admin/gates 的 since / until:ISO 8601(带 Z 或时区),都可省略;不合法 400。 */
export function parseGatesRange(params: URLSearchParams): GatesRange {
  const read = (name: "since" | "until"): string | null => {
    const raw = params.get(name)?.trim();
    if (!raw) return null;
    if (!isoDateTime.safeParse(raw).success) throw new HttpError("bad_request", `${name} 要是 ISO 8601 时间,比如 2026-10-01T00:00:00+08:00`);
    return new Date(raw).toISOString();
  };
  const since = read("since");
  const until = read("until");
  if (since && until && Date.parse(since) > Date.parse(until)) throw new HttpError("bad_request", "开始时间不能晚于结束时间");
  return { since, until };
}

function inRange(at: string, range: GatesRange): boolean {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  if (range.since !== null && t < Date.parse(range.since)) return false;
  if (range.until !== null && t >= Date.parse(range.until)) return false;
  return true;
}

// ---------------------------------------------------------------- 判定与展示

/** 不看样本量,只按门槛判过 / 修 / 不过。 */
export function judge(rule: GateRule, value: number): Exclude<GateStatus, "insufficient"> {
  if ("pass_at_least" in rule) return value >= rule.pass_at_least ? "pass" : value < rule.fail_below ? "fail" : "fix";
  if ("pass_below" in rule) return value < rule.pass_below ? "pass" : value > rule.fail_above ? "fail" : "fix";
  const [a, b] = rule.pass_between;
  const [c, d] = rule.fail_outside;
  if (value >= a && value <= b) return "pass";
  return value < c || value > d ? "fail" : "fix";
}

/** 值算不出来,或分母小于 minSample(null 表示不设)时为 insufficient。 */
export function gateStatus(rule: GateRule, value: number | null, denominator: number, minSample: number | null): GateStatus {
  if (value === null || !Number.isFinite(value)) return "insufficient";
  if (minSample !== null && denominator < minSample) return "insufficient";
  return judge(rule, value);
}

type Unit = "ratio" | "people" | "minutes";

const round1 = (x: number) => Math.round(x * 10) / 10;
/** 0.4 → "40";0.025 → "2.5"。 */
const pct = (x: number) => String(round1(x * 100));

function num(x: number, unit: Unit): string {
  return unit === "ratio" ? pct(x) : String(round1(x));
}
const SUFFIX: Record<Unit, string> = { ratio: "%", people: " 人", minutes: " 分钟" };

/** 给人看的门槛,如 "过 ≥40% · 修 20–40% · 不过 <20%"。 */
export function thresholdsText(rule: GateRule, unit: Unit): string {
  const n = (x: number) => num(x, unit);
  const s = SUFFIX[unit];
  if ("pass_at_least" in rule) return `过 ≥${n(rule.pass_at_least)}${s} · 修 ${n(rule.fail_below)}–${n(rule.pass_at_least)}${s} · 不过 <${n(rule.fail_below)}${s}`;
  if ("pass_below" in rule) return `过 <${n(rule.pass_below)}${s} · 修 ${n(rule.pass_below)}–${n(rule.fail_above)}${s} · 不过 >${n(rule.fail_above)}${s}`;
  const [a, b] = [n(rule.pass_between[0]), n(rule.pass_between[1])];
  const [c, d] = [n(rule.fail_outside[0]), n(rule.fail_outside[1])];
  return `过 ${a}–${b}${s} · 修 ${b}–${d} 或 ${c}–${a}${s} · 不过 >${d} 或 <${c}${s}`;
}

function displayValue(value: number | null, unit: Unit): string {
  if (value === null) return "—";
  return `${num(value, unit)}${SUFFIX[unit]}`;
}

function metric(m: {
  id: string;
  label: string;
  unit: Unit;
  rule: GateRule;
  value: number | null;
  numerator: number;
  denominator: number;
  minSample: number | null;
  note: string;
}): GateMetric {
  return {
    id: m.id,
    label: m.label,
    value: m.value,
    display: displayValue(m.value, m.unit),
    numerator: m.numerator,
    denominator: m.denominator,
    status: gateStatus(m.rule, m.value, m.denominator, m.minSample),
    thresholds: thresholdsText(m.rule, m.unit),
    note: m.note,
  };
}

const ratioOf = (n: number, d: number): number | null => (d > 0 ? n / d : null);

// ---------------------------------------------------------------- 计算(纯函数)

type EventLike = Pick<StoredEvent, "at" | "type" | "userId" | "sessionId" | "visitorId" | "props">;

export interface GatesInput {
  range: GatesRange;
  /** 候补名单(可以给全部,函数按 range 筛)。 */
  waitlist: Pick<WaitlistEntry, "email" | "createdAt">[];
  /** 候补邮箱(小写)→ 用户 id;没注册的不在里面。 */
  userIdByEmail: ReadonlyMap<string, string>;
  /** 兑换过任何兑换码的用户 id。 */
  redeemers: ReadonlySet<string>;
  /** 对局(可以给全部,函数按开局时间筛);finished = 出了复盘。 */
  sessions: { id: string; userId: string; startedAt: string; finished: boolean }[];
  /** 反馈。同一时间的多条,排在前面的算新(和 Store.listFeedback 的顺序一致)。 */
  feedback: Pick<StoredFeedback, "sessionId" | "rating" | "dispute" | "wantNext" | "createdAt">[];
  /** 相关事件,顺序不限(函数自己按时间排)。 */
  events: EventLike[];
}

/** 算在线时长用的事件:开局、说话、动作、收工。 */
export const ACTIVITY_EVENT_TYPES = ["session_created", "turn", "action", "session_finished"] as const;
export const SHARE_EVENT_TYPES = ["share_card_saved", "share_text_copied"] as const;

/** 按时间从早到晚(同一时间保持原顺序)。 */
function byTime<T extends { at: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** 一局的实际在线时长(分钟):事件按时间排序,相邻两条的间隔累加,每段最多按 idleCapMinutes 计。 */
export function activeMinutes(events: readonly Pick<StoredEvent, "at">[], idleCapMinutes: number): number {
  const ts = byTime(events).map((e) => Date.parse(e.at));
  const cap = idleCapMinutes * 60_000;
  let ms = 0;
  for (let i = 1; i < ts.length; i++) ms += Math.min(cap, Math.max(0, ts[i]! - ts[i - 1]!));
  return ms / 60_000;
}

/** 线性插值的分位数(p = 0.5 时就是中位数,偶数个取中间两个的平均)。 */
export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

/** 每局最近一次的推荐分、最近一次的"想不想玩下一个场景"(各自取最近一条填了该项的反馈)。 */
export function latestAnswers(feedback: GatesInput["feedback"]): { rating: Map<string, number>; wantNext: Map<string, boolean> } {
  const newestFirst = [...feedback].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const rating = new Map<string, number>();
  const wantNext = new Map<string, boolean>();
  for (const f of newestFirst) {
    if (f.rating !== null && !rating.has(f.sessionId)) rating.set(f.sessionId, f.rating);
    if (f.wantNext !== null && !wantNext.has(f.sessionId)) wantNext.set(f.sessionId, f.wantNext);
  }
  return { rating, wantNext };
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * 新用户从第一次打开落地页到说出第一句话的秒数(每人一个样本)。
 * 范围内有 session_created 的用户 → 他最早的 login 事件的 visitorId → 该访客最早的 landing_viewed;
 * 和该用户最早的 turn 相减。只算两者都有、落地页在先、间隔小于 24 小时的。
 */
export function firstTurnSeconds(events: readonly EventLike[], range: GatesRange): number[] {
  const users = new Set<string>();
  for (const e of events) if (e.type === "session_created" && e.userId && inRange(e.at, range)) users.add(e.userId);
  const firstLogin = new Map<string, EventLike>();
  const firstTurn = new Map<string, EventLike>();
  const firstLanding = new Map<string, EventLike>();
  for (const e of byTime(events)) {
    if (e.type === "login" && e.userId && !firstLogin.has(e.userId)) firstLogin.set(e.userId, e);
    if (e.type === "turn" && e.userId && !firstTurn.has(e.userId)) firstTurn.set(e.userId, e);
    if (e.type === "landing_viewed" && e.visitorId && !firstLanding.has(e.visitorId)) firstLanding.set(e.visitorId, e);
  }
  const out: number[] = [];
  for (const u of users) {
    const visitorId = firstLogin.get(u)?.visitorId;
    if (!visitorId) continue;
    const landing = firstLanding.get(visitorId);
    const turn = firstTurn.get(u);
    if (!landing || !turn) continue;
    const seconds = (Date.parse(turn.at) - Date.parse(landing.at)) / 1000;
    if (seconds >= 0 && seconds < DAY_SECONDS) out.push(seconds);
  }
  return out;
}

/** 算 firstTurnSeconds 需要哪些访客的 landing_viewed(范围内开过局的用户最早登录时的访客 id)。 */
export function firstTurnVisitorIds(events: readonly EventLike[], range: GatesRange): Set<string> {
  const users = new Set<string>();
  for (const e of events) if (e.type === "session_created" && e.userId && inRange(e.at, range)) users.add(e.userId);
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const e of byTime(events)) {
    if (e.type !== "login" || !e.userId || seen.has(e.userId)) continue;
    seen.add(e.userId);
    if (users.has(e.userId) && e.visitorId) out.add(e.visitorId);
  }
  return out;
}

export function computeGates(input: GatesInput, cfg: GatesConfig): GatesResponse {
  const { range } = input;
  const minSample = cfg.min_sample;

  // ---- 第一关:范围内登记的候补人数
  const waitlist = input.waitlist.filter((w) => inRange(w.createdAt, range));
  const gate1 = [
    metric({
      id: "waitlist_7d",
      label: "首条内容 7 天内的候补名单人数",
      unit: "people",
      rule: cfg.gate1.waitlist_7d,
      value: waitlist.length,
      numerator: waitlist.length,
      denominator: 1,
      minSample: null,
      note: "所选时间范围内登记候补名单的人数。看第一关时,把范围选成首条内容发布后的 7 天。",
    }),
  ];

  // ---- 第二关:开局时间在范围内的对局
  const started = input.sessions.filter((s) => inRange(s.startedAt, range));
  const finished = started.filter((s) => s.finished);
  const finishedIds = new Set(finished.map((s) => s.id));
  const nFinished = finished.length;

  const activity = new Map<string, EventLike[]>();
  const shared = new Set<string>();
  const activityTypes = new Set<string>(ACTIVITY_EVENT_TYPES);
  const shareTypes = new Set<string>(SHARE_EVENT_TYPES);
  for (const e of input.events) {
    if (!e.sessionId || !finishedIds.has(e.sessionId)) continue;
    if (activityTypes.has(e.type)) {
      const list = activity.get(e.sessionId) ?? [];
      list.push(e);
      activity.set(e.sessionId, list);
    }
    if (shareTypes.has(e.type)) shared.add(e.sessionId);
  }
  // 只算从开局到收工都有事件的对局:第三轮上线前开的老对局只有后半段的事件,算出来会偏短,不计入样本
  const durations = finished.flatMap((s) => {
    const evs = activity.get(s.id);
    const complete = evs?.some((e) => e.type === "session_created") && evs.some((e) => e.type === "session_finished");
    return complete ? [activeMinutes(evs!, cfg.idle_cap_minutes)] : [];
  });
  const medianRaw = median(durations);
  const medianMinutes = medianRaw === null ? null : round1(medianRaw);

  const { rating, wantNext } = latestAnswers(input.feedback);
  const promoters = finished.filter((s) => (rating.get(s.id) ?? -1) >= 9).length;
  const wantsNext = finished.filter((s) => wantNext.get(s.id) === true).length;
  const disputed = new Set(input.feedback.filter((f) => f.dispute).map((f) => f.sessionId));
  const nDisputed = finished.filter((s) => disputed.has(s.id)).length;
  const nShared = finished.filter((s) => shared.has(s.id)).length;
  const cap = round1(cfg.idle_cap_minutes);

  const gate2 = [
    metric({
      id: "completion",
      label: "开局到看到复盘的完成率",
      unit: "ratio",
      rule: cfg.gate2.completion,
      value: ratioOf(nFinished, started.length),
      numerator: nFinished,
      denominator: started.length,
      minSample,
      note: "开局时间在范围内的对局里,出了复盘的 / 开局数。",
    }),
    metric({
      id: "median_minutes",
      label: "完成者的中位时长",
      unit: "minutes",
      rule: cfg.gate2.median_minutes,
      value: medianMinutes,
      numerator: medianMinutes ?? 0,
      denominator: durations.length,
      minSample,
      note: `完成者的实际在线时长:开局、说话、动作、收工按时间排序,相邻两次的间隔累加,超过 ${cap} 分钟的按 ${cap} 分钟计;没有事件记录的老对局不计入。分母是计入的局数。`,
    }),
    metric({
      id: "promoters",
      label: "完成者中打 9–10 分推荐意愿的比例",
      unit: "ratio",
      rule: cfg.gate2.promoters,
      value: ratioOf(promoters, nFinished),
      numerator: promoters,
      denominator: nFinished,
      minSample,
      note: "看每局最近一次打的推荐分;分母是全部完成者(没打分的按不推荐计)。",
    }),
    metric({
      id: "want_next",
      label: "完成者中表示想玩下一个场景的比例",
      unit: "ratio",
      rule: cfg.gate2.want_next,
      value: ratioOf(wantsNext, nFinished),
      numerator: wantsNext,
      denominator: nFinished,
      minSample,
      note: "看每局最近一次的回答;分母是全部完成者(没回答的按不想计)。",
    }),
    metric({
      id: "share",
      label: "完成者中主动分享复盘卡的比例",
      unit: "ratio",
      rule: cfg.gate2.share,
      value: ratioOf(nShared, nFinished),
      numerator: nShared,
      denominator: nFinished,
      minSample,
      note: "这一局保存过分享图或复制过分享文字的完成者 / 全部完成者。",
    }),
    metric({
      id: "dispute",
      label: "对评分提出申诉的比例",
      unit: "ratio",
      rule: cfg.gate2.dispute,
      value: ratioOf(nDisputed, nFinished),
      numerator: nDisputed,
      denominator: nFinished,
      minSample,
      note: "对任一维度提出过申诉的完成者 / 全部完成者。",
    }),
  ];

  // ---- 第三关:范围内登记的候补里,同一邮箱注册后兑换过兑换码的
  const paid = waitlist.filter((w) => {
    const userId = input.userIdByEmail.get(w.email.toLowerCase());
    return userId !== undefined && input.redeemers.has(userId);
  }).length;
  const gate3 = [
    metric({
      id: "waitlist_to_paid",
      label: "候补名单到预售付费的转化",
      unit: "ratio",
      rule: cfg.gate3.waitlist_to_paid,
      value: ratioOf(paid, waitlist.length),
      numerator: paid,
      denominator: waitlist.length,
      minSample,
      note: "范围内登记的候补里,用同一邮箱登录并兑换过任何兑换码的人数 / 范围内登记的候补人数。",
    }),
  ];

  // ---- 其他:每轮耗时、新用户到第一句话的时间
  const latencies = input.events.flatMap((e) => {
    const ms = e.props.latencyMs;
    return e.type === "turn" && inRange(e.at, range) && typeof ms === "number" && Number.isFinite(ms) ? [ms] : [];
  });
  const roundOrNull = (x: number | null) => (x === null ? null : Math.round(x));
  const firstTurn = firstTurnSeconds(input.events, range);

  return {
    range,
    gate1,
    gate2,
    gate3,
    extra: {
      turnLatencyMsP50: roundOrNull(percentile(latencies, 0.5)),
      turnLatencyMsP90: roundOrNull(percentile(latencies, 0.9)),
      firstTurnSecondsP50: roundOrNull(percentile(firstTurn, 0.5)),
      firstTurnSample: firstTurn.length,
    },
  };
}

// ---------------------------------------------------------------- 从存储取数

/** 指标要用的事件类型(落地页事件量大,另按访客单独查)。 */
const EVENT_TYPES = [...ACTIVITY_EVENT_TYPES, ...SHARE_EVENT_TYPES, "login"];

export async function gatherGatesInput(store: Store, range: GatesRange): Promise<GatesInput> {
  const [waitlistAll, sessionsAll, feedback, codes, events] = await Promise.all([
    store.listWaitlist(),
    allSessions(store),
    store.listFeedback(),
    store.listRedeemCodes(),
    store.listEvents({ types: EVENT_TYPES }),
  ]);

  const waitlist = waitlistAll.filter((w) => inRange(w.createdAt, range));
  const userIdByEmail = new Map<string, string>();
  await Promise.all(
    waitlist.map(async (w) => {
      const u = await store.getUserByEmail(w.email);
      if (u) userIdByEmail.set(w.email.toLowerCase(), u.id);
    }),
  );
  const redeemers = new Set(codes.flatMap((c) => (c.redeemedBy ? [c.redeemedBy] : [])));

  const inRangeSessions = sessionsAll.filter((s) => inRange(s.startedAt, range));
  const reports = await Promise.all(inRangeSessions.map((s) => store.getReport(s.id)));
  const sessions = inRangeSessions.map((s, i) => ({ id: s.id, userId: s.userId, startedAt: s.startedAt, finished: reports[i] !== null }));

  const landings = await Promise.all(
    [...firstTurnVisitorIds(events, range)].map((visitorId) => store.listEvents({ visitorId, types: ["landing_viewed"], limit: 1 })),
  );

  return { range, waitlist, userIdByEmail, redeemers, sessions, feedback, events: [...events, ...landings.flat()] };
}

export async function computeGatesFromStore(store: Store, range: GatesRange, cfg: GatesConfig): Promise<GatesResponse> {
  return computeGates(await gatherGatesInput(store, range), cfg);
}
