"use client";
// 商品包含什么(场景、每天多开几局、真人复盘)。预售页、兑换页、我的权益共用。
import { useEffect, useState } from "react";
import type { ProductIncludes } from "@fde/contracts";
import { api } from "@/lib/client/api";
import { cx } from "@/lib/client/format";

/** 场景 id → 标题。只有某个商品列了具体场景时才请求(needed 为 true);请求失败就直接显示 id。 */
export function useScenarioTitles(needed: boolean): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!needed) return;
    let alive = true;
    api
      .scenarios()
      .then((r) => alive && setTitles(Object.fromEntries(r.scenarios.map((s) => [s.id, s.title]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [needed]);
  return titles;
}

/** 有没有哪个商品列了具体场景(决定要不要取场景标题)。 */
export function listsScenarios(items: { includes: ProductIncludes }[]): boolean {
  return items.some((i) => Array.isArray(i.includes.scenarios) && i.includes.scenarios.length > 0);
}

export function includesLines(inc: ProductIncludes, titles: Record<string, string>): string[] {
  const lines: string[] = [];
  if (inc.scenarios === "all") lines.push("全部场景");
  else if (inc.scenarios.length > 0) lines.push(`场景:${inc.scenarios.map((id) => titles[id] ?? id).join("、")}`);
  if (inc.extraDailySessions > 0) lines.push(`每天多开 ${inc.extraDailySessions} 局`);
  if (inc.humanReview) lines.push("一次真人复盘");
  return lines;
}

export function IncludesList({
  includes,
  titles,
  empty,
  className,
}: {
  includes: ProductIncludes;
  titles: Record<string, string>;
  /** 什么都不包含时显示的话;不给就什么都不显示。 */
  empty?: string;
  className?: string;
}) {
  const lines = includesLines(includes, titles);
  if (lines.length === 0) return empty ? <p className={cx("text-sm text-ink-3", className)}>{empty}</p> : null;
  return (
    <ul className={cx("flex flex-wrap gap-2", className)} aria-label="包含" data-testid="includes">
      {lines.map((l) => (
        <li key={l} className="rounded-full bg-accent-soft px-3 py-0.5 text-sm text-ink">
          {l}
        </li>
      ))}
    </ul>
  );
}
