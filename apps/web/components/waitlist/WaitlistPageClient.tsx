"use client";
// /waitlist 页的动态部分:打开时记 waitlist_viewed(带上链接里的 ?from= 来源),下面是登记表单。
import Link from "next/link";
import { useEffect } from "react";
import { track } from "@/lib/client/api";
import { cx } from "@/lib/client/format";
import { card } from "@/lib/client/ui";
import { WaitlistSignup } from "./WaitlistSignup";
import { sourceFromLocation } from "./roles";

export function WaitlistPageClient() {
  useEffect(() => {
    const from = sourceFromLocation();
    track("waitlist_viewed", from ? { props: { from } } : {});
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm font-medium text-accent">FDE 训练场 · 候补名单</p>
        <h1 className="mt-2 text-2xl font-bold leading-snug sm:text-3xl">没有邀请码?先登记</h1>
        <p className="mt-3 text-[15px] leading-7 text-ink-2">
          目前内测,第一次登录需要邀请码。留下邮箱,分批开放时按登记先后把邀请码发到你的邮箱。
        </p>
        <p className="mt-2 text-[15px] leading-7 text-ink-3">
          这是一个可以翻车的客户现场:AI 扮演的老板、主管、一线和财务各说各的,你去问、去要数据、去做判断,最后拿到一份逐轮指出问题的复盘。
          <Link href="/" className="ml-1 text-accent underline underline-offset-4">
            看看场景
          </Link>
        </p>
      </div>
      <div className={cx(card, "p-5 sm:p-6")}>
        <WaitlistSignup />
      </div>
    </div>
  );
}
