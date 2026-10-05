// 协议与说明:服务端读 content/legal/<slug>.md(T4 起草),用 marked 渲染。文件不在时显示"正在起草"。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";

const DOCS: Record<string, string> = {
  terms: "用户协议",
  privacy: "隐私政策",
  "ai-notice": "AI 生成内容说明",
};

function titleOf(slug: string): string | null {
  return Object.hasOwn(DOCS, slug) ? (DOCS[slug] ?? null) : null;
}

async function readDoc(slug: string): Promise<string | null> {
  try {
    return await readFile(join(process.cwd(), "content", "legal", `${slug}.md`), "utf8");
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: titleOf(slug) ?? "文档" };
}

export default async function LegalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const title = titleOf(slug);
  if (!title) notFound();
  const source = await readDoc(slug);
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
        {source?.trim() ? (
          <Markdown source={source} testId="legal-doc" />
        ) : (
          <div data-testid="legal-doc">
            <h1 className="text-2xl font-bold">{title}</h1>
            <p className="mt-4 text-ink-2">该文档正在起草。</p>
          </div>
        )}
      </main>
    </>
  );
}
