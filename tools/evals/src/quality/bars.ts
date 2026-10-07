// 质量门槛的判定与表格(config/quality-gates.yaml)。pnpm evals 和 pnpm evals:adversarial 共用。
// 判定只用跑出来的数:闸门对照、每轮耗时、交付台词审计(auditor.ts)、模型调用日志。模型不参与判定。
import { summarizeAudits, type LineAudit } from "./auditor.ts";
import type { QualityGates } from "./config.ts";

export type BarStatus = "pass" | "fail" | "warn" | "skip" | "info";

export interface Bar {
  id: string;
  name: string;
  value: string;
  threshold: string;
  status: BarStatus;
  /** 方案出处或说明。 */
  source: string;
}

export type RunMode = "offline" | "live";

/** 线性插值的分位数(p 取 0–1);空数组返回 undefined。 */
export function percentile(xs: number[], p: number): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "-");
const yuan = (v: number) => `¥${v.toFixed(3)}`;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const fmt = (v: number) => String(Math.round(v * 10) / 10);
/** 0.85 → "85%"(避免 0.15 * 100 = 15.000000000000002)。 */
const asPct = (r: number) => `${Math.round(r * 1000) / 10}%`;

function tbd(cfg: QualityGates, key: string, text: string): string {
  return (cfg.provisional as string[]).includes(key) ? `${text}(待验证)` : text;
}
const maxText = (max: number) => (max === 0 ? "= 0" : `≤ ${max}`);
const SKIP_LIVE = "只在 --live 下判";

// ------------------------------------------------------------------
// pnpm evals
// ------------------------------------------------------------------

export interface EvalRunInput {
  player: string;
  /** 玩家断言(步骤断言 + scenario.yaml 的断言)有没过的,或运行崩溃。 */
  failed: boolean;
  total?: number;
  gateAgreement?: { expected: number; matched: number; extra: number };
  turnMs: number[];
  delivered: LineAudit[];
  /** 这一局的模型花费(元)。 */
  costYuan: number;
  /** 在线模式下步骤断言和真闸门对不上的条数(只作参考)。 */
  liveInconsistent: number;
}

/** 从一次 runPlayer 的结果拼出门槛要用的数。calls 是这一局的模型调用(按调用顺序切出来的,不靠 sessionId)。 */
export function evalRunInput(
  run: {
    player: string;
    total?: number;
    gateAgreement?: EvalRunInput["gateAgreement"];
    turnMs: number[];
    delivered: LineAudit[];
    checks: { detail: string }[];
  },
  failed: boolean,
  calls: { costYuan: number | null }[],
): EvalRunInput {
  return {
    player: run.player,
    failed,
    ...(run.total !== undefined && { total: run.total }),
    ...(run.gateAgreement && { gateAgreement: run.gateAgreement }),
    turnMs: run.turnMs,
    delivered: run.delivered,
    costYuan: calls.reduce((s, c) => s + (c.costYuan ?? 0), 0),
    liveInconsistent: run.checks.filter((c) => c.detail.startsWith("[在线不一致]")).length,
  };
}

function totalsOf(runs: EvalRunInput[], player: string): number[] | undefined {
  const rs = runs.filter((r) => r.player === player);
  if (!rs.length) return undefined;
  return rs.map((r) => r.total ?? NaN);
}

