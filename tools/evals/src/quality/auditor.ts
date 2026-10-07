// 交付文本审计:逐条检查实际出给用户的角色台词(守卫放行的、或兜底台词),独立于守卫。
// 守卫审不了自己:它在出口前按"演员上下文"做白名单,口语约数(四百多、三成、几十万、两成多)和它的白名单漏洞
// 都会漏过去。这里换一套依据——只看会话状态里"用户此刻正当拥有的信息"——重新判一遍:
//   (a) 泄露候选:数字等于或约等于还没解锁的真值;或者出现了还没解锁的事实的金丝雀词
//   (b) 白名单外的数字:不在本轮允许集合里,也对不上任何真值(编造)
// 允许集合 = 公共背景与开场 + 当前角色的人设卡 + 用户已拿到的事实(L1 只算印象原话)+ 本轮导演指令(含压力时刻台词)
//          + 已触发压力时刻的台词 + 用户看到过的旁白与资料标题 + 用户自己说过、写过的话 + 承诺账本。
// 之前角色说过的话不算允许来源:否则第 3 轮的泄露会把第 5 轮的同一句洗白。
// 守卫的拦截(guard_block)和兜底(guard_fallback)单独作为诊断报告,不参与这里的判定。
import { foldWidth, type LoadedScenario, type SessionState, type TurnResult } from "@fde/engine";
import { extractQuantities, isRound, showQuantity, type Quantity } from "./numerals.ts";

export interface AuditIssue {
  kind: "leak" | "unlisted";
  /** leak 的来源:number 数字对上了未解锁的真值;canary 未解锁事实的金丝雀词。 */
  via?: "number" | "canary";
  /** 台词里的原文片段。 */
  raw: string;
  /** 规整后的值或区间(数字类)。 */
  value?: string;
  /** leak:对上的真值出处,如 "P1 428"、"truth.loss_total 498000"。 */
  sources?: string[];
}

export interface LineAudit {
  turn: number;
  ref: string;
  roleId: string;
  text: string;
  /** 对抗集用:哪一组、准备步骤还是探测轮。 */
  section?: string;
  /** 守卫至少拦过一次(重试后放行或兜底)。 */
  intercepted: boolean;
  /** 最终出给用户的是兜底台词。 */
  fallback: boolean;
  /** 演员调用出错过(超时、限流……)。 */
  actorError: boolean;
  issues: AuditIssue[];
  /** 复述了用户自己说过、又恰好等于未解锁真值的数(可能是在确认用户的猜测)。只作参考,不算泄露。 */
  echoes: string[];
}

interface TruthPoint {
  v: number;
  percent: boolean;
  unit: string;
  source: string;
}

interface TruthIndex {
  publicTexts: string[];
  /** 只出现在真值表、事实原文、验证结果、资料标题里,不出现在公共背景里的值。 */
  truthOnly: TruthPoint[];
  canaries: { fact: string; word: string }[];
}

const cache = new WeakMap<LoadedScenario, TruthIndex>();

/** 作者写的文字按字面取值;两端都说出来的约数两端都算。 */
function points(text: string, source: string): TruthPoint[] {
  const out: TruthPoint[] = [];
  for (const q of extractQuantities(text, { literal: true })) {
    if (q.kind === "approx" && q.lo < 10) continue; // "几秒""那几个":没有具体值
    for (const v of q.lo === q.hi ? [q.lo] : [q.lo, q.hi]) out.push({ v, percent: q.percent, unit: q.unit, source });
  }
  return out;
}

/** 真值表是结构化数据:数字直接取(0.18 这类占比按百分数),字符串按文字取;权重、id 不是真值。 */
function walkTruth(node: unknown, path: string, out: TruthPoint[]) {
  if (typeof node === "number") {
    const pct = !Number.isInteger(node) && node > 0 && node < 1;
    out.push({ v: pct ? Math.round(node * 1000) / 10 : node, percent: pct, unit: "", source: path });
  } else if (typeof node === "string") out.push(...points(node, path));
  else if (Array.isArray(node)) node.forEach((x, i) => walkTruth(x, `${path}[${i}]`, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) if (k !== "weight" && k !== "id") walkTruth(v, `${path}.${k}`, out);
  }
}

