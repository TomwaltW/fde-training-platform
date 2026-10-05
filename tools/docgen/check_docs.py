#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_docs.py —— 合成单据(A1/A3/A5/A6/A7/A8)自检(方案 4.1 步骤 8 + 8.2 标识)。

逐项打印 PASS/FAIL 表,任何一项失败即以非零状态退出。检查范围:
  · 文件:每份资料的文件数与类型(A1 14 份且 9 份图片、A3 1、A5 png 1、A6 3、A7 ≥2 且含 xlsx、A8 2);
    文件名按 scenario.yaml 的 files 解析(与引擎 artifactFiles() 同一规则);目录里没有多余或缺失的文件
  · 标识:每张图片 ≤ 1.5 MB、右下角显式标识(按像素核对)、隐式标识(PNG tEXt/iTXt AIGC、JPEG EXIF);
    PDF 元数据 Subject 与页面标识;xlsx 工作簿属性与单元格标识
  · 清单:manifest 覆盖全部文件、sha256 一致、没有 pending;刷新清单只重算本次渲染了的单据的 source_sha256
    (render_xlsx.py 刷新清单不会洗白没重渲染的图片);A1 三条线索(P7/P4/P5)各至少落在一份文件上;
    A1 的组成与 shipments.csv 的 a1_docs 计划一致;劣化参数在要求范围内
  · 数字:由本脚本独立地从 truth/*.csv 推出每份文件应显示的数字,与 manifest 里的 numbers、
    以及文件里实际渲染出的文字(PDF 抽文字、xlsx 读单元格、图片读渲染所用 HTML 并核对其 sha256)逐一比对
  · 合规:无真实主体名称、无形似真实的信用代码/海关编码、HS 编码只用占位符、邮箱用 .example;
    公司/产品名带「虚构」:逐份扫描单据上实际出现的文字(不是只看 docs_spec 的常量),每个客户/供应商名称的出现
    都要带「(虚构)/(FICTITIOUS)」;截图/照片里的圈内简称(群名、昵称、聊天、称呼、小抄、手写栏等)走显式白名单
    BARE_NAME_ALLOW,且只允许用在带「合成样本·训练用」标识牌的图片上
"""
from __future__ import annotations

import csv
import hashlib
import html as htmllib
import re
import sys
import unicodedata
from decimal import Decimal, InvalidOperation
from pathlib import Path

import numpy as np
import yaml
from openpyxl import load_workbook
from PIL import Image
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_truth as CT  # noqa: E402  复用真实主体黑名单与编码正则
import degrade as D  # noqa: E402
import docs_spec as S  # noqa: E402
import gen_truth as G  # noqa: E402
import manifest as M  # noqa: E402

SCN = G.SCENARIO_DIR
ART = SCN / "artifacts"
MANIFEST = ART / "manifest.yaml"
LABEL = "合成样本·训练用"
MARK = "合成样本·训练用 · 公司与数据均为虚构"
KIND = {".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".pdf": "pdf", ".xlsx": "xlsx"}
DOC_ARTS = ["A1", "A3", "A5", "A6", "A7", "A8"]
REQUIRED_EFFECTS = ["旋转", "透视变形", "模糊", "JPEG 压缩", "不均匀光照", "折痕", "桌面背景", "水印"]
HS_PLACEHOLDER_RE = re.compile(r"XXXX\.XX-\d{2}")
HS_DOTTED_RE = re.compile(r"(?<![\d.])\d{4}\.\d{2}\.\d{2,4}(?![\d.])")          # 形如 8507.60.0090
HS_DIGITS_RE = re.compile(r"(?<![0-9A-Za-z-])\d{8,10}(?![0-9])")                # 8–10 位连续数字
NUM_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")

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


def read_csv(name: str) -> list[dict]:
    with open(G.TRUTH_DIR / name, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def numbers_in(text: str) -> set[Decimal]:
    out = set()
    for m in NUM_RE.findall(text):
        try:
            out.add(Decimal(m.replace(",", "")))
        except InvalidOperation:
            pass
    return out


def has(txt: str, s: str) -> bool:
    """忽略空白的包含判断(PDF 抽出的文字会在中英文之间、标点两侧插空格)。"""
    return re.sub(r"\s+", "", s) in re.sub(r"\s+", "", txt)


def html_text(html: str) -> str:
    """HTML → 页面上看得见的纯文字:去掉样式和 <title>(不渲染进截图);行内 span(手写体逐字拆开的)直接拼回,
    其余标签换成空格。"""
    s = re.sub(r"<style.*?</style>|<title>.*?</title>", " ", html, flags=re.S)
    s = re.sub(r"</?span[^>]*>", "", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", htmllib.unescape(s))


def pdf_text(path: Path) -> str:
    return "\n".join(p.extract_text() or "" for p in PdfReader(path).pages)


def xlsx_text(path: Path) -> str:
    wb = load_workbook(path)
    parts = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            for v in row:
                if v is not None:
                    parts.append(str(v))
    return "\n".join(parts)


def scenario_files(scen: dict) -> dict[str, list[Path]]:
    """与 packages/engine/src/view.ts 的 artifactFiles() 同一规则:目录通配取非 . 开头的普通文件,否则精确路径。"""
    out = {}
    for a in scen["artifacts"]:
        pat = a["files"]
        if pat.endswith("/*"):
            d = SCN / pat[:-2]
            out[a["id"]] = sorted(p for p in d.iterdir() if p.is_file() and not p.name.startswith(".")) if d.exists() else []
        else:
            p = SCN / pat
            out[a["id"]] = [p] if p.is_file() else []
    return out


# ---------------------------------------------------------------------------
# 公司/产品名的「虚构」标记:逐份扫描单据上实际出现的文字(PDF 抽文字、xlsx 单元格、图片渲染所用 HTML 的可见文字)
# ---------------------------------------------------------------------------
MARKER_RE = r"\s*[((]\s*(?:虚\s*构|FICTITIOUS)\s*[))]"
# 虚构的货代、报关行、承运人、OCR 厂商及其产品、FMS 的名称核心词;客户的核心词由 truth/customers.csv 推出
# (全称、别名、前两个字)和 docs_spec.CUSTOMER_PROFILE 的英文名首词。docs_spec 里每个主体常量都必须含其中一个核心词,
# 否则改了名字扫描就会漏(「主体常量」那一项会报出来)。
VENDOR_CORES = ("澜途", "LANTU", "恒通", "鸿屿", "HONGYU", "识图云", "票据识别助手", "运链通")
# 圈内简称白名单:只给截图/照片里「写成(虚构)反而一眼假」的地方——微信群名与群昵称、聊天正文、邮件称呼与文件夹名、
# 个人小抄、手写栏、软件界面里厂商的自称、品牌字标、船名。这些文件都是图片,右下角有不透明的「合成样本·训练用」标识牌
# (「图片右下角显式标识」一项按像素核对),白名单那一项也会要求它们通过了像素核对。
# 键:资料/文件名;值:(允许不带标记出现的名称核心词, 原因)。条目必须用得上,用不上的也算失败,保持白名单最小。
BARE_NAME_ALLOW: dict[str, tuple[frozenset[str], str]] = {
    "A1/LT2609-0412_bill-of-lading_scan.jpg": (
        frozenset({"HONGYU"}), "船名 HONGYU PIONEER(船名不是公司名);同一张提单抬头印着 HONGYU LINE (FICTITIOUS)"),
    "A1/LT2609-0446_invoice_photo.jpg": (
        frozenset({"TUOLANG"}), "发票抬头的品牌字标 TUOLANG;紧挨着印着 TUOLANG TECH (FICTITIOUS)"),
    "A1/LT2609-2589_invoice_handwritten.jpg": (
        frozenset({"稻禾健康"}), "手写单「客户:」栏的手写字;同一张单据印着「稻禾健康(虚构) · 手写单据(合成样本)」"),
    "A1/LT2609-2589_packing-list_handwritten.jpg": (
        frozenset({"稻禾健康"}), "手写单「客户:」栏的手写字;同一张单据印着「稻禾健康(虚构) · 手写单据(合成样本)」"),
    "A3/cheatsheet.png": (
        frozenset({"拓浪", "青禾", "栖木", "稻禾", "野径", "星渚", "鲸帆", "砚舟", "栗壳", "雀屏", "橡山"}),
        "小陈个人 Excel 小抄里的客户简称列"),
    "A6/01_group-chat_LT2609-0412.png": (
        frozenset({"栖木家居", "栖木", "澜途"}), "微信群名「栖木家居 × 澜途 出货对接群」与群昵称「栖木-阿May」"),
    "A6/02_warehouse-chat_LT2609-0412.png": (
        frozenset({"栖木", "澜途"}), "群名「澜途操作部 × 仓库 对接群」、群昵称「澜途操作部-刘」、聊天里的「栖木的折叠凳」"),
    "A6/03_email-to-broker_LT2609-0412.png": (
        frozenset({"栖木", "恒通"}), "邮箱文件夹名「客户-栖木」与邮件开头的称呼「恒通单证组好」"),
    "A7/fms_order-entry.png": (
        frozenset({"运链通"}), "系统界面提示「请联系运链通客户经理」(厂商自称);同一界面标题栏印着「运链通 FMS(虚构)」"),
}
NAME_FILL = "〇"   # 掩掉已核对过的片段;不出现在任何名称里


def _loose(name: str) -> str:
    """名称 → 正则:字与字之间允许空白(PDF 抽出的文字会在中英文之间、标点两侧插空格)。"""
    return r"\s*".join(re.escape(ch) for ch in name if not ch.isspace())


def _mask(s: str, pattern: str, flags: int = 0) -> str:
    return re.sub(pattern, lambda m: NAME_FILL * len(m.group()), s, flags=flags)


def entity_constants() -> list[str]:
    """docs_spec 里写到单据上的虚构主体全称(都应带「(虚构)/(FICTITIOUS)」)。"""
    return [S.FORWARDER["cn"], S.FORWARDER["en"], S.FORWARDER["short"], S.BROKER["cn"], S.CARRIER["cn"], S.CARRIER["en"],
            S.OCR_VENDOR["cn"], S.OCR_VENDOR["product"], S.FMS] + \
        [v for p in S.CUSTOMER_PROFILE.values() for v in (p["cn"], p["en"])]


def fictional_names(customers: dict[str, dict]) -> tuple[list[str], list[str]]:
    """(名称全称:后面紧跟标记就算已标注;名称核心词:掩掉已标注的全称后还出现就是没标注),都按长度从长到短。"""
    bases = {re.sub(MARKER_RE, "", c).strip() for c in entity_constants()}
    cores = set(VENDOR_CORES) | {p["en"].split(" ")[0] for p in S.CUSTOMER_PROFILE.values()}
    for c, row in customers.items():
        names = {c, c[:2], *(a for a in row["aliases"].split("|") if a)}
        bases |= names
        cores |= names
    by_len = lambda xs: sorted(xs, key=lambda x: (-len(x), x))  # noqa: E731
    return by_len(bases), by_len(cores)


def unmarked_names(txt: str, bases: list[str], cores: list[str]) -> list[tuple[str, str]]:
    """一份单据文字里没带「虚构」标记的名称出现:[(核心词, 上下文)]。

    先掩掉邮箱与 .example 域名(由「邮箱只用保留域名」一项单独查),再掩掉「全称 + (虚构)/(FICTITIOUS)」
    (全称内部允许 PDF 插进来的空白;英文全称后允许跟最多 3 个大写词再接标记,如 QIMU HOME US STORE (FICTITIOUS)),
    剩下的核心词逐个报出。核心词按原样匹配(不跨空白:截图与表格里空白是单元格分界,跨过去会把「野径」+「户外头灯」
    误拼成「野径户外」);PDF 把全称拆开时,两个字的简称核心词照样能抓到。"""
    s = _mask(txt, r"[A-Za-z0-9._-]+@[A-Za-z0-9.-]+|[A-Za-z0-9-]+\.example\b")
    for b in bases:
        tail = r"(?:\s+[A-Z][A-Za-z.&'-]*){0,3}" if b.isascii() else ""
        s = _mask(s, _loose(b) + tail + MARKER_RE)
    hits = []
    for c in cores:
        if c.isascii():
            pat, flags = rf"(?<![A-Za-z]){re.escape(c)}(?![A-Za-z])", re.I
        else:
            pat, flags = re.escape(c), 0
        spans = [m.span() for m in re.finditer(pat, s, flags)]
        hits += [(c, re.sub(r"\s+", " ", txt[max(0, a - 8): b + 8]).strip()) for a, b in spans]
        s = _mask(s, pat, flags)
    return hits


def width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in s)


def pad(s: str, w: int) -> str:
    return s + " " * max(0, w - width(s))


# ---------------------------------------------------------------------------
# 由真值独立推出「每份文件应该显示的数字」(不经过 docs_spec 的取数逻辑)
# ---------------------------------------------------------------------------
def expected_numbers(ships: dict, prods: dict, lines: list[dict], facts: dict, intake: list[dict]) -> dict:
    exp: dict[str, dict] = {}
    plan = []
    for wb in sorted(ships):
        s = ships[wb]
        if not s["a1_docs"]:
            continue
        for spec in s["a1_docs"].split("|"):
            label, form = spec.split(":")
            plan.append((wb, re.sub(r"\(.*\)", "", label), form))
    for wb, dtp, form in plan:
        s = ships[wb]
        key = f"A1/{wb}/{dtp}"
        if dtp == "发票":
            exp[key] = {"pieces": int(s["inv_pieces"]), "amount_usd": s["amount_usd"]}
        elif dtp == "装箱单":
            exp[key] = {"cartons": int(s["cartons"]), "pieces": int(s["pieces"]), "gross_kg": s["gross_weight_kg"],
                        "cbm": s["volume_cbm"], "version": s["pl_version"]}
        elif dtp == "提单":
            sku = s["sku_lines"].split(" ")[0]
            exp[key] = {"cartons": int(s["bl_cartons"]), "gross_kg": s["bl_gross_kg"],
                        "cbm": str((Decimal(prods[sku]["cbm_per_ctn"]) * int(s["bl_cartons"])).quantize(Decimal("0.01")))}
        elif dtp == "报关草单":
            exp[key] = {"declared_name": s["declared_name"], "cartons": int(s["cartons"]), "pieces": int(s["pieces"]),
                        "amount_usd": s["amount_usd"], "gross_kg": s["gross_weight_kg"]}
        elif dtp == "箱唛":
            sku = s["sku_lines"].split(" ")[0]
            exp[key] = {"cartons": int(s["cartons"]), "pcs_per_ctn": int(prods[sku]["pcs_per_ctn"]),
                        "kg_per_ctn": prods[sku]["kg_per_ctn"]}
    p4 = next(s for s in ships.values() if "P4" in s["clue_ids"])
    sku4 = p4["sku_lines"].split(" ")[0]
    ppc4 = int(prods[sku4]["pcs_per_ctn"])
    o_ctn, r_ctn = int(p4["bl_cartons"]), int(p4["cartons"])
    exp["A6/群聊"] = {"original_cartons": o_ctn, "revised_cartons": r_ctn, "added_cartons": r_ctn - o_ctn,
                    "version": p4["pl_version"]}
    exp["A6/仓库群"] = {"original_cartons": o_ctn, "revised_cartons": r_ctn, "added_cartons": r_ctn - o_ctn,
                     "version": p4["pl_version"]}
    exp["A6/邮件"] = {"original_cartons": o_ctn, "original_pieces": o_ctn * ppc4, "gross_kg": p4["bl_gross_kg"],
                    "cbm": str((Decimal(prods[sku4]["cbm_per_ctn"]) * o_ctn).quantize(Decimal("0.01")))}
    exp["A7/FMS"] = {"cartons": r_ctn, "pieces": int(p4["pieces"]), "gross_kg": p4["gross_weight_kg"],
                     "cbm": p4["volume_cbm"], "version": p4["pl_version"]}
    fmt = {f: sum(int(r["count"]) for r in intake if r["format"] == f) for f in ("xlsx", "pdf", "image")}
    tot = sum(fmt.values())
    exp["A5"] = {"xlsx": fmt["xlsx"], "pdf": fmt["pdf"], "image": fmt["image"], "total": tot,
                 "share_pct": "/".join(str(round(fmt[f] * 100 / tot)) for f in ("xlsx", "pdf", "image"))}
    k1 = facts["_K1"]
    amount = int(Decimal(re.search(r"花\s*([\d.]+)\s*万", k1).group(1)) * 10000)
    exp["A8/合同"] = {"amount_cny": amount, "first_cny": amount * int(facts["a8.payment_first_pct"]) // 100,
                     "final_cny": amount - amount * int(facts["a8.payment_first_pct"]) // 100,
                     "sign_date": facts["a8.sign_date"]}
    exp["_plan"] = plan
    return exp


# manifest 文件编号 → 本脚本独立推出的期望数字(A1 按「运单号/单据类型」对应)
EXPECT_BY_KEY = {"A5-01": "A5", "A6-01": "A6/群聊", "A6-02": "A6/仓库群", "A6-03": "A6/邮件", "A7-01": "A7/FMS",
                 "A8-01": "A8/合同"}


def manifest_key(f: dict, art: str) -> str:
    if art == "A1":
        return f"A1/{f['waybill']}/{f['doc']}"
    return EXPECT_BY_KEY.get(f.get("key", ""), "")


def norm_num(v) -> str:
    """manifest 里的数字可能是 int / str,统一成可比较的字符串。"""
    if isinstance(v, (int, float, Decimal)):
        return str(Decimal(str(v)).normalize())
    try:
        return str(Decimal(str(v)).normalize())
    except InvalidOperation:
        return str(v)


def main() -> int:
    scen = yaml.safe_load((SCN / "scenario.yaml").read_text(encoding="utf-8"))
    ships = {s["waybill"]: s for s in read_csv("shipments.csv")}
    prods = {p["sku"]: p for p in read_csv("products.csv")}
    lines = read_csv("doc_lines.csv")
    facts = {r["key"]: r["value"] for r in read_csv("doc_facts.csv")}
    facts["_K1"] = next(f["statement"] for f in scen["facts"] if f["id"] == "K1")
    intake = read_csv("intake_week.csv")
    files = scenario_files(scen)
    m = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    marts = {a["id"]: a for a in m["artifacts"]}
    mfiles = {f["path"]: (a["id"], f) for a in m["artifacts"] for f in a["files"]}
    t = S.load_truth()
    docs = S.build_docs(t)
    env = S.make_env()
    exp = expected_numbers(ships, prods, lines, facts, intake)
    texts: dict[str, str] = {}

    # ------------------------------------------------------------------ 文件
    sec("文件与命名")
    a1 = files["A1"]
    a1_img = [p for p in a1 if KIND.get(p.suffix.lower()) == "image"]
    check("A1 文件数 / 其中图片", "14 / 9", f"{len(a1)} / {len(a1_img)}", len(a1) == 14 and len(a1_img) == 9)
    check("A1 非图片均为电子 PDF 或 Excel", "5 份 pdf/xlsx",
          sorted(p.suffix for p in a1 if p not in a1_img),
          all(KIND.get(p.suffix.lower()) in ("pdf", "xlsx") for p in a1 if p not in a1_img) and len(a1) - len(a1_img) == 5)
    check("A3 = cheatsheet.png", 1, len(files["A3"]), len(files["A3"]) == 1 and files["A3"][0].name == "cheatsheet.png")
    check("A5 = intake_week.png", 1, len(files["A5"]), len(files["A5"]) == 1 and files["A5"][0].suffix == ".png")
    check("A6 文件数(均为图片)", 3, len(files["A6"]),
          len(files["A6"]) == 3 and all(KIND.get(p.suffix.lower()) == "image" for p in files["A6"]))
    check("A7 文件数 ≥2 且含 xlsx", "≥2 含 xlsx", [p.name for p in files["A7"]],
          len(files["A7"]) >= 2 and any(p.suffix == ".xlsx" for p in files["A7"]))
    check("A8 文件数", 2, len(files["A8"]), len(files["A8"]) == 2)
    allf = [p for a in DOC_ARTS for p in files[a]]
    check("所有资料文件类型可被网页识别(png/jpg/pdf/xlsx)", "全部", [p.name for p in allf if p.suffix.lower() not in KIND] or "全部",
          all(p.suffix.lower() in KIND for p in allf))
    for a in ("A2", "A4"):
        check(f"{a} 仍有文件", "≥1", len(files[a]), len(files[a]) >= 1)
    spec_paths = {d.path for d in docs}
    on_disk = set(allf)
    check("磁盘文件 = 单据清单(无多余、无缺失)", "一致", "一致" if spec_paths == on_disk else
          f"多 {sorted(p.name for p in on_disk - spec_paths)} 缺 {sorted(p.name for p in spec_paths - on_disk)}",
          spec_paths == on_disk)
    check("文件名只用 ASCII(下载与 URL 安全)", "全部", [p.name for p in allf if not p.name.isascii()] or "全部",
          all(p.name.isascii() for p in allf))

    # ------------------------------------------------------------------ 标识
    sec("标识(方案 8.2)")
    images = [p for p in allf if KIND.get(p.suffix.lower()) == "image"]
    big = [f"{p.name}:{p.stat().st_size}" for p in images if p.stat().st_size > D.MAX_BYTES]
    check("每张图片 ≤ 1.5 MB", f"{len(images)} 张", big or f"最大 {max(p.stat().st_size for p in images):,} B", not big)
    bad_meta, bad_vis = [], []
    for p in images:
        found = D.read_implicit_label(p)
        if p.suffix.lower() == ".png":
            ok = f"tEXt:{LABEL}" in found and f"iTXt:{LABEL}" in found
        else:
            ok = f"EXIF:{LABEL}" in found
            with Image.open(p) as im:
                ok = ok and im.format == "JPEG"
        if not ok:
            bad_meta.append(p.name)
        with Image.open(p) as im:
            img = im.convert("RGB")
        _, box = D.label_geometry(img.size)
        ref = D.stamp_label(Image.new("RGB", img.size, (0, 0, 0))).crop(box)
        diff = np.abs(np.asarray(img.crop(box), dtype=np.int16) - np.asarray(ref, dtype=np.int16)).mean()
        if diff > (0.5 if p.suffix.lower() == ".png" else 8.0):
            bad_vis.append(f"{p.name}:{diff:.1f}")
    check("图片隐式标识(PNG tEXt+iTXt AIGC / JPEG EXIF ImageDescription)", f"{len(images)} 张", bad_meta or "全部",
          not bad_meta)
    check("图片右下角显式标识「合成样本·训练用」(像素核对)", f"{len(images)} 张", bad_vis or "全部", not bad_vis)
    pdfs = [p for p in allf if p.suffix.lower() == ".pdf"]
    bad = []
    for p in pdfs:
        r = PdfReader(p)
        txt = pdf_text(p)
        texts[p.as_posix()] = txt
        if (r.metadata or {}).get("/Subject") != LABEL or not has(txt, MARK) or len(r.pages) != 1:
            bad.append(p.name)
    check("PDF 元数据 Subject、页面标识、单页", f"{len(pdfs)} 份", bad or "全部", not bad)
    xlsxs = [p for p in allf if p.suffix.lower() == ".xlsx"]
    bad = []
    for p in xlsxs:
        wb = load_workbook(p)
        texts[p.as_posix()] = xlsx_text(p)
        sheets_ok = all(any(isinstance(v, str) and MARK in v for row in ws.iter_rows(values_only=True) for v in row)
                        for ws in wb.worksheets)
        if wb.properties.description != MARK or not sheets_ok:
            bad.append(p.name)
    check("xlsx 工作簿属性与每页单元格标识", f"{len(xlsxs)} 份", bad or "全部", not bad)

    # ------------------------------------------------------------------ 清单
    sec("清单 manifest")
    ids = [a["id"] for a in m["artifacts"]]
    check("manifest 资料 = A1–A8", "A1…A8", ", ".join(ids), ids == [f"A{i}" for i in range(1, 9)])
    need = {p.relative_to(SCN).as_posix() for a in files for p in files[a]}
    have = set(mfiles)
    check("manifest 覆盖全部资料文件", f"{len(need)} 个", "全部" if need <= have else sorted(need - have), need <= have)
    pend = [k for k, (_, f) in mfiles.items() if f.get("status") == "pending"]
    check("manifest 没有 pending", 0, len(pend), not pend)
    bad = [k for k, (_, f) in mfiles.items() if not (SCN / k).exists()
           or hashlib.sha256((SCN / k).read_bytes()).hexdigest() != f.get("sha256")]
    check("manifest sha256 与文件一致", f"{len(mfiles)} 个", bad or "全部一致", not bad)
    # 回归:render_xlsx.py 也会刷新清单,但它不渲染单据;刷新时只能重算本次渲染了的单据的 source_sha256,
    # 否则真值改了、图片没重渲染,下面「按当前真值与模板渲染」一项会被这次刷新洗白
    fake = "0" * 64
    tpl = [d for d in docs if d.template]
    probe = next(d for d in tpl if d.is_image)

    def srcs(mm: dict) -> dict:
        return {f["path"]: f.get("source_sha256") for a in mm["artifacts"] for f in a["files"]}
    kept = srcs(M.build_manifest(t, docs, env, rendered=(), previous={d.rel: fake for d in tpl}))
    redo = srcs(M.build_manifest(t, docs, env, rendered={probe.key}, previous={d.rel: fake for d in tpl}))
    stale_kept = all(kept[d.rel] == fake for d in tpl)
    redo_ok = redo[probe.rel] == S.html_sha256(env, probe) and all(redo[d.rel] == fake for d in tpl if d is not probe)
    check("刷新清单只重算本次渲染了的单据的 source_sha256(只跑 render_xlsx.py 不会洗白旧图片)",
          "未渲染的沿用旧值 / 渲染的重算", f"{stale_kept} / {redo_ok}", stale_kept and redo_ok)
    a1m = marts["A1"]["files"]
    for clue in ("P7", "P4", "P5"):
        wb = next(s["waybill"] for s in ships.values() if s["clue_ids"] == clue)
        hit = [f["path"].split("/")[-1] for f in a1m if clue in f.get("clue_refs", [])]
        check(f"A1 线索 {clue}({wb})落在文件上", "≥1 份且同一票", hit,
              len(hit) >= 1 and all(f["waybill"] == wb for f in a1m if clue in f.get("clue_refs", [])))
    k4 = [f for f in a1m if "K4" in f.get("clue_refs", [])]
    check("A1 线索 K4:照片/扫描件/手写份数", 9, len(k4), len(k4) == 9 and all(f["form"] in S.IMAGE_FORMS for f in k4))
    got_plan = sorted((f["waybill"], f["doc"], f["form"]) for f in a1m)
    check("A1 组成 = shipments.csv 的 a1_docs 计划", "14 份一致", "一致" if got_plan == sorted(exp["_plan"]) else got_plan,
          got_plan == sorted(exp["_plan"]))
    allowed = {"fact", "experiment", "where", "waybill", "note"}
    extra = [k for a in m["artifacts"] for c in a.get("clues", []) for k in c if k not in allowed]
    check("每份资料都有线索条目,且无未定义键", "0", extra or 0,
          not extra and all(a.get("clues") for a in m["artifacts"]))
    deg = [f for f in a1m if f["form"] in S.IMAGE_FORMS]
    rot_ok = all(1 <= abs(f["degrade"]["rotate_deg"]) <= 7 for f in deg)
    effects = {e for f in deg for e in f["degrade"]["effects"]}
    miss = [e for e in REQUIRED_EFFECTS if not any(x.startswith(e) for x in effects)]
    check("A1 劣化:9 份都旋转 1–7 度", "9 份", f"{sum(1 for f in deg if 1 <= abs(f['degrade']['rotate_deg']) <= 7)} 份",
          len(deg) == 9 and rot_ok)
    check("A1 劣化效果覆盖(旋转/透视/模糊/JPEG/光照/折痕/桌面/水印)", "全覆盖", miss or "全覆盖", not miss)

    # ------------------------------------------------------------------ 数字 vs 真值
    sec("数字与真值一致")
    by_rel = {d.rel: d for d in docs}
    src_bad = []
    for d in docs:
        if not d.template:
            continue
        html = S.render_html(env, d)
        if hashlib.sha256(html.encode("utf-8")).hexdigest() != mfiles[d.rel][1].get("source_sha256"):
            src_bad.append(d.file)
        if d.is_image:
            texts[d.path.as_posix()] = html_text(html)
    check("图片/PDF 按当前真值与模板渲染(渲染源 HTML 的 sha256 = manifest 记录)", "全部",
          f"{src_bad} 没重渲染,请跑 render_docs.py" if src_bad else "全部", not src_bad)
    mismatch, missing_in_text = [], []
    for rel, (art, f) in sorted(mfiles.items()):
        k = manifest_key(f, art) if art in DOC_ARTS else ""
        if not k or k not in exp:
            continue
        e = exp[k]
        got = f.get("numbers", {})
        if {kk: norm_num(v) for kk, v in e.items()} != {kk: norm_num(got.get(kk)) for kk in e}:
            mismatch.append(f"{rel.split('/')[-1]}:{got} ≠ {e}")
        txt = texts.get((SCN / rel).as_posix(), "")
        nums = numbers_in(txt)
        for kk, v in e.items():
            if kk == "version":
                ok = v == "原版" or has(txt, str(v))          # 原版单据上通常不写版本号
            elif kk in ("declared_name", "sign_date"):
                ok = has(txt, str(v))
            elif kk == "share_pct":
                ok = all(has(txt, f"{part}%") for part in str(v).split("/"))
            else:
                ok = Decimal(str(v)) in nums
            if not ok:
                missing_in_text.append(f"{rel.split('/')[-1]}:{kk}={v}")
    n_checked = sum(1 for rel, (art, f) in mfiles.items() if art in DOC_ARTS and manifest_key(f, art) in exp)
    check("manifest numbers = 由 truth/*.csv 独立推出的数字", f"{n_checked} 份", mismatch or "全部一致", not mismatch)
    check("文件里实际显示了这些数字(PDF 文字 / xlsx 单元格 / 图片渲染 HTML)", f"{n_checked} 份",
          missing_in_text or "全部出现", not missing_in_text)

    def a1_doc(wb: str, dtp: str) -> S.Doc:
        return next(d for d in docs if d.artifact == "A1" and d.waybill == wb and d.doc_type == dtp)

    def txt_of(d: S.Doc) -> str:
        return texts.get(d.path.as_posix(), "")

    p7 = next(s for s in ships.values() if s["clue_ids"] == "P7")
    inv, pl = a1_doc(p7["waybill"], "发票"), a1_doc(p7["waybill"], "装箱单")
    check("P7:发票件数 ≠ 装箱单件数(文件里各自显示)", f"{p7['inv_pieces']} vs {p7['pieces']}",
          f"{int(p7['inv_pieces']) in numbers_in(txt_of(inv))} / {int(p7['pieces']) in numbers_in(txt_of(pl))}",
          p7["inv_pieces"] != p7["pieces"] and Decimal(p7["inv_pieces"]) in numbers_in(txt_of(inv))
          and Decimal(p7["pieces"]) in numbers_in(txt_of(pl)) and Decimal(p7["inv_pieces"]) not in numbers_in(txt_of(pl)))
    p4 = next(s for s in ships.values() if s["clue_ids"] == "P4")
    pl4, bl4 = a1_doc(p4["waybill"], "装箱单"), a1_doc(p4["waybill"], "提单")
    check("P4:装箱单「改2」与箱数 vs 提单箱数", f"{p4['pl_version']} {p4['cartons']} vs {p4['bl_cartons']}",
          f"{has(txt_of(pl4), p4['pl_version'])} {Decimal(p4['cartons']) in numbers_in(txt_of(pl4))} / "
          f"{Decimal(p4['bl_cartons']) in numbers_in(txt_of(bl4))}",
          has(txt_of(pl4), p4["pl_version"]) and Decimal(p4["cartons"]) in numbers_in(txt_of(pl4))
          and Decimal(p4["bl_cartons"]) in numbers_in(txt_of(bl4)) and Decimal(p4["cartons"]) not in numbers_in(txt_of(bl4)))
    p5 = next(s for s in ships.values() if s["clue_ids"] == "P5")
    inv5, cd5 = a1_doc(p5["waybill"], "发票"), a1_doc(p5["waybill"], "报关草单")
    cd_txt = txt_of(cd5)
    check("P5:发票写明带电;报关草单品名笼统、未体现带电", f"发票含「锂」;草单「{p5['declared_name']}」无电池字样",
          f"{has(txt_of(inv5), '锂')} / {has(cd_txt, p5['declared_name'])} / {[w for w in ('电池', '锂', 'Wh', '带电') if has(cd_txt, w)]}",
          has(txt_of(inv5), "锂") and has(cd_txt, p5["declared_name"]) and p5["declared_name"] in G.VAGUE_DECLARED_NAMES
          and not any(has(cd_txt, w) for w in ("电池", "锂", "Wh", "带电")))
    a6 = [d for d in docs if d.artifact == "A6"]
    a6_txt = " ".join(txt_of(d) for d in a6)
    check("A6 与 P4 线索票一致(运单号、原版/改2 箱数、加箱数)", f"{p4['waybill']} {p4['bl_cartons']}/{p4['cartons']}",
          "一致" if all(has(txt_of(d), p4["waybill"]) for d in a6) and {Decimal(p4["bl_cartons"]), Decimal(p4["cartons"]),
                                                                  Decimal(int(p4["cartons"]) - int(p4["bl_cartons"]))}
          <= numbers_in(a6_txt) else "不一致",
          all(has(txt_of(d), p4["waybill"]) for d in a6)
          and {Decimal(p4["bl_cartons"]), Decimal(p4["cartons"]), Decimal(int(p4["cartons"]) - int(p4["bl_cartons"]))}
          <= numbers_in(a6_txt))
    email = next(d for d in a6 if d.doc_type == "邮件截图")
    check("A6 报关行邮件里只有原版箱数(没有改2 箱数)", f"含 {p4['bl_cartons']}、不含 {p4['cartons']}",
          f"{Decimal(p4['bl_cartons']) in numbers_in(txt_of(email))} / {Decimal(p4['cartons']) in numbers_in(txt_of(email))}",
          Decimal(p4["bl_cartons"]) in numbers_in(txt_of(email)) and Decimal(p4["cartons"]) not in numbers_in(txt_of(email)))
    k1_amt = exp["A8/合同"]["amount_cny"]
    contract = next(d for d in docs if d.key == "A8-01")
    accept = next(d for d in docs if d.key == "A8-02")
    check("A8 合同金额 = K1「6.8 万」;写明不含 FMS 对接", f"{k1_amt:,}",
          f"{Decimal(k1_amt) in numbers_in(txt_of(contract))} / {has(txt_of(contract), '接口对接')}",
          Decimal(k1_amt) in numbers_in(txt_of(contract)) and has(txt_of(contract), "接口对接")
          and int(facts["a8.contract_amount_cny"]) == k1_amt)
    stop_m = int(facts["a8.stop_month"].split("-")[1])
    check("A8 验收单:验收日期、停用批注(弃用月数 = K1)", f"{facts['a8.acceptance_date']} / {stop_m}月起停用",
          f"{has(txt_of(accept), facts['a8.acceptance_date'])} / {has(txt_of(accept), f'{stop_m}月起停用')}",
          has(txt_of(accept), facts["a8.acceptance_date"]) and has(txt_of(accept), f"{stop_m}月起停用")
          and stop_m - int(facts["a8.acceptance_date"][5:7]) == int(facts["a8.abandon_after_months"])
          == int(re.search(r"(\d+)\s*个月弃用", facts["_K1"]).group(1)))
    a7x = next(d for d in docs if d.key == "A7-02")
    fms = next(d for d in docs if d.key == "A7-01")
    check("A7 K2:导入模板写明无外部接口;界面「API 对接」未开通", "两处都有",
          f"{has(txt_of(a7x), '不提供外部数据接口')} / {has(txt_of(fms), 'API 对接') and has(txt_of(fms), '未开通')}",
          has(txt_of(a7x), "不提供外部数据接口") and has(txt_of(fms), "API 对接") and has(txt_of(fms), "未开通"))
    ex_lines = [r for r in lines if r["doc_key"] == "A7-02"]
    sums_ok = all(sum(int(r["pieces"]) for r in ex_lines if r["waybill"] == wb) == int(ships[wb]["pieces"])
                  and sum(int(r["cartons"]) for r in ex_lines if r["waybill"] == wb) == int(ships[wb]["cartons"])
                  for wb in {r["waybill"] for r in ex_lines})
    x_nums = numbers_in(txt_of(a7x))
    check("A7 导入模板示例行 = shipments(逐行箱数/件数,合计等于整票)", f"{len(ex_lines)} 行",
          "一致" if sums_ok and all({Decimal(r["cartons"]), Decimal(r["pieces"])} <= x_nums for r in ex_lines) else "不一致",
          sums_ok and all({Decimal(r["cartons"]), Decimal(r["pieces"])} <= x_nums for r in ex_lines))
    a3 = next(d for d in docs if d.key == "A3-01")
    a3_txt = txt_of(a3)
    rows_ok = [sku for sku, *_ in S.A3_ROWS if not has(a3_txt, sku)]
    check("A3 小抄每行货号都在,每箱件数 = products.csv", f"{len(S.A3_ROWS)} 行",
          rows_ok or "一致", not rows_ok and all(Decimal(prods[sku]["pcs_per_ctn"]) in numbers_in(a3_txt)
                                                for sku, *_ in S.A3_ROWS))
    a5_txt = txt_of(next(d for d in docs if d.key == "A5-01"))
    p3 = [int(x) for x in re.findall(r"(\d+)%", next(f["statement"] for f in scen["facts"] if f["id"] == "P3"))]
    check("A5 占比与 scenario.yaml P3 一致", p3, exp["A5"]["share_pct"],
          "/".join(map(str, p3)) == exp["A5"]["share_pct"] and all(has(a5_txt, f"{x}%") for x in p3))
    dl_bad = []
    for key in sorted({r["doc_key"] for r in lines if r["artifact"] == "A1"}):
        rs = [r for r in lines if r["doc_key"] == key]
        s = ships[rs[0]["waybill"]]
        if rs[0]["doc_type"] == "发票":
            ok = sum(int(r["pieces"]) for r in rs) == int(s["inv_pieces"]) and \
                sum(Decimal(r["amount_usd"]) for r in rs) == Decimal(s["amount_usd"])
        elif rs[0]["doc_type"] == "装箱单":
            ok = sum(int(r["pieces"]) for r in rs) == int(s["pieces"]) and \
                sum(Decimal(r["gross_kg"]) for r in rs) == Decimal(s["gross_weight_kg"]) and \
                sum(Decimal(r["cbm"]) for r in rs) == Decimal(s["volume_cbm"])
        elif rs[0]["doc_type"] == "提单":
            ok = int(rs[0]["cartons"]) == int(s["bl_cartons"]) and rs[0]["gross_kg"] == s["bl_gross_kg"]
        else:
            ok = all(int(r["pcs_per_ctn"]) == int(prods[r["sku"]]["pcs_per_ctn"]) for r in rs)
        if not ok:
            dl_bad.append(key)
    check("doc_lines.csv 逐份合计 = shipments.csv", "14 份", dl_bad or "一致", not dl_bad)

    # ------------------------------------------------------------------ 合规
    sec("合规(虚构与占位)")
    blobs = list(texts.items()) + [("manifest.yaml", MANIFEST.read_text(encoding="utf-8"))]
    blobs += [(n, (G.TRUTH_DIR / n).read_text(encoding="utf-8")) for n in ("products.csv", "doc_lines.csv", "doc_facts.csv")]
    hits = []
    for name, txt in blobs:
        hits += [f"{Path(name).name}:{w}" for w in CT.REAL_ENTITIES_CN if has(txt, w)]
        hits += [f"{Path(name).name}:{w}" for w in CT.REAL_ENTITIES_EN
                 if re.search(rf"(?<![A-Za-z]){w}(?![A-Za-z])", txt)]
    check("无真实主体名称(沿用 check_truth 黑名单)", "0 命中", hits or "0 命中", not hits)
    code_hits = []
    for name, txt in blobs:
        clean = CT.SHA256_RE.sub("", txt)
        code_hits += [f"{Path(name).name}:{x}" for x in CT.USCC_RE.findall(clean) + HS_DOTTED_RE.findall(clean)
                      + HS_DIGITS_RE.findall(clean)]
    check("无形似真实的信用代码 / HS 编码(8–10 位或带点格式)", "0 命中", code_hits[:5] or "0 命中", not code_hits)
    hs_docs = [d for d in docs if d.key in ("A3-01", "A7-01", "A7-02") or d.doc_type == "报关草单"]
    hs_ok = all(HS_PLACEHOLDER_RE.search(txt_of(d)) for d in hs_docs)
    check("出现 HS 编码的资料只用占位符 XXXX.XX-序号", f"{len(hs_docs)} 份", "是" if hs_ok else "否", hs_ok)
    # 常量只是源头;真正要核对的是下一项:单据上实际印出来的每一处名称
    bases, cores = fictional_names(t.customers)
    consts = entity_constants()
    bad_const = [n for n in consts if not re.search(MARKER_RE + r"$", n)
                 or not any(re.search(re.escape(c), n, re.I if c.isascii() else 0) for c in cores)]
    check("docs_spec 主体全称常量带「(虚构)/(FICTITIOUS)」且含被扫描的名称核心词", f"{len(consts)} 个",
          bad_const or "全部", not bad_const)
    bare, allowed_hits = [], {}
    for d in docs:
        key = f"{d.artifact}/{d.file}"
        ok_names = BARE_NAME_ALLOW.get(key, (frozenset(), ""))[0]
        for core, ctx in unmarked_names(txt_of(d), bases, cores):
            if core in ok_names:
                allowed_hits.setdefault(key, set()).add(core)
            else:
                bare.append(f"{d.file}:{core}「{ctx}」")
    no_text = [d.file for d in docs if not txt_of(d).strip()]
    n_allowed = sum(len(v) for v in allowed_hits.values())
    check("单据上实际出现的公司/产品名都带「虚构 / FICTITIOUS」(逐份扫 PDF 文字、xlsx 单元格、图片渲染 HTML 的可见文字)",
          f"{len(docs)} 份 0 处未标", bare or (f"没有文字可扫 {no_text}" if no_text else
                                              f"0 处未标(白名单内 {len(allowed_hits)} 份 {n_allowed} 个名称)"),
          not bare and not no_text)
    labeled = {p.name for p in images} - {x.rsplit(":", 1)[0] for x in bad_vis}
    not_img = [k for k in BARE_NAME_ALLOW if k.split("/", 1)[1] not in labeled]
    unused = [f"{k}:{n}" for k, (names_, _) in BARE_NAME_ALLOW.items() for n in sorted(names_)
              if n not in allowed_hits.get(k, set())]
    check("未标名称白名单(群名、昵称、聊天、称呼、小抄、手写栏、界面文案、字标、船名)只用于带「合成样本·训练用」"
          "标识牌的图片,且每条都用得上",
          f"{len(BARE_NAME_ALLOW)} 份图片,右下角标识已按像素核对",
          (not_img and f"不是带标识的图片:{not_img}") or (unused and f"用不上的条目:{unused}") or "全部",
          not not_img and not unused)
    mails = re.findall(r"[\w.-]+@[\w.-]+", " ".join(txt for _, txt in blobs))
    check("邮箱只用保留域名 .example", f"{len(mails)} 处", [x for x in mails if not x.endswith(".example")] or "全部",
          all(x.endswith(".example") for x in mails))
    official = [n for n, txt in blobs if any(has(txt, w) for w in ("中华人民共和国海关", "海关总署", "出口货物报关单"))]
    check("不仿制带官方抬头的文书(报关只做内部草单)", "0", official or 0, not official)

    # ------------------------------------------------------------------ 输出
    w_name = max(width(r[1]) for r in results) + 2
    w_exp = min(34, max(width(r[2]) for r in results) + 2)
    print(pad("#", 4) + pad("检查项", w_name) + pad("期望", w_exp) + pad("实际", w_exp) + "结果")
    cur = None
    for i, (s_, name, e, a, ok) in enumerate(results, start=1):
        if s_ != cur:
            print(f"── {s_} " + "─" * 40)
            cur = s_
        e2 = e if width(e) <= w_exp - 2 else e[: max(8, (w_exp - 4) // 2)] + "…"
        a2 = a if width(a) <= w_exp - 2 else a[: max(8, (w_exp - 4) // 2)] + "…"
        print(pad(str(i), 4) + pad(name, w_name) + pad(e2, w_exp) + pad(a2, w_exp) + ("PASS" if ok else "FAIL"))
    n_fail = sum(1 for r in results if not r[4])
    print(f"\n{len(results) - n_fail}/{len(results)} PASS" + (f",{n_fail} FAIL" if n_fail else ""))
    if n_fail:
        print("\n失败项详情:")
        for s_, name, e, a, ok in results:
            if not ok:
                print(f"  [{s_}] {name}\n    期望:{e}\n    实际:{a}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
