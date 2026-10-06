#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
degrade.py —— 照片/扫描件劣化(方案 4.1 步骤 6)与图片标识(方案 8.2)。

劣化只求「七成像」(方案 9.1 第 5 条:线索比逼真重要):
    photo  手机拍照:桌面背景、旋转 + 透视变形、纸张投影、不均匀光照、折痕、轻微模糊、噪点、JPEG 压缩
    scan   扫描/复印:去饱和、旋转、扫描仪边缘阴影、灰底与墨点、水印(COPY / 仅供报关使用)、模糊、JPEG 压缩

标识:
    显式  每张图片右下角一块不透明小牌「合成样本·训练用」(最后一步画,不参与劣化,保证可读)
    隐式  PNG 写文本块 AIGC=合成样本·训练用(tEXt + iTXt 各一份,读取方无论按哪种块都能拿到);
          JPEG 写 EXIF ImageDescription(UTF-8)与 JPEG 注释段

所有随机量来自按资料编号派生的 numpy 随机流,重复运行像素一致。
"""
from __future__ import annotations

import hashlib
import io
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, PngImagePlugin

FONT_PATH = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
LABEL = "合成样本·训练用"
SOFTWARE = "fde-docgen(合成样本)"
MAX_BYTES = 1_500_000          # 每张图片上限 1.5 MB
TARGET_BYTES = 1_400_000       # 留一点余量
SEED = 20260930


def rng_for(key: str) -> np.random.Generator:
    h = int(hashlib.sha256(f"{SEED}:degrade:{key}".encode()).hexdigest()[:16], 16)
    return np.random.default_rng(h)


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size)


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def perspective_coeffs(dst: list[tuple[float, float]], src: list[tuple[float, float]]) -> list[float]:
    """Pillow 的 PERSPECTIVE 变换把「输出坐标」映射回「输入坐标」:这里解 dst[i] → src[i] 的 8 个系数。"""
    a, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.append(v)
    return np.linalg.solve(np.array(a, dtype=np.float64), np.array(b, dtype=np.float64)).tolist()


def smooth_field(rng: np.random.Generator, size: tuple[int, int], grid: tuple[int, int]) -> np.ndarray:
    """低频随机场(0..1):在小网格上取随机数再双三次放大。"""
    g = (rng.random((grid[1], grid[0])) * 255).astype(np.uint8)
    im = Image.fromarray(g, "L").resize(size, Image.BICUBIC)
    return np.asarray(im, dtype=np.float32) / 255.0


def multiply(img: Image.Image, mask: np.ndarray) -> Image.Image:
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) * mask[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def add_noise(img: Image.Image, sigma: float, rng: np.random.Generator) -> Image.Image:
    if sigma <= 0:
        return img
    arr = np.asarray(img.convert("RGB"), dtype=np.float32)
    n = rng.normal(0.0, sigma, arr.shape[:2]).astype(np.float32)[..., None]
    return Image.fromarray(np.clip(arr + n, 0, 255).astype(np.uint8), "RGB")


# ---------------------------------------------------------------------------
# 纸面效果:折痕、水印、纸色
# ---------------------------------------------------------------------------
def paper_tint(img: Image.Image, rgb: tuple[int, int, int]) -> Image.Image:
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) * (np.array(rgb, dtype=np.float32) / 255.0)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def crease(img: Image.Image, spec: dict) -> Image.Image:
    """折痕:沿一条略斜的直线压暗一道细线,一侧带高光,两半亮度略有差别。
    spec = {"axis": "h"|"v", "at": 0..1, "slope": 小数, "depth": 0..1}"""
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    if spec["axis"] == "h":
        d = yy - (spec["at"] * h + spec.get("slope", 0.0) * (xx - w / 2))
    else:
        d = xx - (spec["at"] * w + spec.get("slope", 0.0) * (yy - h / 2))
    depth = spec.get("depth", 0.22)
    scale = w / 1600.0
    mask = (1.0 - depth * np.exp(-(d / (2.2 * scale)) ** 2)
            + 0.07 * np.exp(-((d - 6 * scale) / (5 * scale)) ** 2)
            - 0.035 * (d < 0))
    return multiply(img, mask.astype(np.float32))


def watermark(img: Image.Image, text: str, color: tuple[int, int, int], alpha: int, angle: float,
              size_ratio: float, tiled: bool) -> Image.Image:
    """斜向水印。tiled=True 时满版平铺(仅供报关使用),否则居中一枚大字(COPY)。"""
    w, h = img.size
    size = int(w * size_ratio)
    f = font(size)
    layer = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    bbox = d.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if tiled:
        step_x, step_y = int(tw * 1.6), int(th * 4.2)
        for row, y in enumerate(range(0, h * 2, step_y)):
            off = (row % 2) * step_x // 2
            for x in range(-step_x, w * 2, step_x):
                d.text((x + off, y), text, font=f, fill=color + (alpha,))
    else:
        cx, cy = w, h
        d.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text, font=f, fill=color + (alpha,),
               stroke_width=max(2, size // 30), stroke_fill=color + (alpha,))
    layer = layer.rotate(angle, resample=Image.BICUBIC, center=(w, h))
    layer = layer.crop((w // 2, h // 2, w // 2 + w, h // 2 + h))
    base = img.convert("RGBA")
    base.alpha_composite(layer)
    return base.convert("RGB")


# ---------------------------------------------------------------------------
# 背景:木纹桌面、浅色办公桌、水泥地
# ---------------------------------------------------------------------------
def background(kind: str, size: tuple[int, int], rng: np.random.Generator) -> Image.Image:
    w, h = size
    low = smooth_field(rng, size, (6, 8))
    if kind == "wood":
        warp = smooth_field(rng, size, (5, 40)) * 26.0
        yy = np.arange(h, dtype=np.float32)[:, None]
        grain = np.sin((yy + warp) / (h / 150.0)) * 0.5 + 0.5
        fine = smooth_field(rng, (w, h), (max(2, w // 300), max(2, h // 6)))
        base = np.array([150, 104, 66], dtype=np.float32)
        tone = 0.80 + 0.12 * grain + 0.10 * fine + 0.08 * low
        arr = base[None, None, :] * tone[..., None]
    elif kind == "desk":
        base = np.array([206, 203, 196], dtype=np.float32)
        tone = 0.92 + 0.08 * low
        arr = base[None, None, :] * tone[..., None]
    elif kind == "concrete":
        base = np.array([128, 127, 122], dtype=np.float32)
        speck = rng.normal(0, 0.05, (h, w)).astype(np.float32)
        tone = 0.85 + 0.15 * low + speck
        arr = base[None, None, :] * tone[..., None]
    else:
        raise ValueError(kind)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def lighting_mask(rng: np.random.Generator, size: tuple[int, int], spec: dict) -> np.ndarray:
    """不均匀光照:线性渐变 + 一个高光斑 + 暗角,在小尺寸上算好再放大。"""
    w, h = size
    sw, sh = max(8, w // 8), max(8, h // 8)
    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32)
    xx /= sw
    yy /= sh
    gx, gy = spec.get("gradient", (0.0, 0.0))
    mask = 1.0 + gx * (xx - 0.5) + gy * (yy - 0.5)
    sx, sy = spec.get("spot", (0.3, 0.25))
    mask += spec.get("spot_gain", 0.08) * np.exp(-(((xx - sx) ** 2 + (yy - sy) ** 2) / 0.08))
    vig = spec.get("vignette", 0.18)
    mask -= vig * (((xx - 0.5) ** 2 + (yy - 0.5) ** 2) / 0.5)
    mask = np.clip(mask, spec.get("floor", 0.6), 1.08)
    im = Image.fromarray(np.clip(mask / 1.1 * 255, 0, 255).astype(np.uint8), "L").resize((w, h), Image.BICUBIC)
    return np.asarray(im, dtype=np.float32) / 255.0 * 1.1


# ---------------------------------------------------------------------------
# 两条劣化流水线
# ---------------------------------------------------------------------------
def photo(doc: Image.Image, p: dict, rng: np.random.Generator) -> Image.Image:
    """手机拍照:纸放在桌上,略斜着拍。p 见 docs_spec.DEGRADE。"""
    paper = doc.convert("RGB")
    if p.get("paper_tint"):
        paper = paper_tint(paper, tuple(p["paper_tint"]))
    if p.get("crease"):
        paper = crease(paper, p["crease"])
    if p.get("watermark"):
        paper = watermark(paper, **p["watermark"])
    w, h = paper.size
    margin = p.get("margin", 0.14)
    cw, ch = int(w * (1 + 2 * margin)), int(h * (1 + 2 * margin))
    bg = background(p["background"], (cw, ch), rng)

    a = math.radians(p["rotate"])
    cx, cy = cw / 2 + p.get("shift", (0, 0))[0] * w, ch / 2 + p.get("shift", (0, 0))[1] * h
    k = p.get("keystone", 0.0)            # 俯拍角度:上边比下边窄
    corners = [(-w / 2 * (1 - k), -h / 2), (w / 2 * (1 - k), -h / 2), (w / 2 * (1 + k / 3), h / 2),
               (-w / 2 * (1 + k / 3), h / 2)]
    jit = p.get("perspective", 0.02) * w
    dst = []
    for x, y in corners:
        xr = x * math.cos(a) - y * math.sin(a)
        yr = x * math.sin(a) + y * math.cos(a)
        dst.append((cx + xr + float(rng.uniform(-jit, jit)), cy + yr + float(rng.uniform(-jit, jit))))
    coeffs = perspective_coeffs(dst, [(0, 0), (w, 0), (w, h), (0, h)])
    warped = paper.convert("RGBA").transform((cw, ch), Image.PERSPECTIVE, coeffs, Image.BICUBIC,
                                             fillcolor=(0, 0, 0, 0))
    # 纸张投影
    alpha = warped.getchannel("A")
    sh_alpha = alpha.filter(ImageFilter.GaussianBlur(w * 0.012)).point(lambda v: int(v * 0.5))
    shadow = Image.new("RGBA", (cw, ch), (20, 14, 8, 0))
    shadow.putalpha(sh_alpha)
    canvas = bg.convert("RGBA")
    canvas.alpha_composite(shadow, (int(w * 0.010), int(w * 0.014)))
    canvas.alpha_composite(warped)
    img = canvas.convert("RGB")

    img = multiply(img, lighting_mask(rng, img.size, p.get("lighting", {})))
    if p.get("blur"):
        img = img.filter(ImageFilter.GaussianBlur(p["blur"] * cw / 2000.0))
    if p.get("crop"):
        l, t, r, b = p["crop"]
        img = img.crop((int(cw * l), int(ch * t), int(cw * (1 - r)), int(ch * (1 - b))))
    tw = p.get("out_width", 1500)
    img = img.resize((tw, round(img.size[1] * tw / img.size[0])), Image.LANCZOS)
    img = add_noise(img, p.get("noise", 2.5), rng)
    return img


def scan(doc: Image.Image, p: dict, rng: np.random.Generator) -> Image.Image:
    """扫描/复印件:去饱和、灰底、旋转、边缘阴影、墨点。"""
    paper = doc.convert("RGB")
    if p.get("watermark"):
        paper = watermark(paper, **p["watermark"])
    if p.get("crease"):
        paper = crease(paper, p["crease"])
    paper = ImageEnhance.Color(paper).enhance(p.get("saturation", 0.35))
    # 复印机的灰底与偏暗的墨色
    lo, hi = p.get("levels", (28, 243))
    arr = np.asarray(paper, dtype=np.float32)
    arr = lo + arr * (hi - lo) / 255.0
    paper = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    bed = tuple(p.get("bed", (232, 232, 228)))
    img = paper.rotate(p["rotate"], resample=Image.BICUBIC, expand=True, fillcolor=bed)
    w, h = img.size
    # 扫描仪边缘阴影 + 盖板没压平造成的一侧发暗
    xx = np.linspace(0.0, 1.0, w, dtype=np.float32)[None, :]
    yy = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None]
    side = p.get("edge", "left")
    t = {"left": xx, "right": 1 - xx, "top": yy, "bottom": 1 - yy}[side]
    mask = 1.0 - 0.35 * np.exp(-t / 0.012) - p.get("lid_shadow", 0.06) * (1 - t)
    mask = mask * np.ones((h, w), dtype=np.float32)
    img = multiply(img, mask)
    if p.get("lighting"):
        img = multiply(img, lighting_mask(rng, img.size, p["lighting"]))
    # 墨点
    n = int(p.get("specks", 260))
    d = ImageDraw.Draw(img)
    for _ in range(n):
        x, y = float(rng.uniform(0, w)), float(rng.uniform(0, h))
        r = float(rng.uniform(0.6, 2.2)) * w / 1600.0
        g = int(rng.uniform(40, 120))
        d.ellipse((x - r, y - r, x + r, y + r), fill=(g, g, g))
    if p.get("blur"):
        img = img.filter(ImageFilter.GaussianBlur(p["blur"] * w / 1600.0))
    tw = p.get("out_width", 1300)
    img = img.resize((tw, round(h * tw / w)), Image.LANCZOS)
    img = add_noise(img, p.get("noise", 3.0), rng)
    return img


def degrade(doc: Image.Image, p: dict, key: str) -> Image.Image:
    rng = rng_for(key)
    if p["mode"] == "photo":
        return photo(doc, p, rng)
    if p["mode"] == "scan":
        return scan(doc, p, rng)
    raise ValueError(p["mode"])


# ---------------------------------------------------------------------------
# 显式标识与保存(隐式标识)
# ---------------------------------------------------------------------------
def label_geometry(size: tuple[int, int]) -> tuple[int, tuple[int, int, int, int]]:
    """右下角标识牌的字号与外框(x0, y0, x1, y1)。check_docs.py 用它核对像素。"""
    w, h = size
    fs = max(16, round(min(w, h) * 0.024))
    f = font(fs)
    bbox = ImageDraw.Draw(Image.new("RGB", (1, 1))).textbbox((0, 0), LABEL, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad, margin = round(fs * 0.45), round(fs * 0.6)
    return fs, (w - margin - tw - 2 * pad, h - margin - th - 2 * pad, w - margin, h - margin)


def stamp_label(img: Image.Image) -> Image.Image:
    """右下角画不透明的标识牌(白底灰字),盖在一切效果之上。"""
    out = img.convert("RGB")
    fs, (x0, y0, x1, y1) = label_geometry(out.size)
    f = font(fs)
    d = ImageDraw.Draw(out)
    d.rectangle((x0, y0, x1, y1), fill=(250, 250, 248), outline=(150, 150, 150), width=max(1, fs // 14))
    bbox = d.textbbox((0, 0), LABEL, font=f)
    pad = round(fs * 0.45)
    d.text((x0 + pad - bbox[0], y0 + pad - bbox[1]), LABEL, font=f, fill=(68, 68, 68))
    return out


def png_bytes(img: Image.Image, title: str) -> bytes:
    info = PngImagePlugin.PngInfo()
    # 同一关键字写两份:tEXt(UTF-8 字节,兼容只认 tEXt 的读取方)在前,iTXt(规范的 UTF-8 文本)在后
    info.add_text("AIGC", LABEL.encode("utf-8"))
    info.add_itxt("AIGC", LABEL, lang="zh-CN", tkey="AIGC")
    info.add_itxt("Title", title, lang="zh-CN", tkey="Title")
    info.add_text("Software", SOFTWARE.encode("utf-8"))
    buf = io.BytesIO()
    img.save(buf, "PNG", pnginfo=info, optimize=True)
    return buf.getvalue()


def jpeg_bytes(img: Image.Image, quality: int, title: str) -> tuple[bytes, int]:
    """返回(字节, 实际质量)。超过 1.4 MB 时逐步降低质量。"""
    exif = Image.Exif()
    exif[0x010E] = LABEL.encode("utf-8")        # ImageDescription
    exif[0x0131] = "fde-docgen"                 # Software
    exif[0x9C9B] = title.encode("utf-16-le") + b"\x00\x00"   # XPTitle(Windows 资源管理器可见)
    q = quality
    while True:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=q, optimize=True, exif=exif.tobytes(),
                                comment=f"AIGC={LABEL}".encode("utf-8"))
        data = buf.getvalue()
        if len(data) <= TARGET_BYTES or q <= 40:
            return data, q
        q -= 4


def write_image(img: Image.Image, path: Path, title: str, jpeg_quality: int = 80) -> dict:
    """盖标识并保存;返回写入信息(格式、尺寸、字节数、JPEG 质量)。"""
    out = stamp_label(img)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".png":
        data, q = png_bytes(out, title), None
    else:
        data, q = jpeg_bytes(out, jpeg_quality, title)
    path.write_bytes(data)
    return {"size": out.size, "bytes": len(data), "jpeg_quality": q}


def read_implicit_label(path: Path) -> list[str]:
    """读出图片里的隐式标识(供自检用):PNG 的 tEXt/iTXt「AIGC」,JPEG 的 EXIF ImageDescription。"""
    found: list[str] = []
    if path.suffix.lower() == ".png":
        data = path.read_bytes()
        pos = 8
        while pos < len(data):
            n = int.from_bytes(data[pos:pos + 4], "big")
            typ = data[pos + 4:pos + 8]
            body = data[pos + 8:pos + 8 + n]
            if typ == b"tEXt":
                k, _, v = body.partition(b"\x00")
                if k == b"AIGC":
                    found.append("tEXt:" + v.decode("utf-8", "replace"))
            elif typ == b"iTXt":
                k, _, rest = body.partition(b"\x00")
                if k == b"AIGC":
                    comp, rest = rest[0], rest[2:]
                    _lang, _, rest = rest.partition(b"\x00")
                    _tkey, _, text = rest.partition(b"\x00")
                    if comp == 0:
                        found.append("iTXt:" + text.decode("utf-8", "replace"))
            pos += 12 + n
    else:
        with Image.open(path) as im:
            v = im.getexif().get(0x010E)
        if isinstance(v, bytes):
            found.append("EXIF:" + v.decode("utf-8", "replace"))
        elif isinstance(v, str):
            try:
                found.append("EXIF:" + v.encode("latin-1").decode("utf-8"))
            except UnicodeError:
                found.append("EXIF:" + v)
    return found
