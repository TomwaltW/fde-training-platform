import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { LoginClient } from "@/components/login/LoginClient";

export const metadata: Metadata = { title: "登录" };

export default function LoginPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-md px-4 py-8 sm:py-14">
        {/* useSearchParams 需要 Suspense 边界 */}
        <Suspense fallback={<p className="text-ink-3">加载中…</p>}>
          <LoginClient />
        </Suspense>
      </main>
    </>
  );
}
