// 渲染 markdown(源文里的 HTML 已在 renderMarkdown 里先转义)。服务端组件和客户端组件都能用。
import { renderMarkdown } from "@/lib/client/markdown";
import { cx } from "@/lib/client/format";

export function Markdown({ source, className, testId }: { source: string; className?: string; testId?: string }) {
  return <div data-testid={testId} className={cx("prose-doc", className)} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />;
}

/** 常驻的 AI 生成标识(对局页、复盘页)。 */
export function AiBadge({ text, className }: { text: string; className?: string }) {
  return (
    <span data-testid="ai-badge" className={cx("inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs leading-5 text-ink-2", className)}>
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 7v4M8 4.6v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {text}
    </span>
  );
}