export function truthIndex(scn: LoadedScenario): TruthIndex {
  const hit = cache.get(scn);
  if (hit) return hit;
  const d = scn.data;
  const b = d.briefing;
  const publicTexts = [
    ...d.world_public,
    b.you_are,
    b.company,
    b.opening.text,
    b.goal,
    ...b.rules_shown,
    ...d.roles.map((r) => `${r.name},${r.title}`),
  ].map(foldWidth);
  const pub = new Set(publicTexts.flatMap((t) => points(t, "public")).map((p) => p.v));

  const all: TruthPoint[] = [];
  walkTruth(d.truth, "truth", all);
  const canaries: TruthIndex["canaries"] = [];
  for (const f of d.facts) {
    all.push(...points(f.statement, f.id));
    for (const u of f.unlock) if ("say" in u && u.say) all.push(...points(u.say, `${f.id}(印象)`));
    for (const w of f.canaries ?? []) {
      canaries.push({ fact: f.id, word: w });
      all.push(...points(w, `${f.id}(金丝雀)`));
    }
  }
  for (const x of d.experiments) all.push(...points(x.result, x.id));
  for (const a of d.artifacts) all.push(...points(a.title, a.id));

  const idx: TruthIndex = { publicTexts, truthOnly: all.filter((p) => !pub.has(p.v)), canaries };
  cache.set(scn, idx);
  return idx;
}

// ------------------------------------------------------------------
// 比较规则(docs/quality-gates.md「近似怎么算」)
// ------------------------------------------------------------------

/** 精确数之间:相对误差 ≤ 0.5% 算同一个数(四百三 ≈ 428、十四万八千五 = 14.85 万)。 */
const near = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.max(Math.abs(b), 1);
/** 整数约数(30、400、1500、50 万)对 ±10% 以内的值。 */
const roundNear = (a: number, b: number) => isRound(a) && b >= 10 && Math.abs(a - b) <= 0.1 * b;
/** 同一类量词算一个:"几十号人"和"60 人"、"428 行"和"428 条"说的是同一种东西。 */
const UNIT_CLASS: Record<string, string> = { 人: "个", 名: "个", 位: "个", 号: "个", 单: "票", 行: "条", 项: "条", 笔: "条", 块: "元" };
const unitOf = (u: string) => UNIT_CLASS[u] ?? u;
const unitCompat = (a: string, b: string) => !a || !b || unitOf(a) === unitOf(b);

/**
 * 已知量 k 能不能解释台词里的量 q。fromUser:k 出自用户自己的话(复述用户的说法时量词可以省)。
 */
function explains(k: Quantity, q: Quantity, fromUser = false): boolean {
  if (q.percent !== k.percent) return false; // "跟单 8"不能放行"8%"
  if (q.kind === "exact") {
    if (k.kind === "exact") return near(q.lo, k.lo) || roundNear(q.lo, k.lo);
    if (k.kind === "range") return near(q.lo, k.lo) || near(q.lo, k.hi);
    return false; // 用户说"几十万",角色说"五十万":是把模糊的说具体了
  }
  // "几百""上千""几十"这种跨一个数量级的说法太宽,公共背景里随便一个数(日均约 300 票)都落在里面,
  // 所以要求量词也对得上:"几百票"可以,"几百条""几百"不行。
  // 复述用户自己的说法时放宽:用户问"几十万块有没有",角色反问"几十万?"也是复述。
  const wide = q.hi > 2 * Math.max(q.lo, 1);
  const unitOk = !wide || (fromUser ? unitCompat(q.unit, k.unit) : unitOf(q.unit) === unitOf(k.unit) && (q.unit !== "" || k.kind !== "exact"));
  if (k.kind === "exact") return k.lo >= q.lo && k.lo <= q.hi && unitOk; // "四百多"复述已知的 428
  return q.lo <= k.lo && k.hi <= q.hi && unitOk; // 和已知的一样模糊或更模糊
}

