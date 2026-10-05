"use client";
// 资料查看器:图片缩略图(点开全屏、左右翻、可放大到原图),pdf 新标签页打开,xlsx 下载。
import { useEffect, useRef, useState } from "react";
import type { PublicArtifact } from "@fde/contracts";
import { Modal, trapTab } from "@/components/Modal";
import { artifactFileUrl } from "@/lib/client/api";
import { cx, formatBytes } from "@/lib/client/format";
import { btn } from "@/lib/client/ui";

type File = PublicArtifact["files"][number];

const KIND_LABEL: Record<File["kind"], string> = { image: "图片", pdf: "PDF", xlsx: "Excel 表格", other: "文件" };

export function ArtifactViewer({
  sessionId,
  state,
  onClose,
}: {
  sessionId: string;
  state: { loading: string } | { artifact: PublicArtifact };
  onClose: () => void;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const artifact = "artifact" in state ? state.artifact : null;
  const title = "artifact" in state ? state.artifact.title : state.loading;
  const images = artifact?.files.filter((f) => f.kind === "image") ?? [];
  const docs = artifact?.files.filter((f) => f.kind !== "image") ?? [];
  const url = (f: File) => (artifact ? artifactFileUrl(sessionId, artifact.id, f.name) : "");

  return (
    <>
      <Modal open title={title} onClose={onClose} full size="lg" testId="artifact-viewer">
        {!artifact ? (
          <p className="py-10 text-center text-ink-3">正在打开…</p>
        ) : (
          <div className="flex flex-col gap-6">
            {images.length > 0 && (
              <section aria-label="图片">
                <h3 className="mb-2 text-sm font-semibold text-ink-2">图片({images.length})· 点开全屏看</h3>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {images.map((f, i) => (
                    <li key={f.name}>
                      <button
                        type="button"
                        onClick={() => setIndex(i)}
                        className="block w-full overflow-hidden rounded-lg border border-line bg-surface text-left hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
                        aria-label={`查看图片 ${f.name}`}
                      >
                        <img src={url(f)} alt="" loading="lazy" className="aspect-[3/4] w-full bg-surface-2 object-cover" />
                        <span className="block truncate px-2 py-1.5 text-xs text-ink-2">{f.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {docs.length > 0 && (
              <section aria-label="文件">
                <h3 className="mb-1 text-sm font-semibold text-ink-2">文件({docs.length})</h3>
                <ul className="divide-y divide-line">
                  {docs.map((f) => (
                    <li key={f.name} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0">
                        <span className="block break-all text-[15px] font-medium leading-6">{f.name}</span>
                        <span className="text-xs text-ink-3">
                          {KIND_LABEL[f.kind]} · {formatBytes(f.bytes)}
                        </span>
                      </span>
                      {f.kind === "pdf" ? (
                        <a href={url(f)} target="_blank" rel="noopener noreferrer" className={cx(btn.secondary, "shrink-0 px-3 text-sm")}>
                          新标签页打开
                        </a>
                      ) : (
                        <a href={url(f)} download={f.name} className={cx(btn.secondary, "shrink-0 px-3 text-sm")}>
                          下载
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {artifact.files.length === 0 && <p className="py-6 text-center text-ink-3">这份资料暂时没有文件。</p>}
            <p className="text-xs text-ink-3">资料均为合成样本,仅供训练。</p>
          </div>
        )}
      </Modal>
      {index !== null && images.length > 0 && (
        <Lightbox
          images={images.map((f) => ({ name: f.name, src: url(f) }))}
          index={Math.min(index, images.length - 1)}
          onIndex={setIndex}
          onClose={() => setIndex(null)}
        />
      )}
    </>
  );
}

/** 全屏看图:左右按钮、键盘方向键、手指左右滑都能翻页;"看原图"切到原始尺寸可拖动查看细节。 */
function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: { name: string; src: string }[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(false);
  const startX = useRef<number | null>(null);
  const n = images.length;
  const cur = images[index]!;
  const go = (d: number) => {
    setZoom(false);
    onIndex((index + d + n) % n);
  };
  const goRef = useRef(go);
  const closeRef = useRef(onClose);
  useEffect(() => {
    goRef.current = go;
    closeRef.current = onClose;
  });

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 捕获阶段处理,Esc 只关看图层,不连带关掉下面的资料对话框;Tab 只在看图层里循环
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab") {
        e.stopPropagation();
        trapTab(e, root.current);
      } else if (e.key === "ArrowLeft") goRef.current(-1);
      else if (e.key === "ArrowRight") goRef.current(1);
    };
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.addEventListener("keydown", onKey, true);
    root.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="查看图片"
      data-testid="lightbox"
    >
      <div className="flex items-center gap-2 px-2 pt-[env(safe-area-inset-top)]">
        <span className="px-2 text-sm tabular-nums" data-testid="lightbox-counter">
          {index + 1} / {n}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-white/70">{cur.name}</span>
        <button type="button" onClick={() => setZoom((z) => !z)} className="min-h-11 rounded-lg px-3 text-sm hover:bg-white/10">
          {zoom ? "适应屏幕" : "看原图"}
        </button>
        <button type="button" onClick={onClose} className="grid size-11 place-items-center rounded-lg hover:bg-white/10" aria-label="关闭图片">
          <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div
        className={cx("relative min-h-0 flex-1", zoom ? "overflow-auto" : "flex items-center justify-center overflow-hidden")}
        onPointerDown={(e) => {
          if (!zoom) startX.current = e.clientX;
        }}
        onPointerUp={(e) => {
          if (zoom || startX.current === null) return;
          const dx = e.clientX - startX.current;
          startX.current = null;
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        }}
        style={{ touchAction: zoom ? "auto" : "pan-y" }}
      >
        <img
          key={cur.src}
          src={cur.src}
          alt={cur.name}
          draggable={false}
          className={zoom ? "max-w-none" : "max-h-full max-w-full object-contain"}
        />
      </div>
      {n > 1 && (
        <div className="flex items-center justify-between gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
          <button type="button" onClick={() => go(-1)} className="min-h-11 min-w-24 rounded-lg bg-white/10 px-4 hover:bg-white/20" aria-label="上一张">
            ‹ 上一张
          </button>
          <button type="button" onClick={() => go(1)} className="min-h-11 min-w-24 rounded-lg bg-white/10 px-4 hover:bg-white/20" aria-label="下一张">
            下一张 ›
          </button>
        </div>
      )}
    </div>
  );
}
