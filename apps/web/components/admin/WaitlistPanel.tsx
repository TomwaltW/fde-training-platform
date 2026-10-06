"use client";
// 管理页:候补名单(第三轮 F1)。管理页底部的一个可折叠区块,展开后才请求数据(不展开不发任何请求)。
// 合计与来源、名单(登记时间从早到晚)、邀请最早的 N 位或勾选的人、这次邀请的结果(没发出邮件的可以复制邀请码)、导出 CSV。
import { useEffect, useState, type FormEvent } from "react";
import type { AdminWaitlistResponse, InviteWaitlistBody, InviteWaitlistResponse, WaitlistRow } from "@fde/contracts";
import { Modal } from "@/components/Modal";
import { roleLabel } from "@/components/waitlist/roles";
import { ADMIN_WAITLIST_CSV_URL, api, failureMessage } from "@/lib/client/api";
import { cx, formatDateTime } from "@/lib/client/format";
import { alert, btn, card } from "@/lib/client/ui";

type Filter = "all" | "pending" | "invited";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待邀请" },
  { value: "invited", label: "已邀请" },
];

/** 服务端一次最多邀请 200 人(InviteWaitlistSchema)。 */
const MAX_INVITE = 200;

/** 和 field.input 一样的外观,但不占满一行(放在按钮旁边)。 */
const inlineInput =
  "min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink focus:border-accent focus:outline-2 focus:outline-accent/30";

export function WaitlistPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section className={cx(card, "p-5")} aria-labelledby="waitlist-title" data-testid="waitlist-panel">
      <h2 id="waitlist-title" className="font-semibold">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="waitlist-body"
          onClick={() => setOpen((o) => !o)}
          className="-mx-2 -my-1 flex min-h-11 w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-lg px-2 text-left hover:bg-surface-2"
        >
          <span>候补名单</span>
          <svg viewBox="0 0 20 20" aria-hidden className={cx("size-5 shrink-0 text-ink-3 transition-transform", open && "rotate-180")}>
            <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </h2>
      {/* 收起时整个卸载;再展开会重新拉一次最新名单 */}
      {open && (
        <div id="waitlist-body" className="mt-3">
          <WaitlistBody />
        </div>
      )}
    </section>
  );
}

function statusOf(r: WaitlistRow): { text: string; className: string } {
  if (r.registered) return { text: "已注册", className: "text-ok" };
  if (r.invitedAt) return { text: `已邀请(${r.inviteCode ?? "—"})`, className: "text-ink" };
  return { text: "待邀请", className: "text-ink-3" };
}

type Pending = { body: InviteWaitlistBody; text: string };

