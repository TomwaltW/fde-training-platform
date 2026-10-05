"use client";
// 我的对局页:已兑换的商品、今天的开局限额、真人复盘预约方式,以及"输入兑换码"入口(第三轮 F3)。
import Link from "next/link";
import { useEffect, useState } from "react";
import type { EntitlementsResponse } from "@fde/contracts";
import { Markdown } from "@/components/Markdown";
import { IncludesList, listsScenarios, useScenarioTitles } from "@/components/presale/Includes";
import { api, failureMessage } from "@/lib/client/api";
import { cx, formatDateTime } from "@/lib/client/format";
import { useSite } from "@/lib/client/hooks";
import { alert, btn, card } from "@/lib/client/ui";

export function EntitlementsCard() {
  const { site } = useSite();
  const [data, setData] = useState<EntitlementsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .entitlements()
      .then((r) => alive && setData(r))
      .catch((e: unknown) => alive && setError(failureMessage(e)));
    return () => {
      alive = false;
    };
  }, []);

  const titles = useScenarioTitles(data ? listsScenarios(data.entitlements) : false);

  return (
    <section aria-labelledby="ent-title" className={cx(card, "p-5")} data-testid="entitlements">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ent-title" className="text-lg font-semibold">
          我的权益
        </h2>
        <Link href="/redeem" className={btn.secondary}>
          输入兑换码
        </Link>
      </div>
      {error && <p className={cx(alert.error, "mt-3")}>{error}</p>}
      {!data && !error && <p className="mt-3 text-ink-3">加载中…</p>}
      {data && (
        <>
          <p className="mt-3 text-[15px]" data-testid="daily-limit">
            今天最多能开 <span className="font-semibold">{data.dailySessionLimit}</span> 局(北京时间零点重新计数)。
          </p>
          {data.entitlements.length === 0 ? (
            <p className="mt-2 text-[15px] leading-7 text-ink-2">
              还没有兑换过商品。
              {site.presaleOpen && (
                <Link href="/presale" className="inline-flex min-h-11 items-center px-1 font-medium text-accent hover:underline">
                  看看预售
                </Link>
              )}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line border-t border-line" data-testid="entitlement-list">
              {data.entitlements.map((e) => (
                <li key={e.code} className="py-3">
                  <p className="font-medium leading-6">{e.productName}</p>
                  <p className="text-sm text-ink-3">
                    兑换码 <span className="font-mono">{e.code}</span> · {formatDateTime(e.redeemedAt)} 兑换
                  </p>
                  <IncludesList includes={e.includes} titles={titles} empty="这个商品已经下架,不再附带权益。" className="mt-2" />
                </li>
              ))}
            </ul>
          )}
          {data.humanReview && (
            <div className="mt-4 rounded-lg bg-surface-2 p-4" data-testid="human-review">
              <h3 className="font-semibold">真人复盘怎么预约</h3>
              {data.humanReviewHowTo ? (
                <Markdown source={data.humanReviewHowTo} className="mt-2" testId="human-review-how-to" />
              ) : (
                <p className="mt-2 text-[15px] text-ink-2">预约方式还没公布,请过几天再来看。</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
