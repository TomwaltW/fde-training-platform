"use client";
// 管理页:统计卡片、分数直方图、流失轮次、对局列表、生成邀请码、反馈与申诉。
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { AdminSessionRow, AdminStats, FeedbackRow } from "@fde/contracts";
import { BarList, ColumnChart } from "@/components/charts";
import { api, failureMessage } from "@/lib/client/api";
import { cx, formatDateTime, formatPercent, formatScore, formatYuan, phaseLabel } from "@/lib/client/format";
import { alert, btn, card, field } from "@/lib/client/ui";
import { AdminGate, adminWrap } from "./AdminGate";
import { GatesPanel } from "./GatesPanel";
import { RedeemPanel } from "./RedeemPanel";
import { WaitlistPanel } from "./WaitlistPanel";

const PAGE = 50;

export function AdminClient() {
  return (
    <AdminGate next="/admin">
      <AdminDashboard />
    </AdminGate>
  );
}

function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [rows, setRows] = useState<AdminSessionRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fail = (e: unknown) => alive && setError(failureMessage(e));
    api.adminStats().then((s) => alive && setStats(s), fail);
    api.adminSessions({ limit: PAGE }).then((r) => {
      if (!alive) return;
      setRows(r.sessions);
      setMore(r.sessions.length >= PAGE);
    }, fail);
    api.adminFeedback().then((r) => alive && setFeedback(r.feedback), fail);
    return () => {
      alive = false;
    };
  }, []);

  async function loadMore() {
    const last = rows?.[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const r = await api.adminSessions({ limit: PAGE, before: last.startedAt });
      setRows((prev) => [...(prev ?? []), ...r.sessions]);
      setMore(r.sessions.length >= PAGE);
    } catch (e) {
      setError(failureMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <main className={adminWrap} data-testid="admin">
      <h1 className="text-2xl font-bold">管理</h1>
      {error && <p className={alert.error}>{error}</p>}

      {/* 统计卡片 */}
      <section aria-label="统计">
        {!stats ? (
          <p className="text-ink-3">加载中…</p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="admin-stats">
            <Stat label="用户" value={String(stats.users)} />
            <Stat label="开局 / 出复盘" value={`${stats.sessionsStarted} / ${stats.sessionsFinished}`} />
            <Stat label="完成率" value={formatPercent(stats.completionRate)} />
            <Stat label="用时中位数" value={stats.medianMinutesUsed === null ? "—" : `${stats.medianMinutesUsed} 分钟`} />
            <Stat label="总分中位数" value={stats.medianTotal === null ? "—" : formatScore(stats.medianTotal)} />
            <Stat label="申诉率" value={formatPercent(stats.disputeRate)} />
            <Stat label="模型成本合计" value={formatYuan(stats.costYuanTotal)} />
            <Stat label="每局成本" value={formatYuan(stats.costYuanPerSession)} />
          </dl>
        )}
      </section>

      {stats && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className={cx(card, "p-5")} aria-labelledby="hist-title">
            <h2 id="hist-title" className="font-semibold">
              总分分布
            </h2>
            <p className="text-sm text-ink-3">每 10 分一档。中位数高于 75 说明太松,几乎没人过 60 说明太严。</p>
            <div className="mt-3">
              <ColumnChart
                testId="score-histogram"
                label={`总分分布:${stats.scoreHistogram.map((b) => `${b.bucket} 分 ${b.count} 局`).join(",")}`}
                data={stats.scoreHistogram.map((b) => ({ label: b.bucket, value: b.count }))}
              />
            </div>
          </section>
          <section className={cx(card, "p-5")} aria-labelledby="drop-title">
            <h2 id="drop-title" className="font-semibold">
              流失轮次
            </h2>
            <p className="mb-3 text-sm text-ink-3">没收工的对局停在第几轮。</p>
            {stats.dropOffByTurn.length === 0 ? (
              <p className="text-ink-3">还没有数据。</p>
            ) : (
              <BarList testId="dropoff" data={stats.dropOffByTurn.map((d) => ({ label: `第 ${d.turn} 轮`, value: d.count }))} />
            )}
          </section>
        </div>
      )}

      {/* 对局列表 */}
      <section className={cx(card, "p-5")} aria-labelledby="sessions-title">
        <h2 id="sessions-title" className="font-semibold">
          对局
        </h2>
        {!rows ? (
          <p className="mt-3 text-ink-3">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-ink-3">还没有对局。</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm" data-testid="admin-sessions">
              <thead className="border-b border-line text-ink-3">
                <tr>
                  <th className="py-2 pr-3 font-medium">开始时间</th>
                  <th className="py-2 pr-3 font-medium">用户</th>
                  <th className="py-2 pr-3 font-medium">阶段</th>
                  <th className="py-2 pr-3 text-right font-medium">轮数</th>
                  <th className="py-2 pr-3 text-right font-medium">总分</th>
                  <th className="py-2 pr-3 text-right font-medium">成本</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{formatDateTime(s.startedAt)}</td>
                    <td className="py-2 pr-3">{s.userEmail}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{phaseLabel(s.phase)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.turns}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.total === null ? "—" : formatScore(s.total)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatYuan(s.costYuan, 3)}</td>
                    <td className="py-2 text-right">
                      <Link href={`/admin/sessions/${encodeURIComponent(s.id)}`} className="inline-flex min-h-11 items-center px-2 text-accent hover:underline">
                        详情
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && (
          <button type="button" className={cx(btn.secondary, "mt-3")} disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <InviteForm />
        {/* 反馈与申诉 */}
        <section className={cx(card, "p-5")} aria-labelledby="fb-title">
          <h2 id="fb-title" className="font-semibold">
            反馈与申诉
          </h2>
          {!feedback ? (
            <p className="mt-3 text-ink-3">加载中…</p>
          ) : feedback.length === 0 ? (
            <p className="mt-3 text-ink-3">还没有反馈。</p>
          ) : (
            <ul className="mt-3 divide-y divide-line" data-testid="admin-feedback">
              {feedback.map((f, i) => (
                <li key={`${f.sessionId}-${f.createdAt}-${i}`} className="py-3 text-[15px] leading-7">
                  <p className="text-sm text-ink-3">
                    {formatDateTime(f.createdAt)} · {f.userEmail} ·{" "}
                    <Link href={`/admin/sessions/${encodeURIComponent(f.sessionId)}`} className="text-accent hover:underline">
                      {f.sessionId}
                    </Link>
                  </p>
                  {f.rating !== null && <p>推荐意愿:{f.rating} / 10</p>}
                  {f.text && <p>{f.text}</p>}
                  {f.dispute && (
                    <p className="text-ink-2">
                      申诉 <span className="font-medium text-ink">{f.dispute.dimension}</span>:{f.dispute.reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 第三轮:各自展开后才加载 */}
      <GatesPanel />
      <WaitlistPanel />
      <RedeemPanel />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={cx(card, "p-4")}>
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
    </div>
  );
}

function InviteForm() {
  const [count, setCount] = useState("5");
  const [maxUses, setMaxUses] = useState("1");
  const [note, setNote] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(count);
    const m = Number(maxUses);
    if (!Number.isInteger(n) || n < 1 || n > 100 || !Number.isInteger(m) || m < 1) {
      setError("数量 1–100,可用次数至少 1");
      return;
    }
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await api.createInvites(note.trim() ? { count: n, maxUses: m, note: note.trim() } : { count: n, maxUses: m });
      setCodes(r.codes);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setError("复制失败,请手动选择复制");
    }
  }

  return (
    <section className={cx(card, "p-5")} aria-labelledby="invite-title">
      <h2 id="invite-title" className="font-semibold">
        生成邀请码
      </h2>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <label className={field.label}>
            数量
            <input className={field.input} type="number" inputMode="numeric" min={1} max={100} value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
          <label className={field.label}>
            每个可用次数
            <input className={field.input} type="number" inputMode="numeric" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </label>
        </div>
        <label className={field.label}>
          备注(选填)
          <input className={field.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="比如:小红书第一批" />
        </label>
        <button type="submit" className={btn.primary} disabled={busy}>
          {busy ? "正在生成…" : "生成"}
        </button>
      </form>
      {error && <p className={cx(alert.error, "mt-3")}>{error}</p>}
      {codes && (
        <div className="mt-4" data-testid="invite-codes">
          <ul className="flex flex-col gap-1 rounded-lg bg-surface-2 p-3 font-mono text-[15px]">
            {codes.map((c) => (
              <li key={c} className="select-all">
                {c}
              </li>
            ))}
          </ul>
          <button type="button" className={cx(btn.small, "mt-2")} onClick={() => void copy()}>
            {copied ? "已复制" : "复制全部"}
          </button>
        </div>
      )}
    </section>
  );
}
