"use client";
// 管理页的门:没登录去登录,不是管理员显示无权限。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { loginHref } from "@/lib/client/api";
import { cx } from "@/lib/client/format";
import { useMe } from "@/lib/client/hooks";
import { alert, btn } from "@/lib/client/ui";

export const adminWrap = "mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:py-10";

export function AdminGate({ next, children }: { next: string; children: ReactNode }) {
  const router = useRouter();
  const [me] = useMe();
  useEffect(() => {
    if (me.status === "anon") router.replace(loginHref(next));
  }, [me.status, router, next]);

  if (me.status === "loading" || me.status === "anon") return <main className={cx(adminWrap, "text-ink-3")}>加载中…</main>;
  if (me.status === "error") return <main className={adminWrap}><p className={alert.error}>{me.message}</p></main>;
  if (!me.user.isAdmin)
    return (
      <main className={adminWrap} data-testid="admin-forbidden">
        <h1 className="text-2xl font-bold">没有权限</h1>
        <p className="text-ink-2">管理页只对管理员开放。</p>
        <Link href="/" className={cx(btn.secondary, "self-start")}>
          回到首页
        </Link>
      </main>
    );
  return <>{children}</>;
}
