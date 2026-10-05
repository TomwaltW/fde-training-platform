"use client";
// 分享卡:canvas 画好后转成带隐式标识的 PNG,页面上显示成图片(微信里可长按保存),另给"保存图片"和"复制分享文字"两个按钮。
// 第三轮:保存图片、复制文字成功时各记一条事件(方案 6.3 第二关"主动分享复盘卡的比例")。
import { useEffect, useRef, useState } from "react";
import type { PublicReport } from "@fde/contracts";
import { track } from "@/lib/client/api";
import { cx } from "@/lib/client/format";
import { CARD_HEIGHT, CARD_WIDTH, copyText, drawShareCard, shareCardBlob, shareText } from "@/lib/client/share-card";
import { alert, btn, field } from "@/lib/client/ui";

export function ShareCard({ card, sessionId }: { card: PublicReport["shareCard"]; sessionId?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copy, setCopy] = useState<{ status: "idle" | "copied" } | { status: "failed"; text: string }>({ status: "idle" });
  const key = JSON.stringify(card);
  const extra = sessionId ? { sessionId } : {};

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

  async function copyShareText() {
    const text = shareText(card, window.location.origin);
    if (await copyText(text)) {
      setCopy({ status: "copied" });
      track("share_text_copied", extra);
    } else {
      // 复制不了(内置浏览器不让写剪贴板等):把文字摆出来让人手动复制
      setCopy({ status: "failed", text });
    }
  }

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
          <a href={url} download="FDE训练场-复盘分享卡.png" className={btn.primary} onClick={() => track("share_card_saved", extra)}>
            保存图片
          </a>
        )}
        <button type="button" className={btn.secondary} onClick={() => void copyShareText()}>
          复制分享文字
        </button>
      </div>
      {copy.status === "copied" && (
        <p role="status" className="text-sm text-ok">
          已复制,可以粘贴到朋友圈或群聊。
        </p>
      )}
      {copy.status === "failed" && (
        <div className="w-full max-w-md" data-testid="share-text-manual">
          <p role="status" className={alert.warn}>
            这个浏览器不让自动复制,请长按或选中下面的文字手动复制。
          </p>
          <textarea
            className={cx(field.textarea, "text-[15px]")}
            rows={6}
            readOnly
            value={copy.text}
            aria-label="分享文字"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
      <p className="text-center text-[13px] text-ink-3">只有总分、标记和一句评语,不含剧情答案。微信里可以长按图片保存。</p>
    </div>
  );
}
