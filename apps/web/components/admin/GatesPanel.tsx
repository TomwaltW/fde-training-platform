"use client";
// 管理页:方案 6.3 的继续/转向/放弃指标(第三轮)。管理页底部的一个可折叠区块,展开后才请求数据(不展开不发任何请求)。
// 三关各一张表(指标、数值、分子/分母、门槛、状态),下面是每轮耗时和新用户到第一句话的时间。门槛在 config/gates.yaml。
import { useRef, useState, type FormEvent } from "react";
import type { GateMetric, GateStatus, GatesResponse } from "@fde/contracts";
import { api, failureMessage } from "@/lib/client/api";
import { cx, formatDateTime } from "@/lib/client/format";
import { alert, btn, card, field } from "@/lib/client/ui";

/** 状态既写字又上色(色弱也能分清)。 */
const STATUS: Record<GateStatus, { text: string; className: string }> = {
  pass: { text: "过", className: "bg-ok-soft text-ok ring-ok/40" },
  fix: { text: "修", className: "bg-warn-soft text-ink ring-warn/40" },
  fail: { text: "不过", className: "bg-danger-soft text-danger ring-danger/40" },
  insufficient: { text: "样本不足", className: "bg-surface-2 text-ink-3 ring-line" },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 日期框的值(北京时间的某一天,如 "2026-10-01")→ 那天 0 点的 ISO;plusDays=1 是第二天 0 点。 */
function dayStartIso(day: string, plusDays = 0): string {
  return new Date(Date.parse(`${day}T00:00:00+08:00`) + plusDays * DAY_MS).toISOString();
}

/** 结束日期含当天:until 取它第二天的 0 点(接口的 until 不含)。 */
function rangeOf(since: string, until: string): { since?: string; until?: string } {
  const r: { since?: string; until?: string } = {};
  if (since) r.since = dayStartIso(since);
  if (until) r.until = dayStartIso(until, 1);
  return r;
}

function rangeText(range: GatesResponse["range"]): string {
  if (!range.since && !range.until) return "全部时间";
  return `${range.since ? formatDateTime(range.since) : "最早"} 至 ${range.until ? `${formatDateTime(range.until)}(不含)` : "现在"}`;
}

/** 分子/分母一栏:人数指标只有人数;中位时长的分母是计入的局数。 */
function fraction(m: GateMetric): string {
  if (m.id === "waitlist_7d") return `${m.numerator} 人`;
  if (m.id === "median_minutes") return `${m.denominator} 局`;
  return `${m.numerator} / ${m.denominator}`;
}

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms / 100) / 10} 秒`;
}

export function GatesPanel() {
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [data, setData] = useState<GatesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);
  const seq = useRef(0);

  async function load(range: { since?: string; until?: string }) {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.adminGates(range);
      if (mine === seq.current) setData(r);
    } catch (e) {
      if (mine === seq.current) setError(failureMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    // 第一次展开才加载;收起再展开不重复请求
    if (next && !requested.current) {
      requested.current = true;
      void load(rangeOf(since, until));
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (since && until && since > until) {
      setError("开始日期不能晚于结束日期");
      return;
    }
    void load(rangeOf(since, until));
  }

  function clear() {
    setSince("");
    setUntil("");
    void load({});
  }

  return (
    <section className={cx(card, "p-5")} aria-labelledby="gates-title" data-testid="gates-panel">
      <h2 id="gates-title" className="font-semibold">
        <button
          type="button"
          className="-my-2 flex min-h-11 w-full items-center justify-between gap-3 text-left"
          aria-expanded={open}
          aria-controls="gates-body"
          onClick={toggle}
        >
          <span>继续 / 转向 / 放弃(方案 6.3)</span>
          <span aria-hidden className="shrink-0 text-sm font-normal text-ink-3">
            {open ? "收起 ▴" : "展开 ▾"}
          </span>
        </button>
      </h2>
      <p className="text-sm text-ink-3">三关指标:兴趣、体验、付费。展开后才加载。</p>

      {open && (
        <div id="gates-body" className="mt-4 flex flex-col gap-6">
          <form onSubmit={submit} className="flex flex-col gap-3" aria-label="时间范围">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[repeat(2,minmax(0,14rem))_auto] sm:items-end">
              <label className={field.label}>
                开始日期
                <input className={field.input} type="date" value={since} max={until || undefined} onChange={(e) => setSince(e.target.value)} />
              </label>
              <label className={field.label}>
                结束日期(含当天)
                <input className={field.input} type="date" value={until} min={since || undefined} onChange={(e) => setUntil(e.target.value)} />
              </label>
              <div className="flex gap-2">
                <button type="submit" className={btn.primary} disabled={loading}>
                  {loading ? "加载中…" : "查询"}
                </button>
                <button type="button" className={btn.ghost} disabled={loading || (!since && !until)} onClick={clear}>
                  清空日期
                </button>
              </div>
            </div>
            <p className={cx(field.hint, "mt-0")}>日期按北京时间,不填表示不限。第一关、第三关按候补登记时间筛选,第二关按开局时间。</p>
          </form>

          {error && <p className={alert.error}>{error}</p>}

          {!data ? (
            loading && <p className="text-ink-3">加载中…</p>
          ) : (
            <>
              <p className="text-sm text-ink-2" data-testid="gates-range">
                范围:{rangeText(data.range)}
              </p>
              <GateTable testId="gates-gate1" title="第一关:兴趣" when="第一条内容发布后 7 天" metrics={data.gate1} />
              <GateTable testId="gates-gate2" title="第二关:体验" when="W5 末" metrics={data.gate2} />
              <GateTable testId="gates-gate3" title="第三关:付费" when="W8" metrics={data.gate3} />

              <div>
                <h3 className="font-semibold">其他验收数字</h3>
                <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="gates-extra">
                  <Extra label="每轮服务端耗时 P50" value={seconds(data.extra.turnLatencyMsP50)} hint="W1 验收:中位数 < 4 秒" />
                  <Extra label="每轮服务端耗时 P90" value={seconds(data.extra.turnLatencyMsP90)} hint="范围内每一轮说话" />
                  <Extra
                    label="新用户打开落地页到说出第一句话"
                    value={data.extra.firstTurnSecondsP50 === null ? "—" : `${data.extra.firstTurnSecondsP50} 秒`}
                    hint={`中位数,样本 ${data.extra.firstTurnSample} 人 · W4 验收:≤ 60 秒`}
                  />
                </dl>
              </div>

              <p className="text-[13px] leading-6 text-ink-3">
                门槛在 config/gates.yaml(数值照抄方案 6.3,W0 结束时校准一次,之后不再放宽),改完刷新就生效。分母小于 min_sample
                时显示"样本不足",不下结论。第一关的"试玩者主动问什么时候能正式玩"、第三关的企业访谈不在系统里,需要另外记录。
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function GateTable({ testId, title, when, metrics }: { testId: string; title: string; when: string; metrics: GateMetric[] }) {
  return (
    <div data-testid={testId}>
      <h3 className="font-semibold">
        {title}
        <span className="ml-2 text-sm font-normal text-ink-3">{when}</span>
      </h3>
      {/* 手机上每一行排成一张小卡片(指标和状态在第一行),不用横着滑才看得到状态;电脑上是普通表格 */}
      <div className="mt-2 sm:overflow-x-auto">
        <table className="w-full text-left text-sm max-sm:block sm:min-w-[720px]">
          <thead className="border-b border-line text-ink-3 max-sm:sr-only">
            <tr>
              <th className="py-2 pr-3 font-medium">指标</th>
              <th className="py-2 pr-3 text-right font-medium">数值</th>
              <th className="py-2 pr-3 text-right font-medium">分子/分母</th>
              <th className="py-2 pr-3 font-medium">门槛</th>
              <th className="py-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line max-sm:block max-sm:border-t max-sm:border-line">
            {metrics.map((m) => (
              <tr
                key={m.id}
                data-testid={`gate-${m.id}`}
                data-status={m.status}
                className="max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:py-3"
              >
                <td className="py-2 pr-3 align-top max-sm:col-start-1 max-sm:row-start-1 max-sm:p-0">
                  <p className="font-medium text-ink">{m.label}</p>
                  <p className="mt-0.5 text-[13px] leading-5 text-ink-3">{m.note}</p>
                </td>
                <td className="py-2 pr-3 text-right align-top font-semibold whitespace-nowrap tabular-nums max-sm:col-start-1 max-sm:row-start-2 max-sm:p-0 max-sm:text-left">
                  {m.display}
                </td>
                <td className="py-2 pr-3 text-right align-top whitespace-nowrap tabular-nums max-sm:col-start-2 max-sm:row-start-2 max-sm:p-0 max-sm:text-ink-2">
                  {fraction(m)}
                </td>
                <td className="py-2 pr-3 align-top text-ink-2 max-sm:col-span-2 max-sm:row-start-3 max-sm:p-0 max-sm:text-[13px]">{m.thresholds}</td>
                <td className="py-2 align-top max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-self-end max-sm:p-0">
                  <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium whitespace-nowrap ring-1", STATUS[m.status].className)}>
                    {STATUS[m.status].text}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Extra({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg bg-surface-2 p-3">
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
      <dd className="mt-0.5 text-[13px] text-ink-3">{hint}</dd>
    </div>
  );
}
