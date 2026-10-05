"use client";
// 页面渲染出错时的兜底(不展示堆栈)。
import Link from "next/link";
import { btn } from "@/lib/client/ui";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <h1 className="text-2xl font-bold">页面出错了</h1>
      <p className="text-ink-2">可以重试一次;还不行的话回到首页,进度已经自动保存。</p>
      <div className="flex gap-2">
        <button type="button" className={btn.primary} onClick={reset}>
          重试
        </button>
        <Link href="/" className={btn.secondary}>
          回到首页
        </Link>
      </div>
    </main>
  );
}
