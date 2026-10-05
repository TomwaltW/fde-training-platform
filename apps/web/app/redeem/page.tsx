// 兑换页:输入兑换码(?code= 预填)。没登录先去登录,登录并同意协议后回到这里。
import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { RedeemClient } from "@/components/redeem/RedeemClient";
import { pageWrap } from "@/lib/client/ui";

export const metadata: Metadata = { title: "兑换" };

export default function RedeemPage() {
  return (
    <>
      <SiteHeader />
      {/* useSearchParams 需要 Suspense 边界 */}
      <Suspense fallback={<main className={`${pageWrap} text-ink-3`}>加载中…</main>}>
        <RedeemClient />
      </Suspense>
    </>
  );
}
