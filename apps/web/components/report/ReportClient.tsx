"use client";
// 复盘页(方案 3.4.3):总分与分数段、标记、七维雷达图、各维度得分与说明("我不同意"申诉)、
// 复盘正文、分享卡(只用 shareCard,不含真相)、推荐意愿 0–10。
// 第三轮:"如果有下一个场景,你想玩吗?"(方案 6.3 第二关),复盘打开后记一条 report_viewed。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PublicReport } from "@fde/contracts";
import { RadarChart } from "@/components/charts";
import { AiBadge, Markdown } from "@/components/Markdown";
import { ShareCard } from "@/components/ShareCard";
import { api, failureMessage, isFailure, loginHref, track } from "@/lib/client/api";
import { cx, formatScore } from "@/lib/client/format";
import { alert, btn, card, field } from "@/lib/client/ui";

type State = { status: "loading" } | { status: "generating" } | { status: "not_ended" } | { status: "error"; message: string } | { status: "ok"; report: PublicReport };

/** 方案 3.4.1 的分数段。 */
const BANDS = [
  { min: 0, max: 49, label: "接了一个会翻车的单" },
  { min: 50, max: 69, label: "被客户带着走" },
  { min: 70, max: 84, label: "方向对,有遗漏" },
  { min: 85, max: 100, label: "可以独立去见这个客户" },
];

