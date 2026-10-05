// 对话记录:用户、角色、旁白三种样式。对局页和管理页的对局详情共用。
import type { ReactNode } from "react";
import type { PublicView } from "@fde/contracts";
import { cx } from "@/lib/client/format";

export type Line = PublicView["transcript"][number];

/** 头像上的字:"小林"取"林","周总"取"周"。 */
export function initial(name: string): string {
  const chars = [...name];
  return (chars[0] === "小" || chars[0] === "老") && chars[1] ? chars[1] : (chars[0] ?? "?");
}

export function Avatar({ name, active = false, size = "md" }: { name: string; active?: boolean; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid shrink-0 place-items-center rounded-full font-semibold",
        size === "sm" ? "size-8 text-sm" : "size-10 text-base",
        active ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2 ring-1 ring-line",
      )}
    >
      {initial(name)}
    </span>
  );
}

/** 空行分段:旁白常有好几段,按段落排比一整块 pre-line 好读。 */
function Paragraphs({ text }: { text: string }) {
  const parts = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (parts.length <= 1) return <>{text}</>;
  return (
    <span className="flex flex-col gap-2">
      {parts.map((p, i) => (
        <span key={i} className="block">
          {p}
        </span>
      ))}
    </span>
  );
}

export function TranscriptLine({ line }: { line: Line }) {
  if (line.speaker === "user") {
    return (
      <li className="flex justify-end" data-testid="line" data-speaker="user">
        <div className="flex max-w-[85%] flex-col items-end">
          <p className="mb-1 text-xs text-ink-3">你{line.roleName ? ` · 对${line.roleName}说` : ""}</p>
          <div className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-accent px-3.5 py-2 text-[15px] leading-7 text-accent-ink">{line.text}</div>
        </div>
      </li>
    );
  }
  if (line.speaker === "npc") {
    const name = line.roleName ?? line.roleId ?? "对方";
    return (
      <li className="flex justify-start gap-2" data-testid="line" data-speaker="npc">
        <Avatar name={name} size="sm" />
        <div className="flex max-w-[85%] flex-col items-start">
          <p className="mb-1 text-xs text-ink-3">{name}</p>
          <div className="whitespace-pre-wrap rounded-2xl rounded-tl-md border border-line bg-surface px-3.5 py-2 text-[15px] leading-7">
            <Paragraphs text={line.text} />
          </div>
        </div>
      </li>
    );
  }
  return (
    <li className="mx-auto w-full max-w-[94%]" data-testid="line" data-speaker="system">
      <div className="whitespace-pre-line rounded-lg border-l-2 border-ink-3/50 bg-surface-2 px-3.5 py-2 text-[14px] leading-7 text-ink-2">
        <span className="sr-only">旁白:</span>
        <Paragraphs text={line.text} />
      </div>
    </li>
  );
}

/** children 接在记录末尾(对局页用来放"正在说话…")。 */
export function Transcript({ lines, children }: { lines: Line[]; children?: ReactNode }) {
  return (
    <ol className="flex flex-col gap-4" aria-label="对话记录" aria-live="polite">
      {lines.map((l) => (
        <TranscriptLine key={l.ref} line={l} />
      ))}
      {children}
    </ol>
  );
}
