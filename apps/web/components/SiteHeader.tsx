"use client";
// 普通页面的顶栏(对局页有自己的顶栏)。右侧按登录状态显示"登录"或"我的对局"。
import Link from "next/link";
import { useMe, useSite } from "@/lib/client/hooks";

export function Brand() {
  return (
    <Link href="/" aria-label="FDE 训练场,回到首页" className="inline-flex min-h-11 items-center gap-2 font-semibold tracking-wide text-ink">
      <span aria-hidden className="grid h-7 place-items-center rounded-md bg-accent px-1.5 text-[12px] font-bold tracking-normal text-accent-ink">
        FDE
      </span>
      <span>训练场</span>
    </Link>
  );
}

export function SiteHeader() {
  const [me] = useMe();
  const { site } = useSite();
  return (
    <header className="border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
        <Brand />
        <nav aria-label="主导航" className="flex items-center gap-1 text-[15px]">
          {site.presaleOpen && (
            <Link href="/presale" className="inline-flex min-h-11 items-center rounded-lg px-3 text-ink-2 hover:bg-surface-2 hover:text-ink">
              预售
            </Link>
          )}
          {me.status === "ok" ? (
            <>
              {me.user.isAdmin && (
                <Link href="/admin" className="inline-flex min-h-11 items-center rounded-lg px-3 text-ink-2 hover:bg-surface-2 hover:text-ink">
                  管理
                </Link>
              )}
              <Link href="/me" className="inline-flex min-h-11 items-center rounded-lg px-3 text-ink-2 hover:bg-surface-2 hover:text-ink">
                我的对局
              </Link>
            </>
          ) : me.status === "anon" ? (
            <Link href="/login" className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-accent hover:bg-accent-soft">
              登录
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