export function ReportClient({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });
  const started = useRef(false);
  const viewed = useRef(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const r = await api.report(sessionId);
      setState({ status: "ok", report: r.report });
      return;
    } catch (e) {
      if (isFailure(e, "unauthorized")) return router.push(loginHref(`/report/${encodeURIComponent(sessionId)}`));
      if (!isFailure(e, "not_found")) return setState({ status: "error", message: failureMessage(e) });
    }
    // 还没出复盘:对局已经结束就补一次收工(幂等);还在进行就不动它
    try {
      const s = await api.session(sessionId);
      if (!s.view.ended) return setState({ status: "not_ended" });
      setState({ status: "generating" });
      const f = await api.finish(sessionId);
      setState({ status: "ok", report: f.report });
    } catch (e) {
      setState({ status: "error", message: isFailure(e, "not_found", "forbidden") ? "没有找到这份复盘。" : failureMessage(e) });
    }
  }, [sessionId, router]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  // 复盘加载成功后记一次(重试、补收工后才出来的也只记一次)
  useEffect(() => {
    if (state.status !== "ok" || viewed.current) return;
    viewed.current = true;
    track("report_viewed", { sessionId });
  }, [state.status, sessionId]);

  if (state.status === "loading") return <Center>正在打开复盘…</Center>;
  if (state.status === "generating")
    return (
      <Center>
        <span aria-hidden className="size-10 animate-spin rounded-full border-4 border-line border-t-accent" />
        <p className="text-lg font-semibold text-ink">正在生成复盘,可能要几十秒</p>
      </Center>
    );
  if (state.status === "not_ended")
    return (
      <Center>
        <p className="text-lg font-semibold text-ink">这一局还没收工</p>
        <Link href={`/play/${encodeURIComponent(sessionId)}`} className={btn.primary}>
          回去接着玩
        </Link>
      </Center>
    );
  if (state.status === "error")
    return (
      <Center>
        <p className="text-lg font-semibold text-ink">打不开复盘</p>
        <p>{state.message}</p>
        <button
          type="button"
          className={btn.primary}
          onClick={() => {
            void load();
          }}
        >
          重试
        </button>
      </Center>
    );

  const r = state.report;
  const bandIndex = BANDS.reduce((acc, b, i) => (r.total >= b.min ? i : acc), 0);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:py-10" data-testid="report">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">{r.scenarioTitle} · 复盘</p>
        <AiBadge text={r.aiNotice} />
      </div>

      {/* 总分与分数段 */}
      <section className={cx(card, "p-5 sm:p-7")} aria-labelledby="score-title">
        <h1 id="score-title" className="sr-only">
          总分
        </h1>
        <div className="flex items-end gap-2">
          <span className="text-6xl font-bold leading-none tracking-tight" data-testid="report-total">
            {formatScore(r.total)}
          </span>
          <span className="pb-1 text-lg text-ink-3">/ 100</span>
        </div>
        <p className="mt-3 text-xl font-semibold" data-testid="report-band">
          {r.band}
        </p>
        <ol className="mt-4 grid grid-cols-4 gap-1" aria-label="分数段">
          {BANDS.map((b, i) => {
            const on = i === bandIndex;
            return (
              <li key={b.min} aria-current={on ? "true" : undefined}>
                <span className={cx("block h-2 rounded-full", on ? "bg-accent" : "bg-surface-2")} />
                <span className={cx("mt-1.5 block text-[11px] leading-4 sm:text-xs", on ? "font-semibold text-ink" : "text-ink-3")}>
                  {b.min === 85 ? "85+" : `${b.min}–${b.max}`}
                  <span className="hidden sm:block">{b.label}</span>
                </span>
              </li>
            );
          })}
        </ol>
        {r.badges.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-2" aria-label="标记" data-testid="report-badges">
            {r.badges.map((b) => (
              <li key={b} className="rounded-full bg-warn-soft px-3 py-0.5 text-sm text-ink ring-1 ring-warn/40">
                {b}
              </li>
            ))}
          </ul>
        )}
        {r.caps.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1 text-sm text-ink-2">
            {r.caps.map((c) => (
              <li key={c}>封顶:{c}</li>
            ))}
          </ul>
        )}
      </section>

      {/* 七个维度 */}
      <section className={cx(card, "p-5 sm:p-7")} aria-labelledby="dims-title">
        <h2 id="dims-title" className="text-lg font-semibold">
          七个维度
        </h2>
        <div className="mt-2">
          <RadarChart dims={r.dimensions} />
        </div>
        <ul className="mt-4 divide-y divide-line" data-testid="dimensions">
          {r.dimensions.map((d) => (
            <DimensionRow key={d.id} sessionId={sessionId} dim={d} />
          ))}
        </ul>
        <p className="mt-3 text-[13px] leading-6 text-ink-3">觉得哪一项判错了,点「我不同意」写下理由。申诉会被人工复核,也会用来校准评分。</p>
      </section>

      {/* 复盘正文 */}
      <section className={cx(card, "p-5 sm:p-7")} aria-label="复盘正文">
        <Markdown source={r.markdown} testId="report-markdown" />
      </section>

      {/* 分享卡 */}
      <section className={cx(card, "p-5 sm:p-7")} aria-labelledby="share-title">
        <h2 id="share-title" className="mb-4 text-lg font-semibold">
          分享卡
        </h2>
        <ShareCard card={r.shareCard} sessionId={sessionId} />
      </section>

      {/* 推荐意愿、想不想玩下一个场景 */}
      <RatingForm sessionId={sessionId} />
      <WantNextForm sessionId={sessionId} />

      <nav className="flex flex-wrap gap-2">
        <Link href="/me" className={btn.secondary}>
          我的对局
        </Link>
        <Link href="/" className={btn.ghost}>
          再来一局
        </Link>
      </nav>
    </main>
  );
}

