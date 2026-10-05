"use client";
// 分享卡:canvas 画好后转成带隐式标识的 PNG,页面上显示成图片(微信里可长按保存),另给一个"保存图片"按钮。
import { useEffect, useRef, useState } from "react";
import type { PublicReport } from "@fde/contracts";
import { CARD_HEIGHT, CARD_WIDTH, drawShareCard, shareCardBlob } from "@/lib/client/share-card";
import { btn } from "@/lib/client/ui";

export function ShareCard({ card }: { card: PublicReport["shareCard"] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const key = JSON.stringify(card);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    const c = canvas.current;
    if (!c) return;
    try {
      drawShareCard(c, card);
    } catch {
      setFailed(true);
      return;
    }
    shareCardBlob(c)
      .then((blob) => {
        if (!alive) return;
        if (!blob) {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // 用序列化后的 key 做依赖:card 内容变了才重画
  }, [key]);

  return (
    <div data-testid="share-card" className="flex flex-col items-center gap-3">
      <canvas ref={canvas} width={CARD_WIDTH} height={CARD_HEIGHT} className="hidden" aria-hidden />
      {url ? (
        <img src={url} alt={`分享卡:${card.title},${card.total} 分,${card.line}`} className="w-full max-w-[320px] rounded-xl border border-line shadow-sm" />
      ) : (
        <div className="grid aspect-[3/4] w-full max-w-[320px] place-items-center rounded-xl border border-line bg-surface-2 text-sm text-ink-3">
          {failed ? "这个浏览器画不出分享卡" : "正在生成分享卡…"}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {url && (
          <a href={url} download="FDE训练场-复盘分享卡.png" className={btn.primary}>
            保存图片
          </a>
        )}
      </div>
      <p className="text-center text-[13px] text-ink-3">只有总分、标记和一句评语,不含剧情答案。微信里可以长按图片保存。</p>
    </div>
  );
}
