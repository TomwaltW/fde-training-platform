"use client";
// 预售页:商品卡片、去第三方平台购买(新标签页)或购买说明、去兑换。
// 方案 7.3:站内只做兑换码核销,不放支付按钮——这里没有任何收款入口。
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Product, ProductsResponse } from "@fde/contracts";
import { Markdown } from "@/components/Markdown";
import { api, failureMessage, track } from "@/lib/client/api";
import { cx } from "@/lib/client/format";
import { alert, btn, card, pageWrap } from "@/lib/client/ui";
import { IncludesList, listsScenarios, useScenarioTitles } from "./Includes";

export function PresaleClient() {
  const [data, setData] = useState<ProductsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    track("presale_viewed");
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .products()
      .then((r) => alive && setData(r))
      .catch((e: unknown) => alive && setError(failureMessage(e)));
    return () => {
      alive = false;
    };
  }, []);

  const titles = useScenarioTitles(data ? listsScenarios(data.products) : false);

  return (
    <main className={cx(pageWrap, "flex flex-col gap-6")}>
      <div>
        <h1 className="text-2xl font-bold">预售</h1>
        <p className="mt-2 text-[15px] leading-7 text-ink-2">买了之后会拿到一个兑换码,在本站兑换后马上生效,用登录的账号就能玩。</p>
      </div>

      <p className={alert.info} data-testid="no-payment-note">
        本站不收款,也没有支付按钮。购买在第三方平台完成(或者按商品下面的说明联系作者),拿到兑换码后回到这里兑换。
      </p>

      {error && <p className={alert.error}>商品加载失败:{error}</p>}
      {!data && !error && <div className={cx(card, "h-56 animate-pulse")} aria-label="加载中" />}

      {data && data.products.length === 0 && (
        <section className={cx(card, "p-5 sm:p-7")} data-testid="presale-closed" aria-labelledby="closed-title">
          <h2 id="closed-title" className="text-lg font-semibold">
            预售还没开始
          </h2>
          <p className="mt-2 text-[15px] leading-7 text-ink-2">想第一时间知道,可以先加入候补名单。</p>
          <Link href="/waitlist" className={cx(btn.primary, "mt-4 w-full sm:w-auto sm:px-8")}>
            加入候补名单
          </Link>
        </section>
      )}

      {data && data.products.length > 0 && (
        <ul className="flex flex-col gap-4" aria-label="商品">
          {data.products.map((p) => (
            <ProductCard key={p.id} product={p} titles={titles} />
          ))}
        </ul>
      )}

      <p className="text-[15px] text-ink-2">
        已经有兑换码?
        <Link href="/redeem" className="inline-flex min-h-11 items-center px-1 font-medium text-accent hover:underline">
          去兑换
        </Link>
      </p>
    </main>
  );
}

function ProductCard({ product: p, titles }: { product: Product; titles: Record<string, string> }) {
  return (
    <li className={cx(card, "flex flex-col gap-4 p-5 sm:p-7")} data-testid="product-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xl font-bold leading-snug">{p.name}</h2>
        <p className="text-lg font-semibold text-accent" data-testid="product-price">
          {p.priceText}
        </p>
      </div>
      {p.description.trim() && <Markdown source={p.description} />}
      <IncludesList includes={p.includes} titles={titles} />
      {p.includes.humanReview && <p className="text-sm text-ink-3">真人复盘:兑换后在「我的对局」里看预约方式。</p>}
      {p.buyUrl && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <a href={p.buyUrl} target="_blank" rel="noopener noreferrer" className={cx(btn.primary, "w-full sm:w-auto sm:px-8")} data-testid="buy-link">
            去购买
          </a>
          <span className="text-sm text-ink-3">在新标签页打开第三方平台,本站不经手付款。</span>
        </div>
      )}
      {p.buyNote && (
        <div className="rounded-lg bg-surface-2 px-4 py-3 text-[15px] leading-7" data-testid="buy-note">
          {!p.buyUrl && <p className="text-sm font-medium text-ink-2">怎么买</p>}
          <p>{p.buyNote}</p>
        </div>
      )}
    </li>
  );
}
