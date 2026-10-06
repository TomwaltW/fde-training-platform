#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_xlsx.py —— 把 truth/*.csv 渲染成用户可下载的 Excel 资料,并写 artifacts/manifest.yaml。

    A2  artifacts/A2/exceptions_q3.xlsx   操作部手工维护的《异常登记表》:只有 8 个可见列 + 「经手票量」页
    A4  artifacts/A4/loss_q3.xlsx         财务口径的 Q3 异常费用:「汇总」按费用类型(不按原因)、「明细」逐笔
    A5  artifacts/A5/intake_week.xlsx     近一周来料文件统计(intake_week.png 的同源数据,png 由 render_docs.py 渲染)

方案 4.1 步骤 5(仅 Excel 部分)与步骤 7(清单,由 manifest.py 统一生成)。真值列(category / image_source / loss 等)绝不写进资料。
输出确定性:固定 zip 时间戳与文档属性,重复运行字节级一致。
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
import sys
import zipfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gen_truth import (FEE_TYPES, LOSS_COLUMNS, ROOT, SCENARIO_DIR, TRUTH_DIR,  # noqa: E402
                       VISIBLE_COLUMNS, WEEKDAYS)

ARTIFACTS = SCENARIO_DIR / "artifacts"
A2_PATH = ARTIFACTS / "A2" / "exceptions_q3.xlsx"
A4_PATH = ARTIFACTS / "A4" / "loss_q3.xlsx"
A5_PATH = ARTIFACTS / "A5" / "intake_week.xlsx"
MANIFEST_PATH = ARTIFACTS / "manifest.yaml"

MARK = "合成样本·训练用 · 公司与数据均为虚构"
FIXED_ZIP_TIME = (2026, 10, 1, 9, 0, 0)
FIXED_ISO = "2026-10-01T09:00:00Z"

FONT = "等线"
F_BODY = Font(name=FONT, size=11)
F_BOLD = Font(name=FONT, size=11, bold=True)
F_TITLE = Font(name=FONT, size=13, bold=True)
F_MARK = Font(name=FONT, size=9, italic=True, color="808080")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
FILL_HEAD_OPS = PatternFill("solid", fgColor="FFF2CC")     # 操作部:手工表常见的浅黄表头
FILL_HEAD_FIN = PatternFill("solid", fgColor="DDEBF7")     # 财务:浅蓝表头
FILL_ALERT = PatternFill("solid", fgColor="F8CBAD")        # 操作部手工标红(海关查验)
FILL_TOTAL = PatternFill("solid", fgColor="F2F2F2")


