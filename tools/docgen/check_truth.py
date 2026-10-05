#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_truth.py —— 真值账本与 Excel 资料的自检(方案 4.1 步骤 8 + 4.3 校验器里与数据相关的项)。

逐项打印 PASS/FAIL 表,任何一项失败即以非零状态退出。检查范围:
  · 幂等:重新生成的 truth/*.csv 与磁盘上的字节一致
  · 件数、分类、损失合计(498,000)、录入类 21 件图片来源
  · 拓浪:占比 14%、HS 19 件、损失 86,000、Q3 两次查验
  · 新人:5 人、异常 34%、票量 31%;票量合计 19,800
  · 来料 937/318/257;日期都在 Q3;运单号唯一且与 shipments 不重叠
  · 线索票 LT2609-0387 / LT2609-0412 / 带电笼统品名;X4 交叉核对样本;A1 样本包计划
  · loss.csv 与 exceptions.csv 双向对齐
  · A2 只有 8 个可见列、没有任何真值列;A4 按费用类型汇总;A2×A4 按运单号能还原各类损失
  · 复算 scenario.yaml 里 X2/X3/X5 等文字结论并逐条比对
  · 无真实主体信息、无形似真实的信用代码/海关编码;manifest 引用与 sha256
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import re
import sys
import unicodedata
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import yaml
from openpyxl import load_workbook

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_truth as G  # noqa: E402

TRUTH = G.TRUTH_DIR
ART = G.SCENARIO_DIR / "artifacts"
A2 = ART / "A2" / "exceptions_q3.xlsx"
A4 = ART / "A4" / "loss_q3.xlsx"
A5 = ART / "A5" / "intake_week.xlsx"
MANIFEST = ART / "manifest.yaml"
MARK = "合成样本·训练用 · 公司与数据均为虚构"

HIDDEN_TOKENS = ["E_INCONSIST", "E_CHANGE", "E_HS", "E_KEYIN", "E_MISSING", "E_OTHER",
                 "category", "image_source", "customer_canon", "handler_is_new", "desc_tpl"]
CATEGORY_PHRASES = ["客户资料自相矛盾", "改单后未同步", "HS 编码、品名归类", "申报要素错误", "录入手误", "资料缺失或迟交"]
REAL_ENTITIES_CN = ["亚马逊", "顺丰", "中远", "马士基", "德邦", "京东", "阿里巴巴", "腾讯", "华为", "小米", "安克", "绿联",
                    "通拓", "傲基", "泽宝", "有棵树", "赛维", "环球易购", "中外运", "嘉里", "极兔", "菜鸟", "希音",
                    "拼多多", "大疆", "比亚迪", "苹果", "三星", "索尼", "海关总署", "联邦快递"]
REAL_ENTITIES_EN = ["Amazon", "COSCO", "Maersk", "DHL", "FedEx", "UPS", "SHEIN", "Temu", "TikTok", "Anker", "Apple",
                    "Samsung", "Sony"]
USCC_RE = re.compile(r"(?<![0-9A-Z])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])")
HS10_RE = re.compile(r"(?<!\d)\d{10}(?!\d)")
WAYBILL_RE = re.compile(r"^LT26\d{2}-\d{4}$")

results: list[tuple[str, str, str, str, bool]] = []
section = ""


def sec(name: str) -> None:
    global section
    section = name


def check(name: str, expected, actual, ok) -> bool:
    results.append((section, name, str(expected), str(actual), bool(ok)))
    return bool(ok)


def guarded(name: str, fn) -> None:
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        check(name, "可执行", f"异常:{type(e).__name__}: {e}", False)


def pct(a, b, nd: int = 0) -> Decimal:
    q = Decimal(1).scaleb(-nd)
    return (Decimal(a) * 100 / Decimal(b)).quantize(q, rounding=ROUND_HALF_UP)


def wan(x: int, nd: int) -> Decimal:
    return (Decimal(x) / Decimal(10000)).quantize(Decimal(1).scaleb(-nd), rounding=ROUND_HALF_UP)


def decimals(s: str) -> int:
    return len(s.split(".")[1]) if "." in s else 0


def read_csv(name: str) -> list[dict]:
    with open(TRUTH / name, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def cell_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    return str(v)


def find_header(ws, header: list[str]) -> int:
    for r in range(1, min(ws.max_row, 20) + 1):
        vals = [cell_str(ws.cell(row=r, column=c).value) for c in range(1, len(header) + 1)]
        if vals == header:
            return r
    return -1


def table_rows(ws, header_row: int, ncols: int) -> list[list[str]]:
    out = []
    r = header_row + 1
    while r <= ws.max_row:
        vals = [cell_str(ws.cell(row=r, column=c).value) for c in range(1, ncols + 1)]
        if all(v == "" for v in vals):
            break
        out.append(vals)
        r += 1
    return out


def all_cells_text(wb) -> list[str]:
    return [cell_str(c) for ws in wb.worksheets for row in ws.iter_rows(values_only=True) for c in row if c is not None]


def string_cells_text(wb) -> list[str]:
    """只取文本单元格(数字单元格不可能是代码,避免把 0.0092… 这类小数误判为编码)。"""
    return [c for ws in wb.worksheets for row in ws.iter_rows(values_only=True) for c in row if isinstance(c, str)]


def width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in s)


def pad(s: str, w: int) -> str:
    return s + " " * max(0, w - width(s))


def main() -> int:
    p = G.load_params()
    t = p["targets"]
    texts = p["texts"]
    cats = p["categories"]
    cat_ids = [c["id"] for c in cats]
    exc = read_csv("exceptions.csv")
    loss = read_csv("loss.csv")
    hv = read_csv("handler_volume.csv")
    intake = read_csv("intake_week.csv")
    ships = read_csv("shipments.csv")
    custs = read_csv("customers.csv")

    loss_by_wb: dict[str, int] = {}
    lines_by_wb: dict[str, int] = {}
    for x in loss:
        loss_by_wb[x["运单号"]] = loss_by_wb.get(x["运单号"], 0) + int(x["金额"])
        lines_by_wb[x["运单号"]] = lines_by_wb.get(x["运单号"], 0) + 1
    cnt = {c: sum(1 for r in exc if r["category"] == c) for c in cat_ids}
    cat_loss = {c: sum(loss_by_wb.get(r["运单号"], 0) for r in exc if r["category"] == c) for c in cat_ids}
    total_loss = sum(int(x["金额"]) for x in loss)
    key = [r for r in exc if r["customer_canon"] == G.KEY_CUSTOMER]
    key_hs = [r for r in key if r["category"] == "E_HS"]
    key_hs_loss = sum(loss_by_wb.get(r["运单号"], 0) for r in key_hs)
    key_insp = [r for r in key if r["发现环节"] == "海关查验"]
    new_names = {h["handler"] for h in hv if h["is_new_hire"] == "true"}
    new_exc = sum(1 for r in exc if r["经手人"] in new_names)
    vol_total = sum(int(h["vol_q3"]) for h in hv)
    new_vol = sum(int(h["vol_q3"]) for h in hv if h["is_new_hire"] == "true")
    fmt_tot = {f: sum(int(x["count"]) for x in intake if x["format"] == f) for f in p["intake_formats"]}
    intake_total = sum(fmt_tot.values())
    by_wb_ship = {s["waybill"]: s for s in ships}

    # ------------------------------------------------------------------ 幂等
    sec("幂等")

    def _idem():
        regenerated = G.build_all(p)
        diff = [n for n, b in regenerated.items() if not (TRUTH / n).exists() or (TRUTH / n).read_bytes() != b]
        check("重新生成 truth/* 与磁盘字节一致", "0 个差异", f"{len(diff)} 个差异 {diff}" if diff else "0 个差异", not diff)
    guarded("重新生成 truth/* 与磁盘字节一致", _idem)

    # ------------------------------------------------------------------ 件数与损失
    sec("件数与损失")
    check("异常表行数", p["error_log_total"], len(exc), len(exc) == p["error_log_total"])
    for c in cats:
        check(f"件数 {c['id']}", c["count"], cnt[c["id"]], cnt[c["id"]] == c["count"])
    for c in cats:
        check(f"损失 {c['id']}", c["loss"], cat_loss[c["id"]], cat_loss[c["id"]] == c["loss"])
    check("损失合计 loss.csv", p["loss_total"], total_loss, total_loss == p["loss_total"])
    exc_loss_sum = sum(int(r["loss"]) for r in exc)
    check("损失合计 exceptions.loss 列", p["loss_total"], exc_loss_sum, exc_loss_sum == p["loss_total"])
    bad = [r["运单号"] for r in exc if int(r["loss"]) != loss_by_wb.get(r["运单号"], 0)]
    check("每行 loss = 该运单 loss.csv 之和", "0 不符", f"{len(bad)} 不符", not bad)
    img = [r for r in exc if r["image_source"] == "true"]
    check("录入类图片来源件数", t["keyin_image"], sum(1 for r in img if r["category"] == "E_KEYIN"),
          len(img) == t["keyin_image"] and all(r["category"] == "E_KEYIN" for r in img))
    cue = {r["运单号"] for r in exc if r["category"] == "E_KEYIN" and any(w in r["异常描述"] for w in G.IMAGE_CUE_WORDS)}
    check("录入类描述含图片线索 ⇔ image_source", f"{t['keyin_image']} 且集合一致", len(cue),
          cue == {r["运单号"] for r in img})

    # ------------------------------------------------------------------ 描述口径(K5)
    sec("描述口径 K5")
    leaked = [r["异常描述"] for r in exc if any(ph in r["异常描述"] for ph in CATEGORY_PHRASES + cat_ids)]
    check("描述不含类别名原文/类别 id", 0, len(leaked), not leaked)
    for c in cat_ids:
        rs = [r for r in exc if r["category"] == c]
        tpls = {r["desc_tpl"] for r in rs}
        uniq = len({r["异常描述"] for r in rs}) / max(1, len(rs))
        check(f"{c} 模板数 / 描述去重率", "≥8 / ≥70%", f"{len(tpls)} / {uniq:.0%}", len(tpls) >= 8 and uniq >= 0.7)
    variants = ["改单没同步", "客户改了没跟", "按老箱数打的板"]
    found = [v for v in variants if any(v in r["异常描述"] for r in exc if r["category"] == "E_CHANGE")]
    check("同一根因多种说法(改单类示例)", len(variants), len(found), len(found) == len(variants))

    # ------------------------------------------------------------------ 拓浪
    sec("关键客户 拓浪")
    share = pct(len(key), len(exc))
    check("拓浪异常行数 / 占比", f"{t['key_rows']} / {t['key_share_pct']}%", f"{len(key)} / {share}%",
          len(key) == t["key_rows"] and share == t["key_share_pct"])
    hs_share = pct(len(key_hs), cnt["E_HS"])
    check("拓浪 HS 类件数 / 占 HS 比", f"{t['key_hs']} / 27%", f"{len(key_hs)} / {hs_share}%",
          len(key_hs) == t["key_hs"] and hs_share == 27)
    check("拓浪 HS 类损失", t["key_hs_loss"], key_hs_loss, key_hs_loss == t["key_hs_loss"])
    insp_months = sorted({r["日期"][5:7] for r in key_insp})
    insp_fee = [r for r in key_insp
                if any(x["运单号"] == r["运单号"] and x["费用类型"] == "查验费" for x in loss)]
    check("拓浪 Q3 海关查验(HS 类、各有查验费)", f"{t['key_inspections']} 次", f"{len(key_insp)} 次 月份{insp_months}",
          len(key_insp) == t["key_inspections"] and all(r["category"] == "E_HS" for r in key_insp)
          and len(insp_fee) == len(key_insp))
    alias_ok = all(r["客户"] == r["customer_canon"] or r["客户"] in
                   next(c["aliases"].split("|") for c in custs if c["customer"] == r["customer_canon"]) for r in exc)
    check("客户列只用正式名或登记过的简称", "全部", "全部" if alias_ok else "有未登记写法", alias_ok)
    check("拓浪简称都含「拓浪」(可按包含筛选)", "是", all("拓浪" in r["客户"] for r in key),
          all("拓浪" in r["客户"] for r in key))
    check("虚构客户数", "25–35", len(custs), 25 <= len(custs) <= 35)

    # ------------------------------------------------------------------ 经手人(RH1)
    sec("经手人 RH1")
    check("单证员人数", 14, len(hv), len(hv) == 14)
    tenure_ok = all((G.months_between(dt.date.fromisoformat(h["hire_date"]), G.REF_DATE) < G.NEW_HIRE_MONTHS)
                    == (h["is_new_hire"] == "true") for h in hv)
    check("新人人数(司龄<6个月,与入职日期一致)", t["new_hires"], len(new_names),
          len(new_names) == t["new_hires"] and tenure_ok)
    chen = next((h for h in hv if h["handler"] == "陈晓雯"), None)
    check("小陈=陈晓雯,约 2 年,非新人", "22–26 个月", chen["tenure_months"] if chen else "缺",
          chen is not None and 22 <= float(chen["tenure_months"]) <= 26 and chen["is_new_hire"] == "false")
    names = {h["handler"] for h in hv}
    check("异常经手人都在名单内", "全部", "全部" if all(r["经手人"] in names for r in exc) else "有缺",
          all(r["经手人"] in names for r in exc)
          and all((r["经手人"] in new_names) == (r["handler_is_new"] == "true") for r in exc))
    ne_pct = pct(new_exc, len(exc))
    check("新人经手异常", f"{t['new_hire_exceptions']}±1 / {t['new_hire_exception_pct']}%", f"{new_exc} / {ne_pct}%",
          abs(new_exc - t["new_hire_exceptions"]) <= 1 and ne_pct == t["new_hire_exception_pct"])
    check("Q3 票量合计", t["volume_q3"], vol_total, vol_total == t["volume_q3"])
    nv_pct = pct(new_vol, vol_total)
    check("新人经手票量", f"{t['new_hire_volume']}±10 / {t['new_hire_volume_pct']}%", f"{new_vol} / {nv_pct}%",
          abs(new_vol - t["new_hire_volume"]) <= 10 and nv_pct == t["new_hire_volume_pct"])
    months_ok = all(int(h["vol_jul"]) + int(h["vol_aug"]) + int(h["vol_sep"]) == int(h["vol_q3"]) for h in hv)
    exc_ok = all(int(h["exceptions_q3"]) == sum(1 for r in exc if r["经手人"] == h["handler"]) for h in hv)
    check("每人 7+8+9 月=Q3;异常数与登记表一致", "一致", "一致" if months_ok and exc_ok else "不一致", months_ok and exc_ok)

    # ------------------------------------------------------------------ 来料
    sec("近一周来料")
    for f, n in p["intake_formats"].items():
        check(f"来料 {f}", n, fmt_tot[f], fmt_tot[f] == n)
    check("来料合计", sum(p["intake_formats"].values()), intake_total, intake_total == 1512)

    # ------------------------------------------------------------------ 日期与运单号
    sec("日期与运单号")
    dates = [dt.date.fromisoformat(r["日期"]) for r in exc]
    check("异常日期都在 Q3", f"{G.Q3_START}..{G.Q3_END}", f"{min(dates)}..{max(dates)}",
          all(G.Q3_START <= d <= G.Q3_END for d in dates))
    exc_date = {r["运单号"]: r["日期"] for r in exc}
    bad_ld = [x for x in loss if not (G.Q3_START.isoformat() <= x["日期"] <= G.Q3_END.isoformat())
              or x["日期"] < exc_date.get(x["运单号"], "9999")]
    check("费用日期在 Q3 且不早于异常日期", 0, len(bad_ld), not bad_ld)
    wbs = [r["运单号"] for r in exc]
    check("异常运单号唯一且格式 LT26MM-NNNN", len(exc), len(set(wbs)),
          len(set(wbs)) == len(wbs) and all(WAYBILL_RE.match(w) for w in wbs))
    swbs = [s["waybill"] for s in ships]
    check("shipments 运单号唯一且格式正确", len(ships), len(set(swbs)),
          len(set(swbs)) == len(swbs) and all(WAYBILL_RE.match(w) for w in swbs))
    overlap = set(wbs) & set(swbs)
    check("异常表运单号与 shipments 不重叠", 0, len(overlap), not overlap)

    # ------------------------------------------------------------------ 线索票
    sec("线索票(A1/X4)")
    check("shipments 票数", "约 60", len(ships), 55 <= len(ships) <= 65)
    s = by_wb_ship.get("LT2609-0387", {})
    check("LT2609-0387 发票件数 / 装箱单件数", "1200 / 1150", f"{s.get('inv_pieces')} / {s.get('pieces')}",
          s.get("inv_pieces") == "1200" and s.get("pieces") == "1150" and "P7" in s.get("clue_ids", ""))
    s = by_wb_ship.get("LT2609-0412", {})
    check("LT2609-0412 装箱单版本/箱数 vs 提单箱数", "改2/46 vs 40",
          f"{s.get('pl_version')}/{s.get('cartons')} vs {s.get('bl_cartons')}",
          s.get("pl_version") == "改2" and s.get("cartons") == "46" and s.get("bl_cartons") == "40"
          and "P4" in s.get("clue_ids", ""))
    batt = [s for s in ships if "P5" in s["clue_ids"]]
    check("带电产品 + 笼统申报品名", "1 票", f"{len(batt)} 票 {[b['declared_name'] for b in batt]}",
          len(batt) == 1 and batt[0]["battery"] == "是" and batt[0]["declared_name"] in G.VAGUE_DECLARED_NAMES
          and "电池" in batt[0]["invoice_desc"])
    x4 = [s for s in ships if s["x4_sample"] == "true"]

    def mismatch(s):
        return (s["inv_pieces"] != s["pieces"] or s["bl_cartons"] != s["cartons"]
                or abs(float(s["bl_gross_kg"]) - float(s["gross_weight_kg"])) > 0.05)
    flagged = {s["waybill"] for s in ships if s["x4_issue"]}
    computed = {s["waybill"] for s in ships if mismatch(s)}
    stages = [s["x4_caught_stage"] for s in x4 if s["x4_issue"]]
    check("X4 抽样/不一致/出货前/报关环节", "30/7/5/2",
          f"{len(x4)}/{len(flagged)}/{stages.count('出货前')}/{stages.count('报关环节')}",
          len(x4) == 30 and len(flagged) == 7 and stages.count("出货前") == 5 and stages.count("报关环节") == 2
          and flagged <= {s["waybill"] for s in x4})
    check("字段不一致的票 = 标注的 7 票(含 0387、0412)", "一致", "一致" if computed == flagged else
          sorted(computed ^ flagged), computed == flagged and {"LT2609-0387", "LT2609-0412"} <= flagged)
    docs = [d for s in ships if s["a1_docs"] for d in s["a1_docs"].split("|")]
    n_img = sum(1 for d in docs if d.split(":")[1] in ("照片", "扫描件", "手写"))
    check("A1 样本包计划 份数/图片类", "14 / 9", f"{len(docs)} / {n_img}", len(docs) == 14 and n_img == 9)

    # ------------------------------------------------------------------ 费用对齐
    sec("费用与异常对齐")
    yes = {r["运单号"] for r in exc if r["是否产生费用"] == "是"}
    no = {r["运单号"] for r in exc if r["是否产生费用"] == "否"}
    check("「是否产生费用」只有 是/否", len(exc), len(yes) + len(no), len(yes) + len(no) == len(exc))
    lw = set(loss_by_wb)
    check("loss.csv 运单号 ⊆ 异常表且=是", 0, len(lw - yes), lw <= yes)
    check("每个「是」至少一笔费用", 0, len(yes - lw), yes == lw)
    check("「否」的 loss 都为 0", 0, sum(1 for r in exc if r["运单号"] in no and int(r["loss"]) != 0),
          all(int(r["loss"]) == 0 for r in exc if r["运单号"] in no))
    amts = [int(x["金额"]) for x in loss]
    check("金额为 50 的倍数且 >0", "全部", f"{sum(1 for a in amts if a % 50 or a <= 0)} 不合规",
          all(a > 0 and a % 50 == 0 for a in amts))
    check("费用类型在财务口径内", "/".join(G.FEE_TYPES), sorted({x["费用类型"] for x in loss}),
          {x["费用类型"] for x in loss} <= set(G.FEE_TYPES))
    check("每个运单 1–3 笔费用", "1–3", f"{min(lines_by_wb.values())}–{max(lines_by_wb.values())}",
          1 <= min(lines_by_wb.values()) and max(lines_by_wb.values()) <= 3)
    canon = {r["运单号"]: r["customer_canon"] for r in exc}
    check("loss.csv 客户 = 异常表客户(正式名)", "一致", "一致" if all(canon[x["运单号"]] == x["客户"] for x in loss)
          else "不一致", all(canon[x["运单号"]] == x["客户"] for x in loss))

    # ------------------------------------------------------------------ A2
    sec("资料 A2 异常登记表")

    def _a2():
        wb = load_workbook(A2, read_only=False)
        check("A2 工作表", "异常登记, 经手票量", ", ".join(wb.sheetnames), wb.sheetnames == ["异常登记", "经手票量"])
        ws = wb["异常登记"]
        hr = find_header(ws, G.VISIBLE_COLUMNS)
        hdr_full = [cell_str(ws.cell(row=hr, column=c).value) for c in range(1, ws.max_column + 1)] if hr > 0 else []
        check("A2 表头恰为 8 个可见列", "|".join(G.VISIBLE_COLUMNS), "|".join(h for h in hdr_full if h),
              hr > 0 and [h for h in hdr_full if h] == G.VISIBLE_COLUMNS and ws.max_column == 8)
        rows = table_rows(ws, hr, 8)
        check("A2 数据行数", len(exc), len(rows), len(rows) == len(exc))
        expect = [[r[c] for c in G.VISIBLE_COLUMNS] for r in sorted(exc, key=lambda r: (r["日期"], r["运单号"]))]
        check("A2 内容 = exceptions.csv 可见列(按日期排序)", "逐行一致", "一致" if rows == expect else "不一致",
              rows == expect)
        text = all_cells_text(wb)
        hits = sorted({tok for tok in HIDDEN_TOKENS if any(tok in s for s in text)})
        hits += ["loss"] if any(s.strip().lower() == "loss" for s in text) else []
        check("A2 不含任何真值列/真值词", "无", hits or "无", not hits)
        lossv = {str(int(r["loss"])) for r in exc if int(r["loss"]) > 0}
        num_cells = {cell_str(c) for row in ws.iter_rows(min_row=hr + 1, values_only=True) for c in row
                     if isinstance(c, (int, float))}
        check("A2「异常登记」没有金额数字列", "无数字单元格", len(num_cells), not (num_cells & lossv) and not num_cells)
        ws2 = wb["经手票量"]
        hcols = ["经手人", "入职时间", "7月", "8月", "9月", "Q3合计"]
        hr2 = find_header(ws2, hcols)
        rows2 = table_rows(ws2, hr2, 6)
        body = [r for r in rows2 if r[0] != "合计"]
        exp2 = [[h["handler"], h["hire_date"][:7], h["vol_jul"], h["vol_aug"], h["vol_sep"], h["vol_q3"]] for h in hv]
        tot = next((r for r in rows2 if r[0] == "合计"), None)
        check("A2「经手票量」= handler_volume.csv,合计 19800", t["volume_q3"], tot[5] if tot else "缺",
              body == exp2 and tot is not None and int(tot[5]) == t["volume_q3"])
        for wsx in wb.worksheets:
            check(f"A2「{wsx.title}」有合成标识", "有", "有" if any(MARK in s for s in
                  [cell_str(c) for row in wsx.iter_rows(values_only=True) for c in row]) else "无",
                  any(MARK in cell_str(c) for row in wsx.iter_rows(values_only=True) for c in row))
    guarded("A2 检查", _a2)

    # ------------------------------------------------------------------ A4
    sec("资料 A4 财务费用")

    def _a4():
        wb = load_workbook(A4)
        check("A4 工作表", "汇总, 明细", ", ".join(wb.sheetnames), wb.sheetnames == ["汇总", "明细"])
        ws = wb["汇总"]
        hcols = ["费用类型", "7月", "8月", "9月", "合计", "笔数", "占比"]
        hr = find_header(ws, hcols)
        rows = table_rows(ws, hr, 7)
        labels = [r[0] for r in rows]
        check("「汇总」按费用类型(不按原因)", "/".join(G.FEE_TYPES) + "/合计", "/".join(labels),
              labels == G.FEE_TYPES + ["合计"])
        tot = next(r for r in rows if r[0] == "合计")
        check("「汇总」合计", p["loss_total"], tot[4], int(tot[4]) == p["loss_total"])
        per = {r[0]: int(r[4]) for r in rows if r[0] != "合计"}
        exp = {ft: sum(int(x["金额"]) for x in loss if x["费用类型"] == ft) for ft in G.FEE_TYPES}
        check("「汇总」各费用类型 = loss.csv", "一致", "一致" if per == exp else per, per == exp)
        text = all_cells_text(wb)
        cause_hits = sorted({tok for tok in HIDDEN_TOKENS + CATEGORY_PHRASES + ["资料矛盾", "改单未同步", "HS 与申报"]
                             if any(tok in s for s in text)})
        check("A4 不出现原因分类", "无", cause_hits or "无", not cause_hits)
        ws2 = wb["明细"]
        hr2 = find_header(ws2, G.LOSS_COLUMNS)
        rows2 = table_rows(ws2, hr2, 6)
        exp2 = [[x[c] for c in G.LOSS_COLUMNS] for x in loss]
        check("「明细」= loss.csv(逐笔)", len(loss), len(rows2), rows2 == exp2)
        s2 = sum(int(r[4]) for r in rows2)
        check("「明细」金额合计", p["loss_total"], s2, s2 == p["loss_total"])
        # X3 经由资料还原:A4 明细 × A2(按运单号)→ 真值类别
        a2_wb = load_workbook(A2)
        a2_rows = table_rows(a2_wb["异常登记"], find_header(a2_wb["异常登记"], G.VISIBLE_COLUMNS), 8)
        a2_wbs = {r[1]: r for r in a2_rows}
        cat_of = {r["运单号"]: r["category"] for r in exc}
        joined: dict[str, int] = {}
        missing = 0
        for r in rows2:
            if r[1] not in a2_wbs or a2_wbs[r[1]][7] != "是":
                missing += 1
                continue
            joined[cat_of[r[1]]] = joined.get(cat_of[r[1]], 0) + int(r[4])
        exp3 = {c["id"]: c["loss"] for c in cats}
        check("A4×A2 按运单号对上后各类损失(X3)", "与设定一致", "一致" if joined == exp3 and not missing
              else f"{joined} 缺{missing}", joined == exp3 and missing == 0)
        key_wbs = {r["运单号"] for r in key_hs}
        kl = sum(int(r[4]) for r in rows2 if r[1] in key_wbs)
        check("A4×A2 拓浪 HS 损失(X5)", t["key_hs_loss"], kl, kl == t["key_hs_loss"])
        kinsp = {r["运单号"] for r in key_insp}
        n_insp_fee = sum(1 for r in rows2 if r[1] in kinsp and r[3] == "查验费")
        check("A4「明细」拓浪查验费笔数(S2)", t["key_inspections"], n_insp_fee, n_insp_fee == t["key_inspections"])
        for wsx in wb.worksheets:
            check(f"A4「{wsx.title}」有合成标识", "有", "有" if any(MARK in cell_str(c) for row in
                  wsx.iter_rows(values_only=True) for c in row) else "无",
                  any(MARK in cell_str(c) for row in wsx.iter_rows(values_only=True) for c in row))
    guarded("A4 检查", _a4)

    # ------------------------------------------------------------------ A5
    sec("资料 A5 来料统计")

    def _a5():
        wb = load_workbook(A5)
        ws = wb["来料统计"]
        hr = find_header(ws, ["星期", "渠道", "Excel", "电子PDF", "图片/扫描件", "合计"])
        rows = table_rows(ws, hr, 6)
        tot = next(r for r in rows if r[0] == "合计")
        got = (int(tot[2]), int(tot[3]), int(tot[4]), int(tot[5]))
        exp = (p["intake_formats"]["xlsx"], p["intake_formats"]["pdf"], p["intake_formats"]["image"], 1512)
        check("A5 Excel/PDF/图片/合计", "/".join(map(str, exp)), "/".join(map(str, got)), got == exp)
        check("A5 有合成标识", "有", "有" if MARK in all_cells_text(wb) else "无", MARK in all_cells_text(wb))
    guarded("A5 检查", _a5)

    # ------------------------------------------------------------------ YAML 文字结论复算
    sec("复算 YAML 文字结论")

    def _yaml():
        x2 = dict(re.findall(r"(资料矛盾|改单未同步|HS 与申报|录入手误|缺资料|其他)\s*(\d+)", texts["X2"]))
        x2c = {G.CATEGORY_LABELS["X2"][k]: int(v) for k, v in x2.items()}
        img_n = int(re.search(r"图片来源\s*(\d+)", texts["X2"]).group(1))
        check("X2 各类件数", x2c, cnt, x2c == cnt and len(x2c) == 6)
        check("X2 录入类图片来源", img_n, len(img), img_n == len(img))
        x3 = re.findall(r"(HS 与申报|改单|资料矛盾|缺资料|录入|其他)\s*([\d.]+)\s*万", texts["X3"])
        ok3, got3 = len(x3) == 6, {}
        for label, v in x3:
            cid = G.CATEGORY_LABELS["X3"][label]
            got3[label] = f"{wan(cat_loss[cid], decimals(v))}万"
            ok3 &= wan(cat_loss[cid], decimals(v)) == Decimal(v)
        check("X3 各类损失(万)", "21.2/14.85/6.18/3.86/2.74/0.97", "/".join(got3.values()), ok3)
        rank_cnt = sorted(cat_ids, key=lambda c: -cnt[c])
        rank_loss = sorted(cat_ids, key=lambda c: -cat_loss[c])
        check("X3 件数排序 ≠ 金额排序", "不同", f"{rank_cnt[0]} vs {rank_loss[0]}",
              rank_cnt != rank_loss and "排序不一样" in texts["X3"])
        m = re.search(r"占全部异常的\s*(\d+)%.*?HS 与申报类的\s*(\d+)%\s*[((](\d+)\s*件[))].*?对应损失\s*([\d.]+)\s*万",
                      texts["X5"])
        v = (int(m.group(1)), int(m.group(2)), int(m.group(3)), Decimal(m.group(4)))
        a = (int(pct(len(key), len(exc))), int(pct(len(key_hs), cnt["E_HS"])), len(key_hs),
             wan(key_hs_loss, decimals(m.group(4))))
        check("X5 拓浪 占比/HS占比/HS件数/损失万", "/".join(map(str, v)), "/".join(map(str, a)), v == a)
        m = re.search(r"共\s*(\d+)\s*条", texts["P1"])
        check("P1 登记表条数", m.group(1), len(exc), int(m.group(1)) == len(exc))
        p2 = re.findall(r"(资料矛盾|改单未同步|HS 与申报|录入手误)\s*(\d+)%", texts["P2"])
        p2a = {k: int(pct(cnt[G.CATEGORY_LABELS["X2"][k]], len(exc))) for k, _ in p2}
        check("P2 件数占比", {k: int(v) for k, v in p2}, p2a, len(p2) == 4 and all(p2a[k] == int(v) for k, v in p2))
        p3 = [int(x) for x in re.findall(r"(\d+)%", texts["P3"])]
        p3a = [int(pct(fmt_tot[f], intake_total)) for f in ("xlsx", "pdf", "image")]
        check("P3 来料格式占比", p3, p3a, p3 == p3a)
        m = re.search(r"约\s*([\d.]+)\s*万", texts["C2"])
        check("C2 直接损失(万)", m.group(1), wan(total_loss, decimals(m.group(1))),
              wan(total_loss, decimals(m.group(1))) == Decimal(m.group(1)))
        c3 = re.findall(r"([\d.]+)\s*万[,,]\s*(\d+)%", texts["C3"])
        c3a = [(str(wan(cat_loss["E_HS"], decimals(c3[0][0]))), int(pct(cat_loss["E_HS"], total_loss))),
               (str(wan(cat_loss["E_CHANGE"], decimals(c3[1][0]))), int(pct(cat_loss["E_CHANGE"], total_loss)))]
        m = re.search(r"录入类只有\s*([\d.]+)\s*万", texts["C3"])
        ok_c3 = [(a, int(b)) for a, b in c3] == c3a and wan(cat_loss["E_KEYIN"], decimals(m.group(1))) == Decimal(m.group(1))
        check("C3 HS/改单 金额与占比、录入金额", f"{c3} {m.group(1)}万", f"{c3a} {wan(cat_loss['E_KEYIN'], 2)}万", ok_c3)
        t1 = re.findall(r"([\d.]+)%", texts["T1"])
        t1a = [str(pct(cnt["E_KEYIN"], len(exc), decimals(t1[0]))), str(pct(cat_loss["E_KEYIN"], total_loss,
               decimals(t1[1]))), str(pct(fmt_tot["image"], intake_total, decimals(t1[2])))]
        check("T1 录入件数%/损失%/图片来料%", t1, t1a, t1 == t1a)
        t2 = int(re.search(r"(\d+)%", texts["T2"]).group(1))
        check("T2 矛盾+改单件数占比", t2, pct(cnt["E_INCONSIST"] + cnt["E_CHANGE"], len(exc)),
              pct(cnt["E_INCONSIST"] + cnt["E_CHANGE"], len(exc)) == t2)
        t3 = int(re.search(r"(\d+)%", texts["T3"]).group(1))
        check("T3 HS 类金额占比", t3, pct(cat_loss["E_HS"], total_loss), pct(cat_loss["E_HS"], total_loss) == t3)
        m = re.search(r"(\d+)\s*个新人经手\s*(\d+)%\s*的票、占\s*(\d+)%\s*的异常", texts["RH1"])
        rh = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        rha = (len(new_names), int(pct(new_vol, vol_total)), int(pct(new_exc, len(exc))))
        check("RH1 新人数/票量%/异常%", rh, rha, rh == rha)
        m = re.search(r"Q3\s*(.)次", texts["S2"])
        check("S2 拓浪 Q3 查验次数", m.group(1), len(key_insp), G.CN_NUM.get(m.group(1)) == len(key_insp))
        x4n = [int(x) for x in re.findall(r"(\d+)\s*票", texts["X4"])]
        x4a = [len(x4), len(flagged), stages.count("出货前"), stages.count("报关环节")]
        check("X4 抽样结论", x4n, x4a, x4n == x4a)
        clues = " ".join(texts["A1_clues"])
        m1 = re.search(r"LT2609-0387 发票 (\d+) 件、装箱单 (\d+) 件", clues)
        m2 = re.search(r"LT2609-0412 装箱单有「(改\d)」版 (\d+) 箱,提单仍是 (\d+) 箱", clues)
        m3 = re.search(r"(\d+) 份里 (\d+) 份是照片或扫描件", clues)
        s1, s2_ = by_wb_ship["LT2609-0387"], by_wb_ship["LT2609-0412"]
        ok = (m1 and (m1.group(1), m1.group(2)) == (s1["inv_pieces"], s1["pieces"])
              and m2 and (m2.group(1), m2.group(2), m2.group(3)) == (s2_["pl_version"], s2_["cartons"], s2_["bl_cartons"])
              and m3 and (int(m3.group(1)), int(m3.group(2))) == (len(docs), n_img))
        check("A1 线索文本 vs shipments.csv", "0387/0412/14份9份", "一致" if ok else "不一致", bool(ok))
    guarded("YAML 文字结论", _yaml)

    # ------------------------------------------------------------------ 合规
    sec("合规(虚构与标识)")

    def _compliance():
        blobs = []
        for f in sorted(TRUTH.glob("*")):
            blobs.append((f.name, f.read_text(encoding="utf-8")))
        for x in (A2, A4, A5):
            blobs.append((x.name, "\n".join(string_cells_text(load_workbook(x)))))
        blobs.append((MANIFEST.name, MANIFEST.read_text(encoding="utf-8")))
        hits = []
        for name, txt in blobs:
            hits += [f"{name}:{w}" for w in REAL_ENTITIES_CN if w in txt]
            hits += [f"{name}:{w}" for w in REAL_ENTITIES_EN if re.search(rf"(?<![A-Za-z]){w}(?![A-Za-z])", txt)]
        check("无真实主体名称(黑名单)", "0 命中", hits or "0 命中", not hits)
        code_hits = [f"{n}:{m}" for n, txt in blobs for m in USCC_RE.findall(txt) + HS10_RE.findall(txt)]
        check("无形似真实的信用代码/10 位海关编码", "0 命中", code_hits[:5] or "0 命中", not code_hits)
        check("关键客户名与 YAML 一致(拓浪科技(虚构))", p["key_customer"]["name"], G.KEY_CUSTOMER,
              G.KEY_CUSTOMER in p["key_customer"]["name"])
    guarded("合规检查", _compliance)

    # ------------------------------------------------------------------ 清单
    sec("清单 manifest")

    def _manifest():
        m = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
        ids = [a["id"] for a in m["artifacts"]]
        check("manifest 含 A2/A4/A5", "A2, A4, A5", ", ".join(ids), ids == ["A2", "A4", "A5"])
        bad, n = [], 0
        for a in m["artifacts"]:
            for f in a["files"]:
                if f.get("status") == "pending":
                    continue
                n += 1
                fp = G.SCENARIO_DIR / f["path"]
                if not fp.exists() or hashlib.sha256(fp.read_bytes()).hexdigest() != f["sha256"]:
                    bad.append(f["path"])
        check("manifest 文件存在且 sha256 匹配", f"{n} 个", f"{n - len(bad)} 个匹配", not bad)
        allowed = {"fact", "experiment", "where", "waybill", "note"}
        extra = [k for a in m["artifacts"] for c in a["clues"] for k in c if k not in allowed]
        extra += [k for c in m["pending"][0]["clues"] for k in c if k not in allowed]
        check("manifest 线索条目无未定义键(防逗号截断)", "0", len(extra), not extra)
        j = m["joins"][0]["expected_loss_by_cause"]
        check("manifest 预期各类损失 = 设定", "一致", "一致" if all(j[c["id"]]["loss"] == c["loss"] and
              j[c["id"]]["count"] == c["count"] for c in cats) else j,
              all(j[c["id"]]["loss"] == c["loss"] and j[c["id"]]["count"] == c["count"] for c in cats))
    guarded("manifest 检查", _manifest)

    # ------------------------------------------------------------------ 输出
    w_name = max(width(r[1]) for r in results) + 2
    w_exp = min(36, max(width(r[2]) for r in results) + 2)
    print(f"params source: {p['source']}")
    print(pad("#", 4) + pad("检查项", w_name) + pad("期望", w_exp) + pad("实际", w_exp) + "结果")
    cur = None
    for i, (s_, name, exp, act, ok) in enumerate(results, start=1):
        if s_ != cur:
            print(f"── {s_} " + "─" * 40)
            cur = s_
        e = exp if width(exp) <= w_exp - 2 else exp[: max(8, (w_exp - 4) // 2)] + "…"
        a = act if width(act) <= w_exp - 2 else act[: max(8, (w_exp - 4) // 2)] + "…"
        print(pad(str(i), 4) + pad(name, w_name) + pad(e, w_exp) + pad(a, w_exp) + ("PASS" if ok else "FAIL"))
    n_fail = sum(1 for r in results if not r[4])
    print(f"\n{len(results) - n_fail}/{len(results)} PASS" + (f",{n_fail} FAIL" if n_fail else ""))
    if n_fail:
        print("\n失败项详情:")
        for s_, name, exp, act, ok in results:
            if not ok:
                print(f"  [{s_}] {name}\n    期望:{exp}\n    实际:{act}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
