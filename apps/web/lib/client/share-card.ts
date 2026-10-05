// 分享卡:用 canvas 画成图片,只用 report.shareCard(总分、标记、一句评语),不含任何真相。
// 方案 8.2 第 3 条:图上印显式标识"内容由 AI 生成",PNG 元数据里再写一条隐式标识。
import type { PublicReport } from "@fde/contracts";

type ShareCard = PublicReport["shareCard"];

export const CARD_WIDTH = 900;
export const CARD_HEIGHT = 1200;
const FONT = `system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "WenQuanYi Zen Hei", sans-serif`;
export const AIGC_MARK = "内容由 AI 生成";

/** 按像素宽度折行;中文逐字断,英文单词尽量不拆。 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const tokens = text.match(/[A-Za-z0-9.%+\-]+|\s+|./gu) ?? [];
  const lines: string[] = [];
  let line = "";
  for (const t of tokens) {
    const next = line + t;
    if (ctx.measureText(next).width > maxWidth && line.trim()) {
      lines.push(line.trimEnd());
      line = t.trimStart();
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line.trim()) lines.push(line.trim());
  if (lines.length === maxLines && tokens.join("").length > lines.join("").length + 1) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawShareCard(canvas: HTMLCanvasElement, card: ShareCard): void {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = CARD_WIDTH;
  const H = CARD_HEIGHT;
  const pad = 72;

  // 底色:深蓝到墨绿的斜向渐变,右上角一块浅色光斑
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#14304a");
  bg.addColorStop(1, "#0f2a2a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W - 120, 140, 10, W - 120, 140, 420);
  glow.addColorStop(0, "rgba(106,169,216,0.35)");
  glow.addColorStop(1, "rgba(106,169,216,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText("FDE 训练场 · 客户现场复盘", pad, pad + 30);

  // 场景名(最多两行)
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 60px ${FONT}`;
  let y = 236;
  const titleLines = wrap(ctx, card.title, W - pad * 2, 2);
  titleLines.forEach((l, i) => ctx.fillText(l, pad, y + i * 78));
  y += (titleLines.length - 1) * 78;

  // 总分:数字很大,和标题之间留足距离
  y += 320;
  ctx.font = `700 280px ${FONT}`;
  const total = String(Math.round(card.total));
  ctx.fillText(total, pad - 10, y);
  const tw = ctx.measureText(total).width;
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = `500 52px ${FONT}`;
  ctx.fillText("/ 100", pad + tw + 12, y);

  // 一句评语
  y += 120;
  ctx.fillStyle = "#e9f2f9";
  ctx.font = `600 52px ${FONT}`;
  for (const l of wrap(ctx, card.line, W - pad * 2, 3)) {
    ctx.fillText(l, pad, y);
    y += 70;
  }

  // 标记
  y += 40;
  ctx.font = `500 32px ${FONT}`;
  let x = pad;
  for (const b of card.badges.slice(0, 6)) {
    const w = ctx.measureText(b).width + 44;
    if (x + w > W - pad) {
      x = pad;
      y += 72;
    }
    if (y > H - 230) break;
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    roundRect(ctx, x, y - 42, w, 58, 29);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(b, x + 22, y);
    x += w + 16;
  }

  // 底部:定位语 + 显式 AI 标识
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, H - 190);
  ctx.lineTo(W - pad, H - 190);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `500 34px ${FONT}`;
  ctx.fillText("可以翻车的客户现场", pad, H - 125);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText(`${AIGC_MARK} · 不含剧情答案`, pad, H - 80);
}

// ---------------------------------------------------------------- PNG 隐式标识

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 在 IEND 之前插入一个 iTXt 块(UTF-8 文本):keyword\0 0 0 \0 \0 text。 */
export function withPngText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  const te = new TextEncoder();
  const kw = te.encode(keyword);
  const tx = te.encode(text);
  const data = new Uint8Array(kw.length + 5 + tx.length);
  data.set(kw, 0);
  // kw 后依次是:\0、压缩标志 0、压缩方法 0、语言标签(空)\0、翻译关键字(空)\0
  data.set([0, 0, 0, 0, 0], kw.length);
  data.set(tx, kw.length + 5);
  const type = te.encode("iTXt");
  const typed = new Uint8Array(4 + data.length);
  typed.set(type, 0);
  typed.set(data, 4);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typed, 4);
  view.setUint32(8 + data.length, crc32(typed));
  // 最后 12 字节是 IEND
  const iend = png.length - 12;
  if (iend < 8) return png;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, iend), 0);
  out.set(chunk, iend);
  out.set(png.subarray(iend), iend + chunk.length);
  return out;
}

/** 画好的 canvas → 带隐式标识的 PNG Blob。 */
export async function shareCardBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const marked = withPngText(bytes, "AIGC", `${AIGC_MARK};FDE 训练场复盘分享卡`);
  return new Blob([marked.buffer as ArrayBuffer], { type: "image/png" });
}
