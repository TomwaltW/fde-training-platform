"use client";
// 对局页的几个对话框:去现场、做验证、我的判断是…、收工确认、生成复盘中。
import Link from "next/link";
import { useEffect, useState } from "react";
import type { PublicView } from "@fde/contracts";
import { Modal } from "@/components/Modal";
import { local } from "@/lib/client/hooks";
import { cx } from "@/lib/client/format";
import { alert, btn, field } from "@/lib/client/ui";

type Action = PublicView["actions"][number];
type Experiment = PublicView["experiments"][number];

/** 按钮动作为什么现在点不了。不剧透具体条件,只说大概。 */
export function actionBlockedReason(a: Action, phase: PublicView["phase"]): string | null {
  if (a.available) return null;
  if (a.done) return "已经去过了。";
  if (phase !== "kickoff" && phase !== "discovery") return "调研阶段已经结束,现在不能去了。";
  return "现在还去不了:得先有人点头,或者有人带你过去。";
}

export function ActionsDialog({
  open,
  actions,
  phase,
  disabled,
  onRun,
  onClose,
}: {
  open: boolean;
  actions: Action[];
  phase: PublicView["phase"];
  disabled: boolean;
  onRun: (a: Action) => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} title="去现场看看" onClose={onClose} size="sm" testId="actions-dialog">
      {actions.length === 0 ? (
        <p className="text-ink-2">这个场景里没有可以去的地方。</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {actions.map((a) => {
            const reason = actionBlockedReason(a, phase);
            return (
              <li key={a.id} className={cx("rounded-lg border border-line p-3", !a.available && "bg-surface-2")}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className={cx("font-medium leading-6", !a.available && "text-ink-3")}>{a.title}</p>
                    <p className="text-sm text-ink-3">要花 {a.costMin} 分钟</p>
                  </div>
                  <button type="button" className={cx(btn.primary, "shrink-0")} disabled={!a.available || disabled} onClick={() => onRun(a)}>
                    {a.done ? "去过了" : "去"}
                  </button>
                </div>
                {reason && <p className="mt-2 text-sm text-ink-2">{reason}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 text-sm text-ink-3">也可以直接在对话里说"我想去现场看看",效果一样。</p>
    </Modal>
  );
}

export function ExperimentsDialog({
  open,
  experiments,
  locked,
  phase,
  disabled,
  onRun,
  onClose,
}: {
  open: boolean;
  experiments: Experiment[];
  locked: number;
  phase: PublicView["phase"];
  disabled: boolean;
  onRun: (x: Experiment) => void;
  onClose: () => void;
}) {
  const canDo = phase === "kickoff" || phase === "discovery";
  return (
    <Modal open={open} title="做个验证" onClose={onClose} size="sm" testId="experiments-dialog">
      <p className="mb-3 text-sm leading-6 text-ink-2">用拿到的资料做一次小验证,结果会写进对话里。每个验证都要花时间。</p>
      {experiments.length === 0 ? (
        <p className={alert.info}>现在还没有能做的验证。</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {experiments.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
              <div className="min-w-0">
                <p className="font-medium leading-6">{x.title}</p>
                <p className="text-sm text-ink-3">{x.done ? "做过了,可以再看一遍结果" : `要花 ${x.costMin} 分钟`}</p>
              </div>
              <button type="button" className={cx(x.done ? btn.secondary : btn.primary, "shrink-0")} disabled={disabled || !canDo} onClick={() => onRun(x)}>
                {x.done ? "看结果" : "做这个"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {locked > 0 && (
        <p className="mt-4 text-sm leading-6 text-ink-2" data-testid="locked-experiments">
          还有 {locked} 个验证没解锁:拿到相应资料后才能做。
        </p>
      )}
      {!canDo && <p className="mt-2 text-sm text-ink-3">调研阶段已经结束,现在不能做验证了。</p>}
    </Modal>
  );
}

export function JudgmentDialog({
  open,
  sessionId,
  form,
  disabled,
  onSubmit,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  form: PublicView["judgmentForm"];
  disabled: boolean;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const key = `fde:judgment:${sessionId}`;
  const [values, setValues] = useState<Record<string, string>>({});

  // 草稿存在本机,不小心关掉也不丢
  useEffect(() => {
    if (!open) return;
    const raw = local.get(key);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") setValues(parsed as Record<string, string>);
    } catch {
      /* 草稿坏了就不要了 */
    }
  }, [open, key]);

  const set = (id: string, v: string) => {
    setValues((prev) => {
      const next = { ...prev, [id]: v };
      local.set(key, JSON.stringify(next));
      return next;
    });
  };

  const filled = form.filter((f) => (values[f.id] ?? "").trim()).length;
  const empty = form.length - filled;

  return (
    <Modal
      open={open}
      title="我的判断是…"
      onClose={onClose}
      full
      size="lg"
      testId="judgment-dialog"
      footer={
        <>
          <button type="button" className={btn.ghost} onClick={onClose}>
            先不交
          </button>
          <button
            type="button"
            className={btn.primary}
            disabled={disabled || filled === 0}
            onClick={() => {
              const out: Record<string, string> = {};
              for (const f of form) out[f.id] = (values[f.id] ?? "").trim();
              onSubmit(out);
            }}
          >
            提交判断
          </button>
        </>
      }
    >
      <p className="mb-4 text-[15px] leading-7 text-ink-2">提交后进入下午汇报:去会议室向老板讲你的判断。提交后不能再回去调研,也不能再改。</p>
      <div className="flex flex-col gap-5">
        {form.map((f) => (
          <label key={f.id} className={field.label}>
            <span className="text-ink-3">{f.id}</span> {f.label}
            <textarea className={field.textarea} rows={3} maxLength={2000} value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} />
          </label>
        ))}
      </div>
      {filled > 0 && empty > 0 && <p className={cx(alert.warn, "mt-4")}>还有 {empty} 项空着。空着也能交,这些项会按没答处理。</p>}
    </Modal>
  );
}

export function clearJudgmentDraft(sessionId: string) {
  local.remove(`fde:judgment:${sessionId}`);
}

export function EndDialog({
  open,
  judgmentSubmitted,
  disabled,
  onConfirm,
  onClose,
}: {
  open: boolean;
  judgmentSubmitted: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title="收工?"
      onClose={onClose}
      size="sm"
      testId="end-dialog"
      footer={
        <>
          <button type="button" className={btn.ghost} onClick={onClose}>
            再想想
          </button>
          <button type="button" className={btn.primary} disabled={disabled} onClick={onConfirm}>
            收工,看复盘
          </button>
        </>
      }
    >
      <p className="text-[15px] leading-7">收工后这一局就结束了,马上生成复盘。</p>
      {!judgmentSubmitted && (
        <p className={cx(alert.warn, "mt-3")}>你还没提交判断。复盘里诊断、成功定义、范围这几项只能按对话内容来判。</p>
      )}
    </Modal>
  );
}

export function FinishingOverlay({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-canvas/95 px-6" role="alertdialog" aria-modal="true" aria-labelledby="finishing-title" data-testid="finishing">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        {error ? (
          <>
            <p id="finishing-title" className="text-lg font-semibold">
              复盘没生成出来
            </p>
            <p className="text-ink-2">{error}</p>
            <p className="text-sm text-ink-3">这一局已经收工,进度不会丢。可以再试一次,也可以稍后在「我的对局」里打开复盘。</p>
            <div className="flex gap-2">
              <Link href="/me" className={btn.secondary}>
                我的对局
              </Link>
              <button type="button" className={btn.primary} onClick={onRetry}>
                再试一次
              </button>
            </div>
          </>
        ) : (
          <>
            <span aria-hidden className="size-10 animate-spin rounded-full border-4 border-line border-t-accent" />
            <p id="finishing-title" className="text-lg font-semibold">
              正在生成复盘,可能要几十秒
            </p>
            <p className="text-sm leading-6 text-ink-2">裁判在逐轮找证据,分数由规则算出来。别关这个页面。</p>
          </>
        )}
      </div>
    </div>
  );
}