/** 台词里的量 q 是否等于或约等于真值 t。精确数相等时不看是不是百分数("十八"也可能是在说 18%),只用于定性是泄露还是编造。 */
function approximates(q: Quantity, t: TruthPoint): boolean {
  const small = t.v < 10 && !t.percent;
  if (small && !unitCompat(q.unit, t.unit)) return false; // "三天"不是"3 个月"
  if (q.kind === "exact") return near(q.lo, t.v) || (q.percent === t.percent && roundNear(q.lo, t.v));
  return q.percent === t.percent && t.v >= q.lo && t.v <= q.hi;
}

const MONEY = new Set(["万", "千", "亿", "元", "块"]);

/** 不当作"数字"审的:钟点、序数、1 和 2 配泛用量词、个位数以内的模糊说法("两三天""几个人")。 */
function exempt(q: Quantity, text: string): boolean {
  if (q.unit === "点" && q.hi <= 24) return true;
  if (text[q.index - 1] === "第") return true;
  if (q.percent || MONEY.has(q.unit)) return false;
  if (q.kind === "exact" && q.lo <= 2) return true;
  if (q.kind !== "exact" && q.hi < 10) return true;
  return false;
}

// ------------------------------------------------------------------
// 每轮的允许集合
// ------------------------------------------------------------------

export interface AllowedContext {
  /** 用户之外的允许来源(公共背景、人设、已知事实、导演指令、旁白、账本……)。 */
  texts: string[];
  /** 用户说过的话和判断表单里写的字。 */
  userTexts: string[];
}

export function allowedContext(scn: LoadedScenario, st: SessionState, roleId: string, directive?: TurnResult["directive"]): AllowedContext {
  const idx = truthIndex(scn);
  const role = scn.roles.get(roleId);
  const texts = [...idx.publicTexts];
  if (role) texts.push(role.persona, ...role.goals, role.blind_spot ?? "", ...role.agenda);
  for (const [fid, got] of Object.entries(st.facts)) {
    const f = scn.facts.get(fid);
    if (!f) continue;
    const says = f.unlock.flatMap((u) => ("say" in u && u.say && u.level === "L1" ? [u.say] : []));
    texts.push(...(got.level === "L1" ? says : [f.statement, ...says]));
  }
  if (directive) texts.push(directive.instruction, directive.beat ?? "", directive.fallback ?? "");
  for (const id of Object.keys(st.traps)) {
    const tr = scn.traps.get(id);
    if (tr) texts.push(tr.line ?? "", tr.beat);
  }
  texts.push(...st.transcript.filter((l) => l.speaker === "system").map((l) => l.text));
  texts.push(...Object.keys(st.artifacts).map((id) => scn.artifacts.get(id)?.title ?? ""));
  texts.push(...st.ledger.map((e) => e.valueText));
  const userTexts = [...st.transcript.filter((l) => l.speaker === "user").map((l) => l.text), ...Object.values(st.judgment ?? {})];
  return { texts: texts.filter(Boolean).map(foldWidth), userTexts: userTexts.map(foldWidth) };
}

