import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { btn } from "@/lib/client/ui";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <h1 className="text-2xl font-bold">没有这个页面</h1>
        <p className="text-ink-2">链接可能写错了,或者页面已经不在了。</p>
        <Link href="/" className={btn.primary}>
          回到首页
        </Link>
      </main>
    </>
  );
}
