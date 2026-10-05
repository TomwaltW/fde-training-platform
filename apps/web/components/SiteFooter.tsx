"use client";
// 页脚(所有页面):AI 生成标识、模型公示、用户协议、隐私政策、备案号。方案 5.3 草图与 8.2 合规清单。
import Link from "next/link";
import { useSite } from "@/lib/client/hooks";

export function SiteFooter() {
  const { site } = useSite();
  return (
    <footer data-testid="site-footer" className="border-t border-line bg-surface-2/60 px-4 py-6 text-[13px] leading-relaxed text-ink-2">
      <div className="mx-auto flex max-w-5xl flex-col gap-2">
        <p data-testid="footer-ai-notice" className="font-medium text-ink">
          {site.aiNotice}
          <span className="font-normal text-ink-2">;人物、公司、数据均为虚构,仅供训练</span>
        </p>
        <p data-testid="footer-model">{site.modelDisclosure ? `所用模型:${site.modelDisclosure}` : "模型备案信息:待填写"}</p>
        <nav aria-label="协议与说明" className="-mx-2 flex flex-wrap items-center">
          <Link href="/legal/terms" className="inline-flex min-h-11 items-center px-2 underline-offset-4 hover:text-ink hover:underline">
            用户协议
          </Link>
          <Link href="/legal/privacy" className="inline-flex min-h-11 items-center px-2 underline-offset-4 hover:text-ink hover:underline">
            隐私政策
          </Link>
          <Link href="/legal/ai-notice" className="inline-flex min-h-11 items-center px-2 underline-offset-4 hover:text-ink hover:underline">
            AI 生成内容说明
          </Link>
        </nav>
        <p data-testid="footer-icp" className="flex flex-wrap gap-x-4">
          {site.icpNumber ? (
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="hover:text-ink hover:underline">
              备案号:{site.icpNumber}
            </a>
          ) : (
            <span>备案号:待填写</span>
          )}
          {site.publicSecurityNumber && <span>公安联网备案号:{site.publicSecurityNumber}</span>}
        </p>
      </div>
    </footer>
  );
}