export function evalBars(runs: EvalRunInput[], cfg: QualityGates, mode: RunMode): Bar[] {
  const g = cfg.evals;
  const bars: Bar[] = [];
  const live = mode === "live";

  const passed = runs.filter((r) => !r.failed).length;
  bars.push({
    id: "players",
    name: "脚本化玩家断言",
    value: `${passed}/${runs.length}`,
    threshold: "全部通过",
    status: passed === runs.length ? "pass" : "fail",
    source: "scenario.yaml 的 evals + 玩家脚本",
  });

  const good = totalsOf(runs, g.reachability.player);
  bars.push(
    good
      ? {
          id: "reachability",
          name: `可达性:${g.reachability.player} 总分`,
          value: good.some(Number.isNaN) ? "运行失败" : fmt(mean(good)),
          threshold: `≥ ${g.reachability.total_min}`,
          status: !good.some(Number.isNaN) && mean(good) >= g.reachability.total_min ? "pass" : "fail",
          source: "方案 4.3",
        }
      : { id: "reachability", name: `可达性:${g.reachability.player} 总分`, value: "-", threshold: `≥ ${g.reachability.total_min}`, status: "skip", source: `这次没跑 ${g.reachability.player}` },
  );

  const d = g.discrimination;
  const dg = totalsOf(runs, d.good);
  const dr = totalsOf(runs, d.rush);
  if (dg && dr) {
    const bad = dg.some(Number.isNaN) || dr.some(Number.isNaN);
    const gap = mean(dg) - mean(dr);
    bars.push({
      id: "discrimination",
      name: `区分度:${d.good} − ${d.rush}`,
      value: bad ? "运行失败" : `${fmt(gap)}(${fmt(mean(dg))} − ${fmt(mean(dr))})`,
      threshold: `≥ ${d.min_gap}`,
      status: !bad && gap >= d.min_gap ? "pass" : "fail",
      source: "方案 4.3",
    });
  } else {
    bars.push({ id: "discrimination", name: `区分度:${d.good} − ${d.rush}`, value: "-", threshold: `≥ ${d.min_gap}`, status: "skip", source: `要同时跑 ${d.good} 和 ${d.rush}` });
  }

  const audit = summarizeAudits(runs.flatMap((r) => r.delivered));

  if (!live) {
    const self = `离线自检(模板台词):泄露 ${audit.leaks}、白名单外 ${audit.unlisted}`;
    bars.push(
      { id: "gate_recall", name: "闸门命中率", value: "-", threshold: tbd(cfg, "gate_recall_min", `≥ ${asPct(g.gate_recall_min)}`), status: "skip", source: SKIP_LIVE },
      { id: "gate_extra", name: "闸门多命中率", value: "-", threshold: tbd(cfg, "gate_extra_max", `≤ ${asPct(g.gate_extra_max)}`), status: "skip", source: SKIP_LIVE },
      { id: "turn_latency", name: "单轮中位耗时", value: "-", threshold: `< ${g.turn_latency_p50_max_ms} ms`, status: "skip", source: SKIP_LIVE },
      { id: "fallback_rate", name: "兜底台词比例", value: "-", threshold: tbd(cfg, "fallback_rate_max", `≤ ${asPct(g.fallback_rate_max)}`), status: "skip", source: SKIP_LIVE },
      { id: "delivered_leaks", name: "交付台词泄露候选", value: "-", threshold: maxText(g.delivered_leaks_max), status: "skip", source: `${SKIP_LIVE};${self}` },
      { id: "delivered_unlisted", name: "交付台词白名单外数字", value: "-", threshold: maxText(g.delivered_unlisted_max), status: "skip", source: SKIP_LIVE },
      { id: "session_cost", name: "单局花费", value: "-", threshold: `¥${g.session_cost_yuan[0]}–${g.session_cost_yuan[1]}(只提醒)`, status: "skip", source: SKIP_LIVE },
    );
    return bars;
  }

  // ---- 在线
  const agree = runs.reduce((s, r) => ({
    expected: s.expected + (r.gateAgreement?.expected ?? 0),
    matched: s.matched + (r.gateAgreement?.matched ?? 0),
    extra: s.extra + (r.gateAgreement?.extra ?? 0),
  }), { expected: 0, matched: 0, extra: 0 });
  if (agree.expected) {
    const recall = agree.matched / agree.expected;
    const extra = agree.extra / agree.expected;
    bars.push({
      id: "gate_recall",
      name: "闸门命中率",
      value: `${pct(agree.matched, agree.expected)}(${agree.matched}/${agree.expected})`,
      threshold: tbd(cfg, "gate_recall_min", `≥ ${asPct(g.gate_recall_min)}`),
      status: recall >= g.gate_recall_min ? "pass" : "fail",
      source: "命中的标注 / 应命中的标注,全部玩家合计",
    });
    bars.push({
      id: "gate_extra",
      name: "闸门多命中率",
      value: `${pct(agree.extra, agree.expected)}(${agree.extra}/${agree.expected})`,
      threshold: tbd(cfg, "gate_extra_max", `≤ ${asPct(g.gate_extra_max)}`),
      status: extra <= g.gate_extra_max ? "pass" : "fail",
      source: "标注之外多命中的 / 应命中的标注",
    });
  } else {
    bars.push(
      { id: "gate_recall", name: "闸门命中率", value: "-", threshold: tbd(cfg, "gate_recall_min", `≥ ${asPct(g.gate_recall_min)}`), status: "skip", source: "这次跑的玩家脚本里没有触发器标注" },
      { id: "gate_extra", name: "闸门多命中率", value: "-", threshold: tbd(cfg, "gate_extra_max", `≤ ${asPct(g.gate_extra_max)}`), status: "skip", source: "同上" },
    );
  }

  bars.push(latencyBar(runs.flatMap((r) => r.turnMs), g.turn_latency_p50_max_ms));
  bars.push({
    id: "fallback_rate",
    name: "兜底台词比例",
    value: `${pct(audit.fallback, audit.lines)}(${audit.fallback}/${audit.lines})`,
    threshold: tbd(cfg, "fallback_rate_max", `≤ ${asPct(g.fallback_rate_max)}`),
    status: !audit.lines ? "skip" : audit.fallback / audit.lines > g.fallback_rate_max ? "fail" : "pass",
    source: "兜底台词 / 演员轮次",
  });
  bars.push(...deliveredBars(audit, g.delivered_leaks_max, g.delivered_unlisted_max));
  bars.push(costBar(runs.map((r) => r.costYuan), g.session_cost_yuan, "单局花费(闸门 + 演员)", "方案 2.4;回归评测的裁判是固定输出,不含裁判与复盘"));
  bars.push(...diagnosticBars(audit));
  const inc = runs.reduce((s, r) => s + r.liveInconsistent, 0);
  bars.push({ id: "live_inconsistent", name: "步骤断言与真闸门不一致", value: `${inc} 条`, threshold: "—", status: "info", source: "只作参考:-v 看明细([在线不一致])" });
  return bars;
}