function WaitlistBody() {
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<AdminWaitlistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [count, setCount] = useState("10");
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteWaitlistResponse["invited"] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.adminWaitlist(filter).then(
      (r) => {
        if (!alive) return;
        setData(r);
        setError(null);
        // 已经邀请过的不能再勾
        setSelected((prev) => new Set(r.rows.filter((x) => !x.invitedAt && prev.has(x.email)).map((x) => x.email)));
      },
      (e: unknown) => alive && setError(failureMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [filter, version]);

  const selectable = data?.rows.filter((r) => !r.invitedAt) ?? [];
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.email));
  const n = Number(count);
  const countValid = Number.isInteger(n) && n >= 1 && n <= MAX_INVITE;

  function toggle(email: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(email);
      else next.delete(email);
      return next;
    });
  }

  function askByCount(e: FormEvent) {
    e.preventDefault();
    if (!countValid) {
      setError(`人数应为 1–${MAX_INVITE} 的整数`);
      return;
    }
    setError(null);
    setConfirm({ body: { count: n }, text: `给最早登记、还没邀请的 ${n} 位发邀请码。` });
  }

  function askBySelection() {
    const emails = selectable.filter((r) => selected.has(r.email)).map((r) => r.email);
    if (!emails.length) return;
    setError(null);
    setConfirm({ body: { emails }, text: `给选中的 ${emails.length} 位发邀请码。` });
  }

  async function invite() {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    setCopied(null);
    try {
      const r = await api.inviteWaitlist(confirm.body);
      setResult(r.invited);
      setSelected(new Set());
      setVersion((v) => v + 1);
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
    } catch {
      setError("复制失败,请手动选择邀请码复制");
    }
  }

  const unmailed = result?.filter((x) => !x.mailed).length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      {error && <p className={alert.error}>{error}</p>}
      {!data ? (
        !error && <p className="text-ink-3">加载中…</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="waitlist-stats">
            <Stat label="登记" value={data.total} />
            <Stat label="待邀请" value={data.total - data.invited} />
            <Stat label="已邀请" value={data.invited} />
            <Stat label="已注册" value={data.registered} />
          </dl>
          <div className="text-sm leading-7">
            <span className="text-ink-3">来源:</span>
            {data.bySource.length === 0 ? (
              <span className="text-ink-3">还没有数据</span>
            ) : (
              <ul className="inline" data-testid="waitlist-sources">
                {data.bySource.map((s, i) => (
                  <li key={s.source} className="inline">
                    {i > 0 && <span className="px-1.5 text-ink-3">·</span>}
                    {s.source} <span className="tabular-nums">{s.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 邀请:按登记顺序取最早的 N 位,或者在下面的名单里勾选 */}
          <div className="flex flex-col gap-3 rounded-lg bg-surface-2 p-4">
            <p className="text-sm leading-relaxed text-ink-2">
              每人一个只能用一次的邀请码;配置了邮件服务(SMTP_URL)会直接发邀请邮件,链接里带好邀请码和邮箱。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <form onSubmit={askByCount} className="flex items-center gap-2" noValidate>
                <input
                  className={cx(inlineInput, "w-24")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_INVITE}
                  aria-label="邀请人数"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
                <button type="submit" className={btn.primary} disabled={busy}>
                  {countValid ? `邀请最早的 ${n} 位` : "邀请最早的 N 位"}
                </button>
              </form>
              <button type="button" className={btn.secondary} disabled={busy || selected.size === 0} onClick={askBySelection}>
                邀请选中的({selected.size})
              </button>
              <a href={ADMIN_WAITLIST_CSV_URL} download className={btn.ghost}>
                导出 CSV
              </a>
            </div>
          </div>

          {result && (
            <div data-testid="waitlist-invited" className="flex flex-col gap-2">
              <p className={result.length === 0 ? alert.info : unmailed ? alert.warn : alert.ok} role="status">
                {result.length === 0
                  ? "没有需要邀请的人(选中的人都已经邀请过了)。"
                  : unmailed
                    ? `发出 ${result.length} 个邀请码,其中 ${unmailed} 个没有发邮件,请复制邀请码转给对方。`
                    : `发出 ${result.length} 个邀请码,邀请邮件都已发出。`}
              </p>
              {result.length > 0 && (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {result.map((x) => (
                    <li key={x.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <span className="min-w-0 break-all">{x.email}</span>
                      <code className="select-all font-mono text-[15px]">{x.inviteCode}</code>
                      <span className={x.mailed ? "text-ok" : "text-warn"}>{x.mailed ? "已发邮件" : "未发邮件"}</span>
                      {!x.mailed && (
                        <button type="button" className={cx(btn.small, "ml-auto")} onClick={() => void copy(x.inviteCode)} aria-label={`复制 ${x.email} 的邀请码`}>
                          {copied === x.inviteCode ? "已复制" : "复制"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 self-start text-sm text-ink-2">
              显示
              <select className={inlineInput} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                {FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            {data.rows.length === 0 ? (
              <p className="text-ink-3">{data.total === 0 ? "还没有人登记。" : "没有符合条件的人。"}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm" data-testid="waitlist-rows">
                  <thead className="border-b border-line text-ink-3">
                    <tr>
                      <th className="w-10 py-2 pr-2 font-medium">
                        <input
                          type="checkbox"
                          className="size-5 align-middle accent-[var(--accent)]"
                          aria-label="全选待邀请的"
                          checked={allSelected}
                          disabled={selectable.length === 0}
                          onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((r) => r.email)) : new Set())}
                        />
                      </th>
                      <th className="py-2 pr-3 font-medium">邮箱</th>
                      <th className="py-2 pr-3 font-medium">身份</th>
                      <th className="py-2 pr-3 font-medium">来源</th>
                      <th className="py-2 pr-3 font-medium">登记时间</th>
                      <th className="py-2 font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.rows.map((r) => {
                      const s = statusOf(r);
                      return (
                        <tr key={r.email}>
                          <td className="py-2 pr-2 align-top">
                            <input
                              type="checkbox"
                              className="size-5 align-middle accent-[var(--accent)]"
                              aria-label={`选择 ${r.email}`}
                              checked={selected.has(r.email)}
                              disabled={Boolean(r.invitedAt)}
                              onChange={(e) => toggle(r.email, e.target.checked)}
                            />
                          </td>
                          <td className="py-2 pr-3 align-top">
                            <span className="break-all">{r.email}</span>
                            {r.note && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{r.note}</p>}
                          </td>
                          <td className="py-2 pr-3 align-top whitespace-nowrap">{roleLabel(r.role)}</td>
                          <td className="py-2 pr-3 align-top">{r.source ?? "—"}</td>
                          <td className="py-2 pr-3 align-top whitespace-nowrap tabular-nums">{formatDateTime(r.createdAt)}</td>
                          <td className={cx("py-2 align-top whitespace-nowrap", s.className)}>{s.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <Modal
        open={confirm !== null}
        title="确定发邀请码?"
        onClose={() => !busy && setConfirm(null)}
        size="sm"
        footer={
          <>
            <button type="button" className={btn.ghost} disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </button>
            <button type="button" className={btn.primary} disabled={busy} onClick={() => void invite()}>
              {busy ? "正在发送…" : "确定发送"}
            </button>
          </>
        }
      >
        <p className="text-[15px] leading-7">{confirm?.text}</p>
        <p className="mt-2 text-[15px] leading-7 text-ink-2">配置了邮件服务的话会马上发出邀请邮件,发出去就收不回了。已经邀请过的人会跳过。</p>
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <dt className="text-sm text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
