// 共用的 Tailwind 类名。写成完整的字面量,Tailwind 才扫描得到。

const base =
  "inline-flex min-h-11 select-none items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-medium leading-tight transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

export const btn = {
  primary: `${base} bg-accent text-accent-ink hover:bg-accent/90`,
  secondary: `${base} border border-line bg-surface text-ink hover:bg-surface-2`,
  ghost: `${base} text-ink-2 hover:bg-surface-2 hover:text-ink`,
  danger: `${base} border border-danger/40 bg-surface text-danger hover:bg-danger-soft`,
  small: "inline-flex min-h-11 items-center justify-center gap-1 rounded-lg px-3 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
};

export const field = {
  label: "block text-sm font-medium text-ink",
  hint: "mt-1 text-[13px] leading-relaxed text-ink-3",
  input:
    "mt-1.5 block min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-3 focus:border-accent focus:outline-2 focus:outline-accent/30",
  textarea:
    "mt-1.5 block w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-base leading-relaxed text-ink placeholder:text-ink-3 focus:border-accent focus:outline-2 focus:outline-accent/30",
};

export const card = "rounded-xl border border-line bg-surface";

export const alert = {
  info: "rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-sm leading-relaxed text-ink",
  warn: "rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm leading-relaxed text-ink",
  error: "rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm leading-relaxed text-ink",
  ok: "rounded-lg border border-ok/40 bg-ok-soft px-3 py-2 text-sm leading-relaxed text-ink",
};

export const pageWrap = "mx-auto w-full max-w-3xl px-4 py-6 sm:py-10";
