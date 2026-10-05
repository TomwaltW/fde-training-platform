"use client";
// 对话框:手机上从底部弹出、占满宽度,电脑上居中。Esc 关闭,打开时锁住页面滚动。
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "@/lib/client/format";

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = "md",
  full = false,
  testId,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** 手机上铺满整屏(资料查看器、判断表单)。 */
  full?: boolean;
  testId?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    // 焦点移进对话框,方便键盘和读屏
    panel.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-6" data-testid={testId}>
      <div className="absolute inset-0 bg-black/45" aria-hidden onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "relative flex w-full flex-col bg-surface shadow-xl outline-none sm:rounded-2xl",
          full ? "h-dvh sm:h-auto sm:max-h-[90dvh]" : "max-h-[88dvh] rounded-t-2xl",
          size === "sm" && "sm:max-w-md",
          size === "md" && "sm:max-w-xl",
          size === "lg" && "sm:max-w-3xl",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 id={titleId} className="min-w-0 text-base font-semibold leading-snug">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="-mr-2 grid size-11 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2" aria-label="关闭">
            <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}
