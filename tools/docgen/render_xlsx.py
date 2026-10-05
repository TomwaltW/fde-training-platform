#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_xlsx.py —— 把 truth/*.csv 渲染成用户可下载的 Excel 资料,并写 artifacts/manifest.yaml。

    A2  artifacts/A2/exceptions_q3.xlsx   操作部手工维护的《异常登记表》:只有 8 个可见列 + 「经手票量」页
    A4  artifacts/A4/loss_q3.xlsx         财务口径的 Q3 异常费用:「汇总」按费用类型(不按原因)、「明细」逐笔
    A5  artifacts/A5/intake_week.xlsx     近一周来料文件统计(之后渲染 intake_week.png 的数据源)

方案 4.1 步骤 5(仅 Excel 部分)与步骤 7(清单)。真值列(category / image_source / loss 等)绝不写进资料。
输出确定性:固定 zip 时间戳与文档属性,重复运行字节级一致。
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
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
                       VISIBLE_COLUMNS, WEEKDAYS, load_params)

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


# ---------------------------------------------------------------------------
# 清单(方案 4.1 步骤 7)
# ---------------------------------------------------------------------------
def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_manifest(a2: dict, a4: dict, a5: dict, exc: list[dict], loss: list[dict], handlers: list[dict],
                   shipments: list[dict]) -> None:
    p = load_params()
    t = p["targets"]
    cats = p["categories"]
    loss_by_wb: dict[str, int] = {}
    for x in loss:
        loss_by_wb[x["运单号"]] = loss_by_wb.get(x["运单号"], 0) + int(x["金额"])
    cat_loss = {c["id"]: sum(loss_by_wb.get(r["运单号"], 0) for r in exc if r["category"] == c["id"]) for c in cats}
    cat_cnt = {c["id"]: sum(1 for r in exc if r["category"] == c["id"]) for c in cats}
    new_names = {h["handler"] for h in handlers if h["is_new_hire"] == "true"}
    new_exc = sum(1 for r in exc if r["经手人"] in new_names)
    new_vol = sum(int(h["vol_q3"]) for h in handlers if h["is_new_hire"] == "true")
    key = [r for r in exc if r["customer_canon"] == "拓浪科技"]
    key_hs = [r for r in key if r["category"] == "E_HS"]
    key_insp = sorted(r["运单号"] for r in key if r["发现环节"] == "海关查验")
    clue_rows = [s for s in shipments if s["clue_ids"]]
    a1_rows = [s for s in shipments if s["a1_docs"]]
    rel = lambda path: path.relative_to(SCENARIO_DIR).as_posix()  # noqa: E731

    def q(s: str) -> str:
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

    lines = [
        "# scenarios/freight-docs/artifacts/manifest.yaml",
        "# 由 tools/docgen/render_xlsx.py 生成,请勿手改;改数据请改 scenario.yaml / gen_truth.py 后重跑。",
        "# 用途(方案 4.1 步骤 7):每份资料对应哪些票、藏了哪条线索;裁判据此判断用户是否自己从资料里发现了线索。",
        "schema_version: 0.1",
        "scenario: freight-docs",
        f"notice: {q(MARK)}",
        "truth:",
        "  dir: truth/",
        "  meta: truth/meta.json",
        f"  params_source: {q(p['source'])}",
        "artifacts:",
        "  - id: A2",
        "    title: 异常登记表 Q3(428 行)",
        "    holder: liu",
        "    files:",
        f"      - path: {rel(A2_PATH)}",
        f"        sha256: {sha256(A2_PATH)}",
        "        sheets:",
        "          - name: 异常登记",
        "            header_row: 2",
        f"            rows: {a2['rows']}",
        "            columns: [" + ", ".join(VISIBLE_COLUMNS) + "]",
        "            source: truth/exceptions.csv(只含 8 个可见列;category、image_source、loss 等真值列不出现)",
        "          - name: 经手票量",
        "            header_row: 2",
        f"            rows: {a2['handlers']}",
        "            columns: [经手人, 入职时间, 7月, 8月, 9月, Q3合计]",
        "            source: truth/handler_volume.csv",
        "    waybills: 见 truth/exceptions.csv 的 运单号 列(与 truth/shipments.csv 不重叠)",
        "    supports: {facts: [P1, K5, RH1, S2], experiments: [X2, X5], diagnosis: [T1, T2]}",
        "    clues:",
        f"      - {{fact: P1, where: 「异常登记」共 {a2['rows']} 行}}",
        "      - {fact: K5, where: \"「异常描述」是自由文本、口径不一:同一根因有多种说法(如「改单没同步」「客户改了没跟报关行说」"
        "「仓库按老箱数打的板」),要自己重新归类\"}",
        f"      - {{fact: RH1, where: \"「经手票量」里 {len(new_names)} 名入职不满 6 个月的新人经手 {new_vol}/{a2['volume_total']}"
        f"={new_vol / a2['volume_total']:.0%} 的票;「异常登记」里新人经手 {new_exc}/{a2['rows']}={new_exc / a2['rows']:.0%},差别不大\"}}",
        f"      - {{fact: S2, where: \"拓浪(客户列写作「拓浪科技」或「拓浪」)有 {len(key_insp)} 行 发现环节=海关查验:"
        f"{'、'.join(key_insp)}\"}}",
        f"      - {{experiment: X2, where: \"按「异常描述」重新归类得到 "
        + "/".join(str(cat_cnt[c["id"]]) for c in cats)
        + f"(录入类中描述提到照片/扫描/手写等的 {t['keyin_image']} 件)\"}}",
        "  - id: A4",
        "    title: Q3 异常费用汇总(财务)",
        "    holder: wang",
        "    files:",
        f"      - path: {rel(A4_PATH)}",
        f"        sha256: {sha256(A4_PATH)}",
        "        sheets:",
        "          - name: 汇总",
        "            header_row: 4",
        f"            rows: {len(FEE_TYPES)}",
        "            columns: [费用类型, 7月, 8月, 9月, 合计, 笔数, 占比]",
        "            note: 按费用类型归集,不按原因;要得到按原因的金额必须和 A2 按运单号对上(X3)",
        "          - name: 明细",
        "            header_row: 2",
        f"            rows: {a4['lines']}",
        "            columns: [" + ", ".join(LOSS_COLUMNS) + "]",
        "            source: truth/loss.csv",
        "    supports: {facts: [C1, C2], experiments: [X3, X5]}",
        "    clues:",
        f"      - {{fact: C2, where: \"「汇总」合计 {a4['total']:,} 元\"}}",
        "      - {fact: C1, where: \"费用类型:" + "、".join(FEE_TYPES) + "\"}",
        "      - {fact: S2, where: 「明细」里拓浪的两笔查验费}",
        "  - id: A5",
        "    title: 近一周来料文件统计(1512 个文件)",
        "    holder: chen",
        "    files:",
        f"      - path: {rel(A5_PATH)}",
        f"        sha256: {sha256(A5_PATH)}",
        "        role: data_source        # scenario.yaml 里 A5 的正式文件是 intake_week.png,之后由本表渲染",
        "        sheets:",
        "          - name: 来料统计",
        "            header_row: 4",
        "            source: truth/intake_week.csv",
        "      - path: artifacts/A5/intake_week.png",
        "        status: pending          # 图片渲染不在本周范围",
        "    supports: {facts: [P3], diagnosis: [T1]}",
        "    clues:",
        f"      - {{fact: P3, where: \"Excel {a5['xlsx']}、电子PDF {a5['pdf']}、图片/扫描件 {a5['image']},合计 {a5['total']};"
        f"占比 {a5['xlsx'] / a5['total']:.0%}/{a5['pdf'] / a5['total']:.0%}/{a5['image'] / a5['total']:.0%}\"}}",
        "joins:",
        "  - id: A2xA4",
        "    artifacts: [A2, A4]",
        "    key: 运单号",
        "    rule: A4「明细」的每个运单号都在 A2 且 是否产生费用=是;A2 里 是否产生费用=是 的每个运单号在 A4 至少有一行",
        "    supports: {facts: [C3, P2], experiments: [X3, X5], diagnosis: [T1, T3]}",
        "    expected_loss_by_cause:",
    ]
    for c in cats:
        lines.append(f"      {c['id']}: {{count: {cat_cnt[c['id']]}, loss: {cat_loss[c['id']]}}}")
    lines += [
        f"    expected_key_customer: {{name: 拓浪科技, rows: {len(key)}, hs_rows: {len(key_hs)}, "
        f"hs_loss: {sum(loss_by_wb.get(r['运单号'], 0) for r in key_hs)}, inspections: {len(key_insp)}}}",
        "pending:",
        "  # A1 样本包尚未渲染;线索已写进 truth/shipments.csv(clue_ids、a1_docs、x4_* 列)",
        "  - id: A1",
        "    truth: truth/shipments.csv",
        f"    planned_docs: {sum(len(s['a1_docs'].split('|')) for s in a1_rows)}",
        "    clues:",
    ]
    for s in clue_rows:
        lines.append(f"      - {{fact: {s['clue_ids']}, waybill: {s['waybill']}, note: {q(s['clue_note'])}}}")
    n_img = sum(1 for s in a1_rows for d in s["a1_docs"].split("|") if d.split(":")[1] in ("照片", "扫描件", "手写"))
    lines += [
        f"      - {{fact: K4, note: \"样本包计划 {sum(len(s['a1_docs'].split('|')) for s in a1_rows)} 份,"
        f"其中 {n_img} 份照片/扫描件/手写(见 a1_docs 列)\"}}",
        "    x4_support: truth/shipments.csv 的 x4_sample / x4_issue / x4_caught_stage 列(30 票、7 票不一致、5 票出货前、2 票报关环节)",
        "  - {id: A3, status: pending}",
        "  - {id: A6, status: pending}",
        "  - {id: A7, status: pending}",
        "  - {id: A8, status: pending}",
    ]
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    exc = read_csv("exceptions.csv")
    loss = read_csv("loss.csv")
    handlers = read_csv("handler_volume.csv")
    intake = read_csv("intake_week.csv")
    shipments = read_csv("shipments.csv")
    a2 = render_a2(exc, handlers)
    a4 = render_a4(loss)
    a5 = render_a5(intake)
    write_manifest(a2, a4, a5, exc, loss, handlers, shipments)
    for path in (A2_PATH, A4_PATH, A5_PATH, MANIFEST_PATH):
        print(f"wrote {path.relative_to(ROOT)}  ({path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
