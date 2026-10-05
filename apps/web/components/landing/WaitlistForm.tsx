"use client";
// 候补名单表单(第三轮 F1):没有邀请码的人在落地页直接留下邮箱。只给没登录的人看(登录了说明已经有资格)。
// 来源取落地页链接里的 ?from=;完整的登记页(多一句"想用它做什么")在 /waitlist,可以单独分享。
import { useMe } from "@/lib/client/hooks";
import { cx } from "@/lib/client/format";
import { card } from "@/lib/client/ui";
import { WaitlistSignup } from "@/components/waitlist/WaitlistSignup";

export function WaitlistForm() {
  const [me] = useMe();
  if (me.status !== "anon") return null;
  return (
    <section className={cx(card, "p-5 sm:p-7")} aria-labelledby="waitlist-card-title" data-testid="waitlist-card">
      <h2 id="waitlist-card-title" className="text-lg font-semibold leading-snug">
        没有邀请码?留下邮箱,开放时第一时间通知你
      </h2>
      <p className="mt-1.5 mb-4 text-[15px] leading-7 text-ink-2">目前内测,分批开放时按登记先后发邀请码。</p>
      <WaitlistSignup compact />
    </section>
  );
}