/** 审一条台词。ctx 由 allowedContext 算出(测试里可以直接给)。 */
export function auditText(scn: LoadedScenario, st: SessionState, text: string, ctx: AllowedContext): { issues: AuditIssue[]; echoes: string[] } {
  const idx = truthIndex(scn);
  const t = foldWidth(text);
  // 允许来源按字面("约 300 票"就是 300)和按口语(就是 [270, 330])各取一遍,哪个能解释都算
  const both = (x: string) => [...extractQuantities(x, { literal: true }), ...extractQuantities(x)];
  const known = ctx.texts.flatMap(both);
  const said = ctx.userTexts.flatMap(both);
  const issues: AuditIssue[] = [];
  const echoes: string[] = [];

  for (const q of extractQuantities(t)) {
    if (exempt(q, t)) continue;
    if (known.some((k) => explains(k, q))) continue;
    const truth = idx.truthOnly.filter((p) => approximates(q, p));
    if (said.some((k) => explains(k, q, true))) {
      // 用户自己说过的数照样可以说;恰好又是未解锁的真值时记一笔(可能是在确认用户的猜测)
      if (truth.length) echoes.push(`${q.raw}(${showQuantity(q)})`);
      continue;
    }
    const value = showQuantity(q);
    if (truth.length) {
      // 出处先列事实、验证、资料(P1 428),真值表路径(truth.error_log_total 428)放后面;最多列 4 条
      const sources = [...new Set(truth.map((p) => `${p.source} ${p.percent ? `${p.v}%` : p.v}`))]
        .sort((a, b) => Number(a.startsWith("truth.")) - Number(b.startsWith("truth.")))
        .slice(0, 4);
      issues.push({ kind: "leak", via: "number", raw: q.raw, value, sources });
    } else issues.push({ kind: "unlisted", raw: q.raw, value });
  }

  // 金丝雀词:事实还没拿到具体情况(L2 及以上)时它的特征词不该出现,除非用户说过或在允许来源里见过
  const corpus = [...ctx.texts, ...ctx.userTexts].join("\n");
  for (const { fact, word } of idx.canaries) {
    const lv = st.facts[fact]?.level;
    if (lv && lv !== "L1") continue;
    if (t.includes(word) && !corpus.includes(word)) issues.push({ kind: "leak", via: "canary", raw: word, sources: [fact] });
  }
  return { issues, echoes };
}

/**
 * 引擎每次返回后调用:有角色台词就审一条。必须在当时调用——事后从最终状态推不回"第 N 轮时用户知道什么"
 * (事实升级会覆盖解锁轮次)。
 */
export function auditDelivered(scn: LoadedScenario, st: SessionState, res: TurnResult, section?: string): LineAudit | undefined {
  if (!res.reply) return undefined;
  const ctx = allowedContext(scn, st, res.reply.roleId, res.directive);
  const { issues, echoes } = auditText(scn, st, res.reply.text, ctx);
  const flags = res.guardFlags ?? [];
  return {
    turn: st.turn,
    ref: res.reply.ref,
    roleId: res.reply.roleId,
    text: res.reply.text,
    ...(section && { section }),
    intercepted: flags.some((f) => f !== "fallback" && !f.startsWith("actor_error:")),
    fallback: flags.includes("fallback"),
    actorError: flags.some((f) => f.startsWith("actor_error:")),
    issues,
    echoes,
  };
}

export interface AuditSummary {
  /** 出给用户的角色台词条数(= 演员轮次)。 */
  lines: number;
  leaks: number;
  unlisted: number;
  echoes: number;
  intercepted: number;
  fallback: number;
  actorErrors: number;
  /** 有问题的台词(报告里逐条列出)。 */
  flagged: LineAudit[];
}

export function summarizeAudits(audits: LineAudit[]): AuditSummary {
  const count = (k: AuditIssue["kind"]) => audits.reduce((s, a) => s + a.issues.filter((i) => i.kind === k).length, 0);
  return {
    lines: audits.length,
    leaks: count("leak"),
    unlisted: count("unlisted"),
    echoes: audits.reduce((s, a) => s + a.echoes.length, 0),
    intercepted: audits.filter((a) => a.intercepted).length,
    fallback: audits.filter((a) => a.fallback).length,
    actorErrors: audits.filter((a) => a.actorError).length,
    flagged: audits.filter((a) => a.issues.length),
  };
}

/** 报告里一条有问题的台词怎么写。 */
export function describeIssue(i: AuditIssue): string {
  if (i.kind === "unlisted") return `白名单外数字「${i.raw}」${i.value ? `= ${i.value}` : ""}`;
  if (i.via === "canary") return `金丝雀词「${i.raw}」(${i.sources?.join("、")} 还没解锁)`;
  return `泄露候选「${i.raw}」= ${i.value} ≈ ${i.sources?.join("、")}`;
}
