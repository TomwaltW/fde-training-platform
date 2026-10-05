#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_docs.py —— 方案 4.1 步骤 5–7:把真值账本渲染成 A1/A3/A5/A6/A7/A8 的资料文件,并重写 artifacts/manifest.yaml。

    HTML 模板(Jinja2,tools/docgen/templates/)→ 无头 Chromium 截图(PNG)或打印(PDF)
    → 照片/扫描件走 degrade.py 劣化 → 右下角印「合成样本·训练用」并写隐式标识
    Excel 资料(A1 的两份、A7 导入模板)直接用 openpyxl 生成

确定性:模板与劣化参数固定、随机流固定;PDF 统一改写元数据(固定日期与文件 ID),
xlsx 固定 zip 时间戳。重复运行,图片像素一致、PDF 与 xlsx 字节一致。

用法:
    tools/docgen/.venv/bin/python tools/docgen/render_docs.py
环境变量 FDE_CHROMIUM 可覆盖浏览器路径(默认 /opt/pw-browsers/chromium)。
"""
from __future__ import annotations

import hashlib
import io
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from openpyxl.styles import Alignment, Font
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject

sys.path.insert(0, str(Path(__file__).resolve().parent))
import degrade as D  # noqa: E402
import docs_spec as S  # noqa: E402
import manifest as M  # noqa: E402
from render_xlsx import (BORDER, F_BODY, F_BOLD, F_MARK, F_TITLE, FILL_HEAD_FIN, FILL_HEAD_OPS,  # noqa: E402
                         FILL_TOTAL, new_workbook, save_deterministic, set_widths, style_header)

CHROMIUM = os.environ.get("FDE_CHROMIUM", "/opt/pw-browsers/chromium")
PDF_DATE = "D:20261001090000+08'00'"
OWNED_DIRS = ["A1", "A3", "A6", "A7", "A8"]     # 这些目录里只应有本脚本产出的文件
F_RED = Font(name="等线", size=11, bold=True, color="C00000")
F_HINT = Font(name="等线", size=10, italic=True, color="808080")


# ---------------------------------------------------------------------------
# 无头 Chromium
# ---------------------------------------------------------------------------
def _chromium(args: list[str], out: Path, tmp: Path) -> None:
    profile = tmp / f"profile-{out.stem}"
    cmd = [CHROMIUM, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
           "--no-first-run", "--disable-extensions", "--disable-background-networking",
           f"--user-data-dir={profile}"] + args
    for attempt in range(3):
        if out.exists():
            out.unlink()
        r = subprocess.run(cmd, capture_output=True, timeout=120)
        if out.exists() and out.stat().st_size > 0:
            return
        time.sleep(1 + attempt)
    raise RuntimeError(f"Chromium 渲染失败:{out.name}\n{r.stderr.decode('utf-8', 'replace')[-800:]}")


# 新版无头模式下 --window-size 是窗口尺寸:视口比窗口矮一截,窄窗口还会被放宽到最小宽度。
# 所以窗口开得比版面大,模板给 body 写死尺寸,截图后再按版面尺寸从左上角裁出来。
WINDOW_PAD = (240, 240)


def screenshot(page: Path, out: Path, viewport: tuple[int, int], scale: float, tmp: Path) -> None:
    w, h = viewport
    raw = out.with_name(out.stem + ".win.png")
    _chromium([f"--force-device-scale-factor={scale}", f"--window-size={w + WINDOW_PAD[0]},{h + WINDOW_PAD[1]}",
               f"--screenshot={raw}", page.as_uri()], raw, tmp)
    with Image.open(raw) as im:
        box = (0, 0, round(w * scale), round(h * scale))
        if im.size[0] < box[2] or im.size[1] < box[3]:
            raise RuntimeError(f"截图尺寸 {im.size} 小于版面 {box[2:]}")
        im.crop(box).save(out)


def print_pdf(page: Path, out: Path, tmp: Path) -> None:
    _chromium(["--no-pdf-header-footer", f"--print-to-pdf={out}", page.as_uri()], out, tmp)


def normalize_pdf(raw: Path, dest: Path, doc: S.Doc) -> dict:
    """改写元数据(Subject 写隐式标识)、固定日期与文件 ID,保证重复运行字节一致。"""
    reader = PdfReader(raw)
    w = PdfWriter(clone_from=reader)
    w.add_metadata({"/Title": doc.title, "/Subject": S.LABEL, "/Author": "fde-docgen(合成样本)",
                    "/Keywords": f"AIGC={S.LABEL}; {S.MARK}", "/Creator": "fde-docgen",
                    "/Producer": "fde-docgen (Chromium print)", "/CreationDate": PDF_DATE, "/ModDate": PDF_DATE})
    fid = ByteStringObject(hashlib.md5(f"fde-docgen:{doc.rel}".encode()).digest())
    w._ID = ArrayObject([fid, fid])  # noqa: SLF001  pypdf 默认不写 ID;这里写固定值
    buf = io.BytesIO()
    w.write(buf)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(buf.getvalue())
    return {"pages": len(reader.pages), "bytes": len(buf.getvalue())}


# ---------------------------------------------------------------------------
# Excel 资料
# ---------------------------------------------------------------------------
def _cell(ws, row, col, value, font=F_BODY, fmt=None, border=True, align=None):
    c = ws.cell(row=row, column=col, value=value)
    c.font = font
    if border:
        c.border = BORDER
    if fmt:
        c.number_format = fmt
    if align:
        c.alignment = Alignment(horizontal=align, vertical="center", wrap_text=False)
    return c


def xlsx_packing_list(doc: S.Doc) -> dict:
    """A1:青禾的 Excel 装箱单(工厂 Excel 风,数字直接是值,没有公式)。"""
    c = doc.ctx
    wb = new_workbook(f"{doc.waybill} 装箱单")
    ws = wb.active
    ws.title = "装箱单"
    ws.merge_cells("A1:H1")
    _cell(ws, 1, 1, c["seller"]["cn"] + "  " + c["seller"]["en"], F_TITLE, border=False)
    ws.merge_cells("A2:H2")
    _cell(ws, 2, 1, c["seller"]["addr"], F_BODY, border=False)
    ws.merge_cells("A3:H3")
    _cell(ws, 3, 1, "装箱单 PACKING LIST", Font(name="等线", size=16, bold=True), border=False, align="center")
    meta = [("收货人", c["buyer"]["name"], "单号", c["pl_no"]), ("目的仓", f"FBA {c['fba']}", "日期", c["date"]),
            ("运单号", c["ref"], "起运", c["pol"])]
    for i, (k1, v1, k2, v2) in enumerate(meta, start=5):
        _cell(ws, i, 1, k1, F_BOLD, border=False)
        ws.merge_cells(start_row=i, start_column=2, end_row=i, end_column=4)
        _cell(ws, i, 2, v1, border=False)
        _cell(ws, i, 6, k2, F_BOLD, border=False)
        ws.merge_cells(start_row=i, start_column=7, end_row=i, end_column=8)
        _cell(ws, i, 7, v2, border=False)
    hdr = ["序号", "货号", "品名", "箱数", "每箱件数", "件数", "毛重(KG)", "体积(CBM)"]
    hr = 9
    for j, h in enumerate(hdr, start=1):
        ws.cell(row=hr, column=j, value=h)
    style_header(ws, hr, len(hdr), FILL_HEAD_OPS)
    r = hr
    for ln in c["lines"]:
        r += 1
        vals = [ln["no"], ln["sku"], ln["name"], int(ln["ctn"]), int(ln["ppc"]), int(ln["pcs"]), float(ln["gw"]),
                float(ln["cbm"])]
        fmts = [None, None, None, "#,##0", "#,##0", "#,##0", "#,##0.0", "0.00"]
        for j, (v, f) in enumerate(zip(vals, fmts), start=1):
            _cell(ws, r, j, v, fmt=f)
    r += 1
    tot = ["合计", None, None, c["total_ctn"], None, c["total_pcs"], float(c["total_gw"]), float(c["total_cbm"])]
    for j, v in enumerate(tot, start=1):
        cell = _cell(ws, r, j, v, F_BOLD, fmt=[None, None, None, "#,##0", None, "#,##0", "#,##0.0", "0.00"][j - 1])
        cell.fill = FILL_TOTAL
    _cell(ws, r + 2, 1, "唛头:" + " / ".join(c["marks"]), border=False)
    _cell(ws, r + 3, 1, "以上数量以实际装箱为准,如有出入请及时联系。", border=False)
    _cell(ws, r + 5, 1, S.MARK, F_MARK, border=False)
    set_widths(ws, [7, 11, 16, 8, 10, 9, 11, 11])
    save_deterministic(wb, doc.path)
    return {"bytes": doc.path.stat().st_size}


def xlsx_invoice(doc: S.Doc) -> dict:
    """A1:星渚的 Excel 发票(英文外贸模板风)。"""
    c = doc.ctx
    wb = new_workbook(f"{doc.waybill} Invoice")
    ws = wb.active
    ws.title = "INVOICE"
    ws.merge_cells("A1:F1")
    _cell(ws, 1, 1, c["seller"]["en"], Font(name="Arial", size=15, bold=True, color="1F5FA8"), border=False)
    ws.merge_cells("A2:F2")
    _cell(ws, 2, 1, c["seller"]["cn"] + " · " + c["seller"]["addr"], F_BODY, border=False)
    ws.merge_cells("A4:F4")
    _cell(ws, 4, 1, "COMMERCIAL INVOICE", Font(name="Arial", size=16, bold=True), border=False, align="center")
    meta = [("Sold To:", c["buyer"]["name"], "Invoice No.:", c["inv_no"]),
            ("", c["buyer"]["addr"], "Date:", c["date"]),
            ("Shipment Ref.:", c["ref"], "Terms:", c["terms"]),
            ("From:", c["pol"], "To:", c["pod"])]
    for i, (k1, v1, k2, v2) in enumerate(meta, start=6):
        _cell(ws, i, 1, k1, F_BOLD, border=False)
        ws.merge_cells(start_row=i, start_column=2, end_row=i, end_column=3)
        _cell(ws, i, 2, v1, border=False)
        _cell(ws, i, 4, k2, F_BOLD, border=False)
        ws.merge_cells(start_row=i, start_column=5, end_row=i, end_column=6)
        _cell(ws, i, 5, v2, border=False)
    hdr = ["No.", "Item No.", "Description", "Qty (PCS)", "Unit Price (USD)", "Amount (USD)"]
    hr = 11
    for j, h in enumerate(hdr, start=1):
        ws.cell(row=hr, column=j, value=h)
    style_header(ws, hr, len(hdr), FILL_HEAD_FIN)
    r = hr
    for ln in c["lines"]:
        r += 1
        vals = [ln["no"], ln["sku"], f"{ln['name']} {ln['en']}", int(ln["pcs"]), float(ln["unit"]), float(ln["amount"])]
        for j, (v, f) in enumerate(zip(vals, [None, None, None, "#,##0", "0.00", "#,##0.00"]), start=1):
            _cell(ws, r, j, v, fmt=f)
    r += 1
    for j, v in enumerate(["TOTAL", None, None, int(c["total_pcs"]), None, float(c["total_amount"])], start=1):
        cell = _cell(ws, r, j, v, F_BOLD, fmt=[None, None, None, "#,##0", None, "#,##0.00"][j - 1])
        cell.fill = FILL_TOTAL
    _cell(ws, r + 2, 1, f"SAY TOTAL: {c['words']}", F_BOLD, border=False)
    for k, n in enumerate(c["notes"]):
        _cell(ws, r + 3 + k, 1, n, border=False)
    _cell(ws, r + 6, 1, S.MARK, F_MARK, border=False)
    set_widths(ws, [14, 12, 36, 11, 16, 15])
    save_deterministic(wb, doc.path)
    return {"bytes": doc.path.stat().st_size}


IMPORT_COLUMNS = ["运单号*", "客户*", "业务类型*", "出货日期*", "起运港*", "目的港*", "目的仓", "货号", "品名*", "申报品名*",
                  "HS编码", "箱数*", "每箱件数", "件数*", "毛重(KG)*", "体积(CBM)*", "是否带电*", "装箱单版本", "备注"]
IMPORT_RULES = [
    f"本模板用于{S.FMS}「海运出口 › 订单批量导入」,模板版本 v3.2;请勿增删列、调整列顺序或修改表头。",
    "带 * 的列必填;日期格式 yyyy-mm-dd;数字列只填数字,不要带单位。",
    "一票多个货号时每个货号一行,运单号重复填写。",
    "每次导入不超过 200 行;导入后需在「待确认订单」里逐票点「确认」才生效。",
    f"系统不提供外部数据接口(API);如需与其他系统对接,请联系{S.FMS}客户经理(增值服务,另行收费)。",
    "已导入的订单如需改单,只能在系统界面逐票修改;重复导入同一运单号会被拒绝,不会覆盖。",
    "HS编码列请按「品名 / HS」基础资料填写(本样本中 HS 编码均为占位符,非真实编码)。",
]


def xlsx_import_template(doc: S.Doc, t: S.Truth) -> dict:
    """A7:运链通 FMS 的 Excel 导入模板(导入数据 / 示例 / 填写说明)。"""
    wb = new_workbook(f"{S.FMS} 订单导入模板 v3.2")
    ws = wb.active
    ws.title = "导入数据"
    for j, h in enumerate(IMPORT_COLUMNS, start=1):
        ws.cell(row=1, column=j, value=h)
    style_header(ws, 1, len(IMPORT_COLUMNS), FILL_HEAD_FIN)
    for j, h in enumerate(IMPORT_COLUMNS, start=1):
        if h.endswith("*"):
            ws.cell(row=1, column=j).font = F_RED
    _cell(ws, 1, len(IMPORT_COLUMNS) + 2, S.MARK, F_MARK, border=False)
    widths = [14, 16, 12, 12, 10, 10, 9, 10, 14, 14, 13, 7, 9, 8, 11, 11, 9, 11, 14]
    set_widths(ws, widths)
    ws.freeze_panes = "A2"

    ex = wb.create_sheet("示例")
    for j, h in enumerate(IMPORT_COLUMNS, start=1):
        ex.cell(row=1, column=j, value=h)
    style_header(ex, 1, len(IMPORT_COLUMNS), FILL_HEAD_FIN)
    r = 1
    for ln in doc.ctx["rows"]:
        s = t.shipments[ln["waybill"]]
        r += 1
        pod = S.POD[s["fba_warehouse"]]
        # 客户名和 FMS 录单界面一样带「(虚构)」(check_docs 逐个单元格扫名称标记)
        vals = [ln["waybill"], f"{s['customer']}(虚构)", "海运出口", s["ship_date"], S.POL_CN, S.POD_CN[pod], s["fba_warehouse"],
                ln["sku"], ln["item_name"], ln["declared_name"], S.HS_PLACEHOLDER.format(S.HS_SLOT.get(ln["sku"], "00")),
                int(ln["cartons"]), int(ln["pcs_per_ctn"]), int(ln["pieces"]), float(ln["gross_kg"]),
                float(ln["cbm"]), ln["battery"], ln["version"], ""]
        fmts = [None] * 11 + ["0", "0", "0", "0.0", "0.00", None, None, None]
        for j, (v, f) in enumerate(zip(vals, fmts), start=1):
            _cell(ex, r, j, v if v != "" else None, fmt=f)
    _cell(ex, r + 2, 1, "示例数据取自样本包里两票电子来料;导入时请删除本页或只在「导入数据」页填写。", F_HINT, border=False)
    _cell(ex, r + 3, 1, S.MARK, F_MARK, border=False)
    set_widths(ex, widths)

    rules = wb.create_sheet("填写说明")
    _cell(rules, 1, 1, f"{S.FMS} 订单导入模板 · 填写说明", F_TITLE, border=False)
    for i, text in enumerate(IMPORT_RULES, start=1):
        _cell(rules, 2 + i, 1, f"{i}. {text}", F_BODY, border=False)
    _cell(rules, 3 + len(IMPORT_RULES) + 1, 1, S.MARK, F_MARK, border=False)
    set_widths(rules, [120])
    save_deterministic(wb, doc.path)
    return {"bytes": doc.path.stat().st_size}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def render_one(doc: S.Doc, env, t: S.Truth, tmp: Path) -> dict:
    if doc.kind == "xlsx":
        if doc.key == "A7-02":
            return xlsx_import_template(doc, t)
        if doc.doc_type == "发票":
            return xlsx_invoice(doc)
        if doc.doc_type == "装箱单":
            return xlsx_packing_list(doc)
        raise ValueError(doc.key)
    html = S.render_html(env, doc)
    page = tmp / f"{doc.key}.html"
    page.write_text(html, encoding="utf-8")
    if doc.kind == "pdf":
        raw = tmp / f"{doc.key}.raw.pdf"
        print_pdf(page, raw, tmp)
        info = normalize_pdf(raw, doc.path, doc)
        if info["pages"] != 1:
            raise RuntimeError(f"{doc.rel} 打印成了 {info['pages']} 页,应为 1 页")
        return info
    shot = tmp / f"{doc.key}.shot.png"
    screenshot(page, shot, doc.viewport, doc.scale, tmp)
    with Image.open(shot) as im:
        img = im.convert("RGB")
    if doc.degrade:
        img = D.degrade(img, doc.degrade, doc.key)
    q = doc.degrade.get("jpeg_quality", 80) if doc.degrade else 80
    info = D.write_image(img, doc.path, doc.title, q)
    if info["jpeg_quality"] is not None and info["jpeg_quality"] != q:
        raise RuntimeError(f"{doc.rel} 按质量 {q} 超过 1.4 MB,请调低 DEGRADE 里的 jpeg_quality 或 out_width")
    return info


def clean_stale(docs: list[S.Doc]) -> list[str]:
    keep = {d.path for d in docs}
    removed = []
    for a in OWNED_DIRS:
        d = S.ART / a
        if not d.exists():
            continue
        for p in sorted(d.iterdir()):
            if p.is_file() and p not in keep:
                p.unlink()
                removed.append(p.relative_to(S.ROOT).as_posix())
    return removed


def main() -> int:
    if not Path(CHROMIUM).exists():
        print(f"找不到 Chromium:{CHROMIUM}(可用环境变量 FDE_CHROMIUM 指定)", file=sys.stderr)
        return 2
    t = S.load_truth()
    docs = S.build_docs(t)
    env = S.make_env()
    removed = clean_stale(docs)
    for r in removed:
        print(f"removed stale {r}")
    results: dict[str, dict] = {}
    with tempfile.TemporaryDirectory(prefix="fde-docgen-") as td:
        tmp = Path(td)
        with ThreadPoolExecutor(max_workers=4) as pool:
            futs = {d.key: pool.submit(render_one, d, env, t, tmp) for d in docs}
            for d in docs:
                results[d.key] = futs[d.key].result()
    for d in docs:
        info = results[d.key]
        extra = f"  {info['size'][0]}×{info['size'][1]}" if "size" in info else ""
        extra += f"  {info['pages']} 页" if "pages" in info else ""
        print(f"wrote {d.path.relative_to(S.ROOT)}  ({info['bytes']:,} bytes){extra}")
    # 本次渲染了全部单据:它们的 source_sha256 都按刚用过的 HTML 重算
    path = M.write_manifest(t, docs, env, rendered=results.keys())
    print(f"wrote {path.relative_to(S.ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