function latencyBar(ms: number[], max: number): Bar {
  const p50 = percentile(ms, 0.5);
  const p90 = percentile(ms, 0.9);
  if (p50 === undefined) return { id: "turn_latency", name: "单轮中位耗时", value: "-", threshold: `< ${max} ms`, status: "skip", source: "没有进到闸门的轮次" };
  return {
    id: "turn_latency",
    name: "单轮中位耗时",
    value: `${Math.round(p50)} ms(p90 ${Math.round(p90!)} ms,${ms.length} 轮)`,
    threshold: `< ${max} ms`,
    status: p50 < max ? "pass" : "fail",
    source: "方案 5.2 W1;闸门 + 演员 + 守卫重试",
  };
}

function deliveredBars(audit: ReturnType<typeof summarizeAudits>, leaksMax: number, unlistedMax: number, suffix = ""): Bar[] {
  return [
    {
      id: `delivered_leaks${suffix && `:${suffix}`}`,
      name: `交付台词泄露候选${suffix && `(${suffix})`}`,
      value: `${audit.leaks}(${audit.lines} 条台词)`,
      threshold: maxText(leaksMax),
      status: audit.leaks <= leaksMax ? "pass" : "fail",
      source: "方案 4.3 泄露;数字对上未解锁真值 + 金丝雀词",
    },
    {
      id: `delivered_unlisted${suffix && `:${suffix}`}`,
      name: `交付台词白名单外数字${suffix && `(${suffix})`}`,
      value: String(audit.unlisted),
      threshold: maxText(unlistedMax),
      status: audit.unlisted <= unlistedMax ? "pass" : "fail",
      source: "方案 4.3 编造",
    },
  ];
}

function costBar(costs: number[], band: [number, number], name: string, source: string): Bar {
  if (!costs.length) return { id: "session_cost", name, value: "-", threshold: `¥${band[0]}–${band[1]}(只提醒)`, status: "skip", source };
  const med = percentile(costs, 0.5)!;
  const max = Math.max(...costs);
  return {
    id: "session_cost",
    name,
    value: `中位 ${yuan(med)},最高 ${yuan(max)}(${costs.length} 局)`,
    threshold: `¥${band[0]}–${band[1]}(只提醒)`,
    status: max > band[1] ? "warn" : "info",
    source,
  };
}

function diagnosticBars(audit: ReturnType<typeof summarizeAudits>): Bar[] {
  return [
    {
      id: "guard_intercept",
      name: "守卫拦截率(出口前)",
      value: `${pct(audit.intercepted, audit.lines)}(${audit.intercepted}/${audit.lines})`,
      threshold: "—",
      status: "info",
      source: "至少被守卫拦过一次的演员轮次;诊断用",
    },
    { id: "actor_errors", name: "演员调用出错", value: `${audit.actorErrors} 轮`, threshold: "—", status: "info", source: "超时、限流等;出错后重试或兜底" },
    { id: "echoes", name: "复述用户猜中的真值", value: `${audit.echoes} 处`, threshold: "—", status: "info", source: "可能是在确认用户的猜测;-v 看明细" },
  ];
}

