// 预售页(方案 5.2 W6–W7、7.3):商品卡片和购买方式,站内不收款,买到兑换码后去 /redeem 兑换。
import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { PresaleClient } from "@/components/presale/PresaleClient";

export const metadata: Metadata = { title: "预售" };

export default function PresalePage() {
  return (
    <>
      <SiteHeader />
      <PresaleClient />
    </>
  );
}
