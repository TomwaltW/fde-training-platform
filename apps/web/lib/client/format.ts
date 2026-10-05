// 展示用的格式化小工具(纯函数,服务端组件也能用)。
import type { PublicView } from "@fde/contracts";

/** 拼 className,忽略空值。 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** 352 → "5 小时 52 分";40 → "40 分钟";120 → "2 小时"。 */
export function formatMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} 分钟`;
  if (r === 0) return `${h} 小时`;
  return `${h} 小时 ${r} 分`;
}

const PHASE_LABEL: Record<PublicView["phase"], string> = {
  kickoff: "上午 · 初次见面",
  discovery: "上午 · 调研",
  judgment: "整理判断",
  report: "下午 · 汇报",
  debrief: "已收工",
};

export function phaseLabel(phase: PublicView["phase"]): string {
  return PHASE_LABEL[phase] ?? phase;
}

/** 分数最多一位小数:5.1、22、0。 */
export function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

export function formatYuan(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return "—";
  return `¥${n.toFixed(digits)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 104.8576)) / 10} MB`;
}

/** 路由参数解码;已经解码过或含有非法 % 时原样返回。 */
export function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 按北京时间显示:2026-10-05 16:31。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