def read_csv(name: str) -> list[dict]:
    with open(TRUTH_DIR / name, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def new_workbook(title: str) -> Workbook:
    wb = Workbook()
    wb.properties.creator = "docgen(合成样本)"
    wb.properties.lastModifiedBy = "docgen(合成样本)"
    wb.properties.title = title
    wb.properties.description = MARK
    return wb


def style_header(ws, row: int, ncols: int, fill: PatternFill) -> None:
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = F_BOLD
        cell.fill = fill
        cell.border = BORDER
        cell.alignment = Alignment(horizontal="center", vertical="center")


def set_widths(ws, widths: list[float]) -> None:
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def save_deterministic(wb: Workbook, path: Path) -> None:
    """openpyxl 每次保存都会写入当前时间;这里重写 zip,固定时间戳与 core.xml 里的日期。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = io.BytesIO()
    wb.save(raw)
    raw.seek(0)
    out = io.BytesIO()
    with zipfile.ZipFile(raw) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == "docProps/core.xml":
                data = re.sub(rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:)",
                              rb"\g<1>" + FIXED_ISO.encode() + rb"\g<2>", data)
            zi = zipfile.ZipInfo(info.filename, date_time=FIXED_ZIP_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            zout.writestr(zi, data)
    path.write_bytes(out.getvalue())


# ---------------------------------------------------------------------------
# A2 异常登记表
# ---------------------------------------------------------------------------
def render_a2(exc: list[dict], handlers: list[dict]) -> dict:
    wb = new_workbook("Q3异常登记表")
    ws = wb.active
    ws.title = "异常登记"
    ws["A1"] = "2026年Q3 异常登记表(操作部)"
    ws["A1"].font = F_TITLE
    ws["F1"] = MARK
    ws["F1"].font = F_MARK
    header_row = 2
    for c, name in enumerate(VISIBLE_COLUMNS, start=1):
        ws.cell(row=header_row, column=c, value=name)
    style_header(ws, header_row, len(VISIBLE_COLUMNS), FILL_HEAD_OPS)

    rows = sorted(exc, key=lambda r: (r["日期"], r["运单号"]))
    r_i = header_row
    for r in rows:
        r_i += 1
        for c, name in enumerate(VISIBLE_COLUMNS, start=1):
            v = r[name]
            if name == "日期":
                v = dt.date.fromisoformat(v)
            cell = ws.cell(row=r_i, column=c, value=v if v != "" else None)
            cell.font = F_BODY
            cell.border = BORDER
            if name == "日期":
                cell.number_format = "yyyy/m/d"
                cell.alignment = Alignment(horizontal="left")
            if name == "是否产生费用":
                cell.alignment = Alignment(horizontal="center")
        if r["发现环节"] == "海关查验":       # 手工表里常见的"标红":只依据可见列
            for c in range(1, len(VISIBLE_COLUMNS) + 1):
                ws.cell(row=r_i, column=c).fill = FILL_ALERT
    last = r_i
    ws.cell(row=last + 2, column=1, value=MARK).font = F_MARK
    ws.freeze_panes = "A3"
    ws.auto_filter.ref = f"A{header_row}:{get_column_letter(len(VISIBLE_COLUMNS))}{last}"
    set_widths(ws, [11, 14, 11, 9, 11, 52, 26, 12])

    # 经手票量
    ws2 = wb.create_sheet("经手票量")
    ws2["A1"] = "Q3 经手票量(运链通 FMS 按经手人导出)"
    ws2["A1"].font = F_TITLE
    ws2["E1"] = MARK
    ws2["E1"].font = F_MARK
    cols = ["经手人", "入职时间", "7月", "8月", "9月", "Q3合计"]
    for c, name in enumerate(cols, start=1):
        ws2.cell(row=2, column=c, value=name)
    style_header(ws2, 2, len(cols), FILL_HEAD_OPS)
    tot = [0, 0, 0, 0]
    r_i = 2
    for h in handlers:
        r_i += 1
        vals = [h["handler"], h["hire_date"][:7], int(h["vol_jul"]), int(h["vol_aug"]), int(h["vol_sep"]),
                int(h["vol_q3"])]
        for k in range(4):
            tot[k] += vals[2 + k]
        for c, v in enumerate(vals, start=1):
            cell = ws2.cell(row=r_i, column=c, value=v)
            cell.font = F_BODY
            cell.border = BORDER
            if c >= 3:
                cell.number_format = "#,##0"
    r_i += 1
    for c, v in enumerate(["合计", ""] + tot, start=1):
        cell = ws2.cell(row=r_i, column=c, value=v if v != "" else None)
        cell.font = F_BOLD
        cell.fill = FILL_TOTAL
        cell.border = BORDER
        if c >= 3:
            cell.number_format = "#,##0"
    ws2.cell(row=r_i + 2, column=1, value="注:票量按经手人统计,含海运与空派。").font = F_BODY
    ws2.cell(row=r_i + 3, column=1, value=MARK).font = F_MARK
    set_widths(ws2, [11, 11, 9, 9, 9, 10])
    ws2.freeze_panes = "A3"
    save_deterministic(wb, A2_PATH)
    return {"rows": len(rows), "handlers": len(handlers), "volume_total": tot[3]}


# ---------------------------------------------------------------------------
# A4 财务费用表
# ---------------------------------------------------------------------------
def render_a4(loss: list[dict]) -> dict:
    wb = new_workbook("Q3异常费用汇总")
    ws = wb.active
    ws.title = "汇总"
    ws["A1"] = "2026年第三季度 异常费用汇总"
    ws["A1"].font = F_TITLE
    ws["A2"] = "财务部 · 单位:元"
    ws["A2"].font = F_BODY
    ws["E2"] = MARK
    ws["E2"].font = F_MARK
    cols = ["费用类型", "7月", "8月", "9月", "合计", "笔数", "占比"]
    hr = 4
    for c, name in enumerate(cols, start=1):
        ws.cell(row=hr, column=c, value=name)
    style_header(ws, hr, len(cols), FILL_HEAD_FIN)
    grand = sum(int(x["金额"]) for x in loss)
    by_type = {}
    r_i = hr
    for ft in FEE_TYPES:
        items = [x for x in loss if x["费用类型"] == ft]
        months = [sum(int(x["金额"]) for x in items if x["日期"][5:7] == m) for m in ("07", "08", "09")]
        total = sum(months)
        by_type[ft] = total
        r_i += 1
        vals = [ft] + months + [total, len(items), total / grand if grand else 0]
        for c, v in enumerate(vals, start=1):
            cell = ws.cell(row=r_i, column=c, value=v)
            cell.font = F_BODY
            cell.border = BORDER
            if 2 <= c <= 5:
                cell.number_format = "#,##0"
            if c == 7:
                cell.number_format = "0.0%"
    r_i += 1
    m_tot = [sum(int(x["金额"]) for x in loss if x["日期"][5:7] == m) for m in ("07", "08", "09")]
    for c, v in enumerate(["合计"] + m_tot + [grand, len(loss), 1.0], start=1):
        cell = ws.cell(row=r_i, column=c, value=v)
        cell.font = F_BOLD
        cell.fill = FILL_TOTAL
        cell.border = BORDER
        if 2 <= c <= 5:
            cell.number_format = "#,##0"
        if c == 7:
            cell.number_format = "0.0%"
    ws.cell(row=r_i + 2, column=1, value="注:按费用类型归集;每笔费用对应的运单号见「明细」页。").font = F_BODY
    ws.cell(row=r_i + 3, column=1, value=MARK).font = F_MARK
    set_widths(ws, [14, 11, 11, 11, 12, 8, 8])

    ws2 = wb.create_sheet("明细")
    ws2["A1"] = "Q3 异常费用明细"
    ws2["A1"].font = F_TITLE
    ws2["D1"] = MARK
    ws2["D1"].font = F_MARK
    for c, name in enumerate(LOSS_COLUMNS, start=1):
        ws2.cell(row=2, column=c, value=name)
    style_header(ws2, 2, len(LOSS_COLUMNS), FILL_HEAD_FIN)
    r_i = 2
    for x in loss:
        r_i += 1
        vals = [dt.date.fromisoformat(x["日期"]), x["运单号"], x["客户"], x["费用类型"], int(x["金额"]),
                x["备注"] or None]
        for c, v in enumerate(vals, start=1):
            cell = ws2.cell(row=r_i, column=c, value=v)
            cell.font = F_BODY
            cell.border = BORDER
            if c == 1:
                cell.number_format = "yyyy/m/d"
                cell.alignment = Alignment(horizontal="left")
            if c == 5:
                cell.number_format = "#,##0"
    ws2.cell(row=r_i + 2, column=1, value=MARK).font = F_MARK
    ws2.freeze_panes = "A3"
    ws2.auto_filter.ref = f"A2:{get_column_letter(len(LOSS_COLUMNS))}{r_i}"
    set_widths(ws2, [11, 14, 12, 13, 10, 18])
    save_deterministic(wb, A4_PATH)
    return {"lines": len(loss), "total": grand, "by_type": by_type}


# ---------------------------------------------------------------------------
# A5 来料统计
# ---------------------------------------------------------------------------
def render_a5(intake: list[dict]) -> dict:
    wb = new_workbook("近一周来料统计")
    ws = wb.active
    ws.title = "来料统计"
    ws["A1"] = "近一周客户来料文件统计(单证组下载文件夹)"
    ws["A1"].font = F_TITLE
    ws["A2"] = MARK
    ws["A2"].font = F_MARK
    cols = ["星期", "渠道", "Excel", "电子PDF", "图片/扫描件", "合计"]
    fmts = ["xlsx", "pdf", "image"]
    hr = 4
    for c, name in enumerate(cols, start=1):
        ws.cell(row=hr, column=c, value=name)
    style_header(ws, hr, len(cols), FILL_HEAD_OPS)
    r_i = hr
    col_tot = [0, 0, 0]
    for wd in WEEKDAYS:
        for ch in ("微信群", "邮件"):
            counts = [sum(int(x["count"]) for x in intake
                          if x["weekday"] == wd and x["channel"] == ch and x["format"] == f) for f in fmts]
            r_i += 1
            for k in range(3):
                col_tot[k] += counts[k]
            for c, v in enumerate([wd, ch] + counts + [sum(counts)], start=1):
                cell = ws.cell(row=r_i, column=c, value=v)
                cell.font = F_BODY
                cell.border = BORDER
    r_i += 1
    grand = sum(col_tot)
    for c, v in enumerate(["合计", ""] + col_tot + [grand], start=1):
        cell = ws.cell(row=r_i, column=c, value=v if v != "" else None)
        cell.font = F_BOLD
        cell.fill = FILL_TOTAL
        cell.border = BORDER
    r_i += 2
    ws.cell(row=r_i, column=1, value="按格式").font = F_BOLD
    r_i += 1
    for c, name in enumerate(["格式", "文件数", "占比"], start=1):
        ws.cell(row=r_i, column=c, value=name)
    style_header(ws, r_i, 3, FILL_HEAD_OPS)
    for label, n in zip(["Excel", "电子PDF", "图片/扫描件"], col_tot):
        r_i += 1
        for c, v in enumerate([label, n, n / grand], start=1):
            cell = ws.cell(row=r_i, column=c, value=v)
            cell.font = F_BODY
            cell.border = BORDER
            if c == 3:
                cell.number_format = "0.0%"
    r_i += 2
    ws.cell(row=r_i, column=1, value="图片/扫描件细分").font = F_BOLD
    subs: dict[str, int] = {}
    for x in intake:
        if x["format"] == "image":
            subs[x["subtype"]] = subs.get(x["subtype"], 0) + int(x["count"])
    for st, n in subs.items():
        r_i += 1
        ws.cell(row=r_i, column=1, value=st).font = F_BODY
        ws.cell(row=r_i, column=2, value=n).font = F_BODY
    ws.cell(row=r_i + 2, column=1, value=MARK).font = F_MARK
    set_widths(ws, [14, 10, 10, 10, 13, 9])
    save_deterministic(wb, A5_PATH)
    return {"xlsx": col_tot[0], "pdf": col_tot[1], "image": col_tot[2], "total": grand}


def main() -> int:
    exc = read_csv("exceptions.csv")
    loss = read_csv("loss.csv")
    handlers = read_csv("handler_volume.csv")
    intake = read_csv("intake_week.csv")
    a2 = render_a2(exc, handlers)
    a4 = render_a4(loss)
    a5 = render_a5(intake)
    # 清单由 manifest.py 统一生成(含 render_docs.py 的合成单据;尚未渲染的记为 pending)。
    # 这里没有渲染任何合成单据,所以不传 rendered:单据的 source_sha256 沿用旧清单,
    # 真值改了却没跑 render_docs.py 的图片/PDF 会被 check_docs.py 报出来,而不是被这次刷新"洗白"。
    import manifest  # noqa: PLC0415  延迟导入:manifest 依赖 docs_spec / jinja2
    manifest.write_manifest()
    assert (a2["rows"], a4["total"], a5["total"]) == (len(exc), sum(int(x["金额"]) for x in loss), 1512)
    for path in (A2_PATH, A4_PATH, A5_PATH, MANIFEST_PATH):
        print(f"wrote {path.relative_to(ROOT)}  ({path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
