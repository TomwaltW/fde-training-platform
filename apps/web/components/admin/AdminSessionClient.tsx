"use client";
// 管理页的对局详情:对话、事件、承诺账本、复盘、反馈、模型调用。
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AdminSessionDetail } from "@fde/contracts";
import { Markdown } from "@/components/Markdown";
import { Transcript } from "@/components/play/Transcript";
import { api, failureMessage } from "@/lib/client/api";
import { cx, formatDateTime, formatMinutes, formatScore, formatYuan, phaseLabel } from "@/lib/client/format";
import { alert, card } from "@/lib/client/ui";
import { AdminGate, adminWrap } from "./AdminGate";

type Tab = "transcript" | "events" | "ledger" | "report" | "feedback" | "llm";

const TABS: { id: Tab; label: string }[] = [
  { id: "transcript", label: "对话" },
  { id: "events", label: "事件" },
  { id: "ledger", label: "账本" },
  { id: "report", label: "复盘" },
  { id: "feedback", label: "反馈" },
  { id: "llm", label: "模型调用" },
];

export function AdminSessionClient({ sessionId }: { sessionId: string }) {
  return (
    <AdminGate next={`/admin/sessions/${encodeURIComponent(sessionId)}`}>
      <Detail sessionId={sessionId} />
    </AdminGate>
  );
}

const th = "py-2 pr-3 text-left font-medium text-ink-3";
const td = "py-2 pr-3 align-top";

function Detail({ sessionId }: { sessionId: string }) {
  const [d, setD] = useState<AdminSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");

  useEffect(() => {
    let alive = true;
    api.adminSession(sessionId).then(
      (r) => alive && setD(r),
      (e: unknown) => alive && setError(failureMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (error)
    return (
      <main className={adminWrap}>
        <p className={alert.error}>{error}</p>
      </main>
    );
  if (!d) return <main className={cx(adminWrap, "text-ink-3")}>加载中…</main>;

  const v = d.view;
  const cost = d.llmCalls.reduce((s, c) => s + (c.costYuan ?? 0), 0);
  const failed = d.llmCalls.filter((c) => !c.ok).length;

  return (
    <main className={adminWrap} data-testid="admin-session">
      <Link href="/admin" className="inline-flex min-h-11 items-center self-start text-sm text-accent hover:underline">
        ‹ 返回管理页
      </Link>
      <div>
        <h1 className="text-xl font-bold">{v.scenario.title}</h1>
        <p className="mt-1 break-all text-sm text-ink-2">
          {d.userEmail} · {v.sessionId} · {phaseLabel(v.phase)} · 剩 {formatMinutes(v.minutesLeft)} · {v.judgmentSubmitted ? "已交判断" : "没交判断"}
          {d.report && ` · ${formatScore(d.report.total)} 分`}
        </p>
      </div>

      <div role="tablist" aria-label="详情" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx("min-h-11 border-b-2 px-3 text-[15px]", tab === t.id ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "transcript" && (
        <section className={cx(card, "p-4")}>
          {v.transcript.length === 0 ? <p className="text-ink-3">没有对话。</p> : <Transcript lines={v.transcript} />}
        </section>
      )}

      {tab === "events" && (
        <section className={cx(card, "overflow-x-auto p-4")}>
          {d.events.length === 0 ? (
            <p className="text-ink-3">没有事件。</p>
          ) : (
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>轮</th>
                  <th className={th}>类型</th>
                  <th className={th}>内容</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.events.map((e, i) => (
                  <tr key={i}>
                    <td className={cx(td, "tabular-nums")}>{e.turn}</td>
                    <td className={cx(td, "font-mono whitespace-nowrap")}>{e.type}</td>
                    <td className={cx(td, "font-mono text-xs leading-5 break-all text-ink-2")}>{JSON.stringify(e.payload)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "ledger" && (
        <section className={cx(card, "overflow-x-auto p-4")}>
          {d.ledger.length === 0 ? (
            <p className="text-ink-3">账本是空的:没有记下任何承诺。</p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>轮</th>
                  <th className={th}>类型</th>
                  <th className={th}>原话</th>
                  <th className={th}>对谁</th>
                  <th className={th}>过早</th>
                  <th className={th}>当时已知</th>
                  <th className={th}>收回</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.ledger.map((l) => (
                  <tr key={l.id}>
                    <td className={cx(td, "tabular-nums")}>{l.turn}</td>
                    <td className={td}>{l.type}</td>
                    <td className={td}>{l.valueText}</td>
                    <td className={td}>{l.role}</td>
                    <td className={td}>{l.premature ? "是" : "否"}</td>
                    <td className={cx(td, "text-xs text-ink-2")}>
                      事实 {l.knownAtThatTime.facts.join("、") || "无"};资料 {l.knownAtThatTime.artifactsOpened.join("、") || "无"}
                    </td>
                    <td className={td}>{l.retractedTurn !== undefined ? `第 ${l.retractedTurn} 轮` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "report" && (
        <section className={cx(card, "p-5")}>
          {!d.report ? (
            <p className="text-ink-3">还没有复盘。</p>
          ) : (
            <>
              <p className="text-lg font-semibold">
                {formatScore(d.report.total)} 分 · {d.report.band}
              </p>
              <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                {d.report.dimensions.map((x) => (
                  <li key={x.id}>
                    {x.id} {x.name}:{formatScore(x.score)} / {x.max}
                  </li>
                ))}
              </ul>
              <div className="mt-5 border-t border-line pt-4">
                <Markdown source={d.report.markdown} />
              </div>
            </>
          )}
        </section>
      )}

      {tab === "feedback" && (
        <section className={cx(card, "p-4")}>
          {d.feedback.length === 0 ? (
            <p className="text-ink-3">没有反馈。</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.feedback.map((f, i) => (
                <li key={i} className="py-3 text-[15px] leading-7">
                  <p className="text-sm text-ink-3">{formatDateTime(f.createdAt)}</p>
                  {f.rating !== null && <p>推荐意愿:{f.rating} / 10</p>}
                  {f.text && <p>{f.text}</p>}
                  {f.dispute && (
                    <p className="text-ink-2">
                      申诉 {f.dispute.dimension}:{f.dispute.reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "llm" && (
        <section className={cx(card, "overflow-x-auto p-4")}>
          <p className="mb-3 text-sm text-ink-2">
            共 {d.llmCalls.length} 次 · 合计 {formatYuan(cost, 4)} · 失败 {failed} 次
          </p>
          {d.llmCalls.length > 0 && (
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>时间</th>
                  <th className={th}>环节</th>
                  <th className={th}>模型</th>
                  <th className={cx(th, "text-right")}>输入</th>
                  <th className={cx(th, "text-right")}>输出</th>
                  <th className={cx(th, "text-right")}>成本</th>
                  <th className={cx(th, "text-right")}>耗时</th>
                  <th className={th}>结果</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line tabular-nums">
                {d.llmCalls.map((c, i) => (
                  <tr key={i}>
                    <td className={cx(td, "whitespace-nowrap")}>{formatDateTime(c.at)}</td>
                    <td className={td}>{c.stage}</td>
                    <td className={cx(td, "font-mono text-xs")}>{c.model}</td>
                    <td className={cx(td, "text-right")}>{c.tokensIn}</td>
                    <td className={cx(td, "text-right")}>{c.tokensOut}</td>
                    <td className={cx(td, "text-right")}>{c.costYuan === null ? "—" : formatYuan(c.costYuan, 4)}</td>
                    <td className={cx(td, "text-right")}>{c.latencyMs} ms</td>
                    <td className={td}>{c.ok ? "成功" : <span className="text-danger">失败</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