function Center({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center text-ink-2">{children}</main>;
}

function DimensionRow({ sessionId, dim }: { sessionId: string; dim: PublicReport["dimensions"][number] }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const pct = dim.max > 0 ? Math.max(0, Math.min(100, (dim.score / dim.max) * 100)) : 0;

  async function submit() {
    const text = reason.trim();
    if (text.length < 2) {
      setError("写一句理由,比如你在第几轮问过什么。");
      return;
    }
    setStatus("sending");
    setError(null);
    try {
      await api.feedback(sessionId, { dispute: { dimension: dim.id, reason: text } });
      setStatus("sent");
      setOpen(false);
    } catch (e) {
      setStatus("idle");
      setError(failureMessage(e));
    }
  }

  return (
    <li className="py-4" data-testid={`dimension-${dim.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium">
          <span className="mr-1.5 text-sm text-ink-3">{dim.id}</span>
          {dim.name}
        </p>
        <p className="shrink-0 font-semibold tabular-nums">
          {formatScore(dim.score)}
          <span className="font-normal text-ink-3"> / {dim.max}</span>
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      {dim.details.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-[14px] leading-6 text-ink-2">
          {dim.details.map((t, i) => (
            <li key={i}>· {t}</li>
          ))}
        </ul>
      )}
      <div className="mt-2">
        {status === "sent" ? (
          <p className="text-sm text-ok">已提交申诉,会有人工复核。</p>
        ) : open ? (
          <div className="flex flex-col gap-2">
            <label className={field.label}>
              为什么不同意「{dim.name}」的得分?
              <textarea
                className={field.textarea}
                rows={3}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="比如:我在第 5 轮问过异常记录在谁那儿"
                autoFocus
              />
            </label>
            <div className="flex gap-2">
              <button type="button" className={btn.primary} disabled={status === "sending"} onClick={() => void submit()}>
                {status === "sending" ? "正在提交…" : "提交申诉"}
              </button>
              <button type="button" className={btn.ghost} onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={cx(btn.small, "border border-line")} onClick={() => setOpen(true)} aria-label={`我不同意:${dim.name}`}>
            我不同意
          </button>
        )}
        {error && <p className={cx(alert.error, "mt-2")}>{error}</p>}
      </div>
    </li>
  );
}

function RatingForm({ sessionId }: { sessionId: string }) {
  const [rating, setRating] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (rating === null) return;
    setStatus("sending");
    setError(null);
    try {
      const t = text.trim();
      await api.feedback(sessionId, t ? { rating, text: t } : { rating });
      setStatus("sent");
    } catch (e) {
      setStatus("idle");
      setError(failureMessage(e));
    }
  }

  return (
    <section className={cx(card, "p-5 sm:p-7")} aria-labelledby="rating-title" data-testid="rating">
      <h2 id="rating-title" className="text-lg font-semibold">
        你会把这个练习推荐给同行吗?
      </h2>
      <p className="mt-1 text-sm text-ink-3">0 = 完全不会,10 = 一定会</p>
      {status === "sent" ? (
        <p className={cx(alert.ok, "mt-4")}>收到,谢谢。</p>
      ) : (
        <>
          <div role="radiogroup" aria-label="推荐意愿 0 到 10" className="mt-4 grid grid-cols-6 gap-2 sm:grid-cols-11">
            {Array.from({ length: 11 }, (_, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={rating === i}
                onClick={() => setRating(i)}
                className={cx(
                  "min-h-11 rounded-lg border text-base font-semibold tabular-nums transition-colors",
                  rating === i ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface hover:bg-surface-2",
                )}
              >
                {i}
              </button>
            ))}
          </div>
          <label className={cx(field.label, "mt-4")}>
            还有什么想说的(选填)
            <textarea className={field.textarea} rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <button type="button" className={cx(btn.primary, "mt-3")} disabled={rating === null || status === "sending"} onClick={() => void submit()}>
            {status === "sending" ? "正在提交…" : "提交"}
          </button>
          {error && <p className={cx(alert.error, "mt-2")}>{error}</p>}
        </>
      )}
    </section>
  );
}

/** 方案 6.3 第二关"完成者中表示想玩下一个场景的比例"。点了就提交。 */
function WantNextForm({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function answer(wantNext: boolean) {
    setStatus("sending");
    setError(null);
    try {
      await api.feedback(sessionId, { wantNext });
      setStatus("sent");
    } catch (e) {
      setStatus("idle");
      setError(failureMessage(e));
    }
  }

  return (
    <section className={cx(card, "p-5 sm:p-7")} aria-labelledby="want-next-title" data-testid="want-next">
      <h2 id="want-next-title" className="text-lg font-semibold">
        如果有下一个场景,你想玩吗?
      </h2>
      {status === "sent" ? (
        <p className={cx(alert.ok, "mt-4")}>已收到,谢谢。</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:max-w-xs">
            <button type="button" className={btn.secondary} disabled={status === "sending"} onClick={() => void answer(true)}>
              想
            </button>
            <button type="button" className={btn.secondary} disabled={status === "sending"} onClick={() => void answer(false)}>
              不想
            </button>
          </div>
          {error && <p className={cx(alert.error, "mt-2")}>{error}</p>}
        </>
      )}
    </section>
  );
}