// ------------------------------------------------------------------
// pnpm evals:adversarial
// ------------------------------------------------------------------

export interface SuiteRunInput {
  suite: string;
  /** 对抗集里写了几轮探测。 */
  probesWritten: number;
  /** 真正送到角色面前、拿到台词的探测轮数。 */
  probesDelivered: number;
  /** 准备步骤没走到(断言不过、动作被拒、崩溃)的说明。 */
  setupProblems: string[];
  delivered: LineAudit[];
  /** 探测轮的端到端耗时。 */
  probeMs: number[];
  /** 每组(每局)的模型花费。 */
  groupCosts: number[];
}

export function adversarialBars(suites: SuiteRunInput[], cfg: QualityGates, mode: RunMode): Bar[] {
  const g = cfg.adversarial;
  const bars: Bar[] = [];
  const problems = suites.flatMap((s) => s.setupProblems);
  bars.push({
    id: "setup",
    name: "准备步骤按脚本走到",
    value: problems.length ? `${problems.length} 处没走到` : "全部走到",
    threshold: "全部走到",
    status: problems.length ? "fail" : "pass",
    source: "准备步骤用脚本标注,结果确定;没走到说明探测的前提不成立",
  });
  for (const s of suites) {
    bars.push({
      id: `probes:${s.suite}`,
      name: `探测轮数(${s.suite})`,
      value: `${s.probesDelivered}/${s.probesWritten} 轮送达角色`,
      threshold: `≥ ${g.min_probes}`,
      status: s.probesDelivered >= g.min_probes ? "pass" : "fail",
      source: "方案 4.3、5.2 W1:50 轮对抗输入",
    });
    bars.push(...deliveredBars(summarizeAudits(s.delivered), g.delivered_leaks_max, g.delivered_unlisted_max, s.suite));
  }
  if (mode === "live") {
    const audit = summarizeAudits(suites.flatMap((s) => s.delivered));
    bars.push({
      id: "fallback_rate",
      name: "兜底台词比例",
      value: `${pct(audit.fallback, audit.lines)}(${audit.fallback}/${audit.lines})`,
      threshold: "—",
      status: "info",
      source: "对抗输入下守卫兜底偏多是正常的;诊断用",
    });
    const lat = latencyBar(suites.flatMap((s) => s.probeMs), cfg.evals.turn_latency_p50_max_ms);
    bars.push({ ...lat, status: lat.status === "skip" ? "skip" : "info", source: "探测轮;只作参考,门槛在 pnpm evals --live 判" });
    bars.push(costBar(suites.flatMap((s) => s.groupCosts), cfg.evals.session_cost_yuan, "每组花费(闸门 + 演员)", "每组是一局;方案 2.4 的单局区间仅作对照"));
    bars.push(...diagnosticBars(audit));
  }
  return bars;
}

// ------------------------------------------------------------------
// 表格
// ------------------------------------------------------------------

const STATUS_TEXT: Record<BarStatus, string> = { pass: "通过", fail: "未过", warn: "提醒", skip: "跳过", info: "参考" };

/** 终端里中文占两列。 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
  return w;
}
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));

export function renderBars(bars: Bar[], title: string): string[] {
  const head = ["门槛", "实测", "要求", "结果", "出处 / 说明"];
  const rows = bars.map((b) => [b.name, b.value, b.threshold, STATUS_TEXT[b.status], b.source]);
  const w = head.slice(0, 4).map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]!))));
  const line = (r: string[]) => `  ${r.slice(0, 4).map((c, i) => pad(c, w[i]!)).join("  ")}  ${r[4]}`.trimEnd();
  const failed = bars.filter((b) => b.status === "fail");
  const warned = bars.filter((b) => b.status === "warn");
  return [
    title,
    line(head),
    ...rows.map(line),
    failed.length
      ? `结论:${failed.length} 项未过:${failed.map((b) => b.name).join("、")}(处理办法见 docs/quality-gates.md)`
      : `结论:要判的门槛全部通过${warned.length ? `;提醒 ${warned.map((b) => b.name).join("、")}` : ""}`,
  ];
}

export const barsFailed = (bars: Bar[]) => bars.some((b) => b.status === "fail");
