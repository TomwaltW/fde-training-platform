// 候补名单(方案 5.2 W0「候补表单」):可以单独分享的登记页,链接里的 ?from= 记为来源。
import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { WaitlistPageClient } from "@/components/waitlist/WaitlistPageClient";

export const metadata: Metadata = {
  title: "候补名单",
  description: "FDE 训练场目前内测,第一次登录需要邀请码。留下邮箱,开放时第一时间通知你。",
};

export default function WaitlistPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-xl px-4 py-8 sm:py-14">
        <WaitlistPageClient />
      </main>
    </>
  );
}
