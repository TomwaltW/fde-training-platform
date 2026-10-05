#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
docs_spec.py —— 合成单据(W3)的「单据清单」:每份文件是什么、用哪一票的数字、藏了哪条线索、怎么渲染与劣化。

方案 4.1「先造账,再造单」:这里只从 truth/*.csv 取数(shipments、products、doc_lines、doc_facts、intake_week),
不另编与真值表冲突的数字。render_docs.py 按本清单渲染,manifest.py 按本清单写清单,check_docs.py 按本清单自检。

资料与文件(文件名必须匹配 scenario.yaml 里的 files):
    A1  artifacts/A1/*                样本单据包 14 份(9 份照片/扫描件/手写,劣化;5 份电子 PDF / Excel)
    A3  artifacts/A3/cheatsheet.png   小陈的 Excel 小抄截图(HS 编码一律是占位符)
    A5  artifacts/A5/intake_week.png  近一周来料统计图
    A6  artifacts/A6/*                群聊改单截图 ×2 + 报关行旧邮件截图
    A7  artifacts/A7/*                FMS 录单界面截图 + Excel 导入模板
    A8  artifacts/A8/*                旧 OCR 工具合同首页(PDF)+ 验收单(扫描件)

所有公司名、人名都带「(虚构)」或是明显的称呼/化名;邮箱域名用保留域 .example。
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import random
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape
from markupsafe import Markup, escape

from gen_truth import ROOT, SCENARIO_DIR, TRUTH_DIR  # noqa: F401  (ROOT 供调用方使用)

ART = SCENARIO_DIR / "artifacts"
TEMPLATES = Path(__file__).resolve().parent / "templates"
LABEL = "合成样本·训练用"
MARK = "合成样本·训练用 · 公司与数据均为虚构"
A4_VIEWPORT = (794, 1119)            # 210mm × 296mm,打印成 PDF 时恰好一页

# ---------------------------------------------------------------------------
# 虚构主体(只是文字,不含数字设定)
# ---------------------------------------------------------------------------
FORWARDER = {"cn": "深圳澜途国际货运代理有限公司(虚构)", "en": "LANTU INTERNATIONAL FREIGHT (FICTITIOUS)",
             "short": "澜途国际(虚构)"}
BROKER = {"cn": "恒通报关(虚构)", "team": "恒通报关(虚构)单证组", "mail": "docs@hengtong-customs.example"}
CARRIER = {"cn": "鸿屿航运(虚构)", "en": "HONGYU LINE (FICTITIOUS)", "code": "HY"}
OCR_VENDOR = {"cn": "深圳识图云智能科技有限公司(虚构)", "product": "票据识别助手 V2.1(虚构)"}
FMS = "运链通 FMS(虚构)"
CHEN = {"name": "陈晓雯", "mail": "chenxw@lantu-freight.example"}

CUSTOMER_PROFILE = {
    "青禾跨境": {"cn": "青禾跨境(虚构)", "en": "QINGHE CROSS-BORDER (FICTITIOUS)", "code": "QH",
              "addr": "广东省深圳市龙岗区示例路 18 号(虚构地址)"},
    "栖木家居": {"cn": "栖木家居(虚构)", "en": "QIMU HOME (FICTITIOUS)", "code": "QM",
              "addr": "广东省东莞市示例工业区 6 栋(虚构地址)"},
    "拓浪科技": {"cn": "拓浪科技(虚构)", "en": "TUOLANG TECH (FICTITIOUS)", "code": "TL",
              "addr": "Bldg. 9, Sample Science Park, Shenzhen (fictitious address)"},
    "稻禾健康": {"cn": "稻禾健康(虚构)", "en": "DAOHE HEALTH (FICTITIOUS)", "code": "DH",
              "addr": "广东省佛山市示例路 3 号(虚构地址)"},
    "野径户外": {"cn": "野径户外(虚构)", "en": "YEJING OUTDOOR (FICTITIOUS)", "code": "YJ",
              "addr": "浙江省宁波市示例路 27 号(虚构地址)"},
    "星渚照明": {"cn": "星渚照明(虚构)", "en": "XINGZHU LIGHTING (FICTITIOUS)", "code": "XZ",
              "addr": "广东省中山市示例路 5 号(虚构地址)"},
}
# 客户格式(方案 4.1 步骤 5:5–6 套客户格式)
INVOICE_THEME = {"青禾跨境": "qinghe", "拓浪科技": "tuolang", "栖木家居": "qimu"}
PL_THEME = {"栖木家居": "qimu", "野径户外": "yejing", "星渚照明": "xingzhu"}

EN_NAME = {
    "QH-ZN20": "Drawer Organizer Box", "QH-YJ15": "Flocked Clothes Hanger", "SM-ST02": "Folding Stool",
    "SM-SH11": "Bamboo Storage Shelf", "TL-PS300": "Portable Power Station 300W (built-in Li-ion battery 288Wh)",
    "DH-MG30": "Massage Gun", "YJ-HL01": "Outdoor Headlamp", "XZ-ST50": "LED Strip Light 5m",
}
POD = {"ONT8": "LOS ANGELES, USA", "LGB8": "LONG BEACH, USA", "SBD1": "LOS ANGELES, USA", "FTW1": "HOUSTON, USA",
       "MDW2": "LOS ANGELES, USA", "TEB9": "NEW YORK, USA"}
POD_CN = {"LOS ANGELES, USA": "洛杉矶", "LONG BEACH, USA": "长滩", "HOUSTON, USA": "休斯敦", "NEW YORK, USA": "纽约"}
POL = "YANTIAN, SHENZHEN, CHINA"
POL_CN = "深圳盐田"

# HS 编码一律用明显无效的占位格式(方案 4.1 第 2 条);序号只用来表示「同一个码 / 不同的码」
HS_PLACEHOLDER = "XXXX.XX-{}"
HS_SLOT = {"TL-E12": "01", "TL-PB10": "02", "TL-PS300": "02", "TL-CB01": "04", "TL-HD05": "05", "QH-ZN20": "06",
           "QH-YJ15": "07", "SM-ST02": "08", "SM-SH11": "09", "DH-MG30": "10", "YJ-HL01": "12", "XZ-ST50": "14",
           "XZ-DL08": "15", "YZ-HB07": "16", "LK-CH65": "17", "QP-CM03": "18", "XS-DR12": "19", "JF-LT02": "20"}

# A1 文件命名:运单号_单据_版本_形态.扩展名
DOC_SLUG = {"发票": "invoice", "装箱单": "packing-list", "提单": "bill-of-lading", "报关草单": "customs-draft",
            "箱唛": "shipping-mark"}
FORM_SUFFIX = {"照片": "_photo", "扫描件": "_scan", "手写": "_handwritten", "电子PDF": "", "Excel": ""}
FORM_EXT = {"照片": "jpg", "扫描件": "jpg", "手写": "jpg", "电子PDF": "pdf", "Excel": "xlsx"}
IMAGE_FORMS = ("照片", "扫描件", "手写")

# ---------------------------------------------------------------------------
# 劣化参数(方案 4.1 步骤 6):旋转 1–7 度、透视、模糊、JPEG、光照、折痕、桌面背景、水印。
# 键是资料内编号;数值写死,配合 degrade.py 的固定随机流,重复运行像素一致。
# ---------------------------------------------------------------------------
_L_WARM = {"gradient": (-0.26, -0.18), "spot": (0.30, 0.22), "spot_gain": 0.10, "vignette": 0.22, "floor": 0.6}
_L_SIDE = {"gradient": (0.32, 0.08), "spot": (0.72, 0.18), "spot_gain": 0.14, "vignette": 0.20, "floor": 0.6}
_L_DIM = {"gradient": (0.18, 0.34), "spot": (0.25, 0.70), "spot_gain": 0.06, "vignette": 0.30, "floor": 0.55}
DEGRADE: dict[str, dict] = {
    "LT2609-0387/发票": {"mode": "photo", "background": "wood", "rotate": -4.2, "perspective": 0.022,
                       "keystone": 0.05, "lighting": _L_WARM, "blur": 1.0, "noise": 2.5,
                       "paper_tint": (250, 248, 241), "crease": {"axis": "h", "at": 0.47, "slope": 0.012,
                                                                 "depth": 0.22}, "jpeg_quality": 80},
    "LT2609-0412/提单": {"mode": "scan", "rotate": 1.6, "edge": "left", "blur": 0.8, "specks": 300,
                       "saturation": 0.5, "crease": {"axis": "h", "at": 0.5, "slope": -0.004, "depth": 0.18},
                       "watermark": {"text": "COPY", "color": (196, 40, 40), "alpha": 70, "angle": 32,
                                     "size_ratio": 0.30, "tiled": False}, "jpeg_quality": 78},
    "LT2609-0446/发票": {"mode": "photo", "background": "desk", "rotate": 6.4, "perspective": 0.03,
                       "keystone": 0.08, "lighting": _L_SIDE, "blur": 1.2, "noise": 3.0,
                       "paper_tint": (252, 251, 247), "jpeg_quality": 80},
    "LT2609-0446/报关草单": {"mode": "scan", "rotate": -2.3, "edge": "top", "lid_shadow": 0.1, "blur": 0.9,
                         "specks": 420, "saturation": 0.3,
                         "watermark": {"text": "仅供报关使用", "color": (60, 60, 60), "alpha": 46, "angle": 28,
                                       "size_ratio": 0.07, "tiled": True}, "jpeg_quality": 78},
    "LT2609-2589/发票": {"mode": "photo", "background": "wood", "rotate": 3.1, "perspective": 0.02,
                       "keystone": 0.06, "lighting": _L_SIDE, "blur": 1.0, "noise": 2.5,
                       "paper_tint": (252, 250, 242), "crease": {"axis": "v", "at": 0.5, "slope": 0.006,
                                                                 "depth": 0.2}, "jpeg_quality": 80},
    "LT2609-2589/装箱单": {"mode": "photo", "background": "wood", "rotate": -5.6, "perspective": 0.025,
                        "keystone": 0.04, "lighting": _L_WARM, "blur": 1.1, "noise": 2.5,
                        "paper_tint": (252, 250, 242), "crease": {"axis": "h", "at": 0.34, "slope": -0.01,
                                                                  "depth": 0.24}, "jpeg_quality": 80},
    "LT2609-3749/装箱单": {"mode": "photo", "background": "desk", "rotate": 2.2, "perspective": 0.035,
                        "keystone": 0.10, "lighting": _L_DIM, "blur": 1.6, "noise": 3.5,
                        "paper_tint": (248, 246, 240), "jpeg_quality": 78},
    "LT2609-3749/箱唛": {"mode": "photo", "background": "concrete", "margin": 0.08, "rotate": -3.6,
                       "perspective": 0.03, "keystone": 0.07, "lighting": _L_WARM, "blur": 1.2, "noise": 3.0,
                       "crop": (0.03, 0.03, 0.03, 0.03), "jpeg_quality": 80},
    "LT2609-5047/装箱单": {"mode": "scan", "rotate": 1.1, "edge": "right", "blur": 0.7, "specks": 200,
                        "saturation": 0.4, "crease": {"axis": "v", "at": 0.5, "slope": 0.0, "depth": 0.16},
                        "jpeg_quality": 78},
    "A8/验收单": {"mode": "scan", "rotate": -1.4, "edge": "left", "blur": 0.7, "specks": 240, "saturation": 0.75,
               "crease": {"axis": "h", "at": 0.34, "slope": 0.0, "depth": 0.16}, "jpeg_quality": 80},
}
# 写进 manifest 的劣化说明(中文,便于作者核对)
EFFECT_NAMES = {"rotate": "旋转", "perspective": "透视变形", "blur": "模糊", "jpeg_quality": "JPEG 压缩",
                "lighting": "不均匀光照", "crease": "折痕", "background": "桌面背景", "watermark": "水印",
                "edge": "扫描边缘阴影", "noise": "噪点"}


# ---------------------------------------------------------------------------
# 真值读取
# ---------------------------------------------------------------------------
def read_csv(name: str) -> list[dict]:
    with open(TRUTH_DIR / name, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


@dataclass
class Truth:
    shipments: dict[str, dict]
    products: dict[str, dict]
    doc_lines: list[dict]
    facts: dict[str, str]
    intake: list[dict]
    customers: dict[str, dict]
    scenario: dict

    def lines(self, key: str, version: str | None = None, waybill: str | None = None) -> list[dict]:
        return [d for d in self.doc_lines if d["doc_key"] == key
                and (version is None or d["version"] == version) and (waybill is None or d["waybill"] == waybill)]


def load_truth() -> Truth:
    scen = yaml.safe_load((SCENARIO_DIR / "scenario.yaml").read_text(encoding="utf-8"))
    return Truth(
        shipments={s["waybill"]: s for s in read_csv("shipments.csv")},
        products={p["sku"]: p for p in read_csv("products.csv")},
        doc_lines=read_csv("doc_lines.csv"),
        facts={r["key"]: r["value"] for r in read_csv("doc_facts.csv")},
        intake=read_csv("intake_week.csv"),
        customers={c["customer"]: c for c in read_csv("customers.csv")},
        scenario=scen,
    )


# ---------------------------------------------------------------------------
# 格式化与 Jinja 过滤器
# ---------------------------------------------------------------------------
def fmt_money(v) -> str:
    return f"{Decimal(str(v)):,.2f}"


def fmt_qty(v) -> str:
    return f"{int(v):,}"


def fmt_kg(v) -> str:
    return f"{Decimal(str(v)):,.1f}"


_ONES = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE",
         "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"]
_TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"]


def words(n: int) -> str:
    """英文大写数字(单据上的 SAY TOTAL)。"""
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + (f"-{_ONES[n % 10]}" if n % 10 else "")
    if n < 1000:
        return f"{_ONES[n // 100]} HUNDRED" + (f" AND {words(n % 100)}" if n % 100 else "")
    if n < 1_000_000:
        return f"{words(n // 1000)} THOUSAND" + (f" {words(n % 1000)}" if n % 1000 else "")
    raise ValueError(n)


def usd_words(amount) -> str:
    a = Decimal(str(amount))
    dollars, cents = int(a), int((a - int(a)) * 100)
    s = "U.S. DOLLARS " + words(dollars)
    if cents:
        s += f" AND CENTS {words(cents)}"
    return s + " ONLY"


_CN_DIG = "零壹贰叁肆伍陆柒捌玖"


def cn_upper(n: int) -> str:
    """人民币大写(整数元):68000 → 陆万捌仟元整。"""
    def four(x: int) -> str:
        s, pending_zero = "", False
        for i, unit in zip(range(3, -1, -1), ["仟", "佰", "拾", ""]):
            d = x // 10 ** i % 10
            if d == 0:
                pending_zero = bool(s)
                continue
            if pending_zero:
                s += "零"
                pending_zero = False
            s += _CN_DIG[d] + unit
        return s
    hi, lo = divmod(int(n), 10000)
    s = (four(hi) + "万") if hi else ""
    if lo:
        s += ("零" if hi and lo < 1000 else "") + four(lo)
    return s + "元整"


def handwrite(text, seed: str = "", tone: str = "") -> Markup:
    """手写效果:逐字随机旋转、位移、缩放、倾斜。种子来自文字本身,重复渲染一致。"""
    s = str(text)
    rng = random.Random(int(hashlib.sha256(f"hw:{seed}:{s}".encode()).hexdigest()[:12], 16))
    parts = []
    for ch in s:
        if ch == " ":
            parts.append('<span style="width:.32em"></span>')
            continue
        parts.append('<span style="transform:translateY({:.1f}px) rotate({:.1f}deg) scale({:.2f}) skewX({:.0f}deg)">'
                     '{}</span>'.format(rng.uniform(-2.2, 2.2), rng.uniform(-6, 6), rng.uniform(0.9, 1.12),
                                        rng.uniform(-9, 3), escape(ch)))
    cls = "hw red" if tone == "red" else "hw"
    return Markup(f'<span class="{cls}">' + "".join(parts) + "</span>")


def make_env() -> Environment:
    env = Environment(loader=FileSystemLoader(str(TEMPLATES)), autoescape=select_autoescape(["html", "j2"]),
                      undefined=StrictUndefined, keep_trailing_newline=True)
    env.filters.update(money=fmt_money, qty=fmt_qty, kg=fmt_kg, hw=handwrite)
    env.globals["mark"] = MARK
    return env


# ---------------------------------------------------------------------------
# 单据描述
# ---------------------------------------------------------------------------
@dataclass
class Doc:
    key: str                     # 资料内编号,如 A1-03
    artifact: str                # A1 / A3 / …
    file: str                    # 文件名
    title: str                   # 中文标题
    doc_type: str                # 发票 / 装箱单 / 提单 / 报关草单 / 箱唛 / 截图 / 合同 …
    form: str                    # 照片 / 扫描件 / 手写 / 电子PDF / Excel / 截图
    waybill: str = ""
    customer: str = ""
    version: str = ""
    template: str | None = None  # HTML 模板;Excel 资料为 None
    viewport: tuple[int, int] = A4_VIEWPORT
    scale: float = 2.0
    ctx: dict = field(default_factory=dict)
    degrade: dict | None = None
    clue_refs: list[str] = field(default_factory=list)
    numbers: dict = field(default_factory=dict)
    shows: str = ""

    @property
    def kind(self) -> str:
        return self.file.rsplit(".", 1)[1].lower()

    @property
    def rel(self) -> str:
        return f"artifacts/{self.artifact}/{self.file}"

    @property
    def path(self) -> Path:
        return ART / self.artifact / self.file

    @property
    def is_image(self) -> bool:
        return self.kind in ("png", "jpg", "jpeg")


def render_html(env: Environment, doc: Doc) -> str:
    assert doc.template, doc.key
    return env.get_template(doc.template).render(title=doc.title, key=doc.key, **doc.ctx)


def html_sha256(env: Environment, doc: Doc) -> str:
    return hashlib.sha256(render_html(env, doc).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def _date(s: str, delta_days: int = 0) -> str:
    return (dt.date.fromisoformat(s) + dt.timedelta(days=delta_days)).isoformat()


def _cn_time(ts: str) -> str:
    """'2026-09-01 23:41' → '9月1日 23:41'。"""
    d, t = ts.split(" ")
    y, m, dd = d.split("-")
    return f"{int(m)}月{int(dd)}日 {t}"


def _plus_minutes(ts: str, minutes: int) -> str:
    x = dt.datetime.strptime(ts, "%Y-%m-%d %H:%M") + dt.timedelta(minutes=minutes)
    return x.strftime("%H:%M")


def _short(t: Truth, customer: str) -> str:
    aliases = t.customers[customer]["aliases"]
    return aliases.split("|")[0] if aliases else customer[:2]


def _pl_lines(rows: list[dict]) -> list[dict]:
    return [{"no": i, "sku": r["sku"], "name": r["item_name"], "en": EN_NAME.get(r["sku"], ""), "ctn": r["cartons"],
             "ppc": r["pcs_per_ctn"], "pcs": r["pieces"], "gw": r["gross_kg"], "cbm": r["cbm"]}
            for i, r in enumerate(rows, start=1)]


def _pl_totals(rows: list[dict]) -> dict:
    return {"total_ctn": sum(int(r["cartons"]) for r in rows), "total_pcs": sum(int(r["pieces"]) for r in rows),
            "total_gw": str(sum(Decimal(r["gross_kg"]) for r in rows)),
            "total_cbm": str(sum(Decimal(r["cbm"]) for r in rows))}


def _degrade_for(key: str) -> dict:
    p = dict(DEGRADE[key])
    assert 1 <= abs(p["rotate"]) <= 7, key
    return p


# ---------------------------------------------------------------------------
# A1 样本单据包
# ---------------------------------------------------------------------------
def a1_docs(t: Truth) -> list[Doc]:
    keys = sorted({d["doc_key"] for d in t.doc_lines if d["artifact"] == "A1"})
    out = []
    for key in keys:
        rows = t.lines(key)
        r0 = rows[0]
        s = t.shipments[r0["waybill"]]
        dtp, form, ver = r0["doc_type"], r0["form"], r0["version"]
        rev = f"_rev{ver[1:]}" if dtp == "装箱单" and ver.startswith("改") else ""
        fname = f"{s['waybill']}_{DOC_SLUG[dtp]}{rev}{FORM_SUFFIX[form]}.{FORM_EXT[form]}"
        doc = Doc(key=key, artifact="A1", file=fname, title=f"{s['waybill']} {dtp}{'(' + ver + ')' if rev else ''}"
                  f"({form})", doc_type=dtp, form=form, waybill=s["waybill"], customer=s["customer"], version=ver)
        prof = CUSTOMER_PROFILE[s["customer"]]
        pod = POD[s["fba_warehouse"]]
        common = {"seller": prof, "buyer": {"name": f"{prof['en'].replace(' (FICTITIOUS)', '')} US STORE (FICTITIOUS)",
                                            "addr": f"c/o FBA {s['fba_warehouse']}, {pod}"},
                  "ref": s["waybill"], "pol": POL, "pod": pod, "fba": s["fba_warehouse"],
                  "date": _date(s["ship_date"], -1), "pdf": form == "电子PDF", "blank_rows": 4}
        if form in IMAGE_FORMS:
            doc.degrade = _degrade_for(f"{s['waybill']}/{dtp}")
        if form == "手写":
            doc.template = "handwritten_form.html.j2"
            doc.ctx = _handwritten_ctx(t, s, dtp, rows)
        elif dtp == "发票":
            total_pcs = sum(int(r["pieces"]) for r in rows)
            total_amt = sum(Decimal(r["amount_usd"]) for r in rows)
            doc.numbers = {"pieces": total_pcs, "amount_usd": str(total_amt)}
            if form == "Excel":
                doc.template = None
            else:
                doc.template = "invoice.html.j2"
            notes = []
            if s["battery"] == "是":
                notes.append("Remarks: goods contain built-in lithium-ion batteries. 备注:货物内置锂离子电池。")
            notes.append("Country of Origin: CHINA 原产地:中国")
            doc.ctx = dict(common, theme=INVOICE_THEME.get(s["customer"], "qimu"),
                           inv_no=f"{prof['code']}{s['waybill'][2:6]}-{s['waybill'][-3:]}", terms="FOB SHENZHEN",
                           lines=[{"no": i, "sku": r["sku"], "name": r["item_name"], "en": EN_NAME.get(r["sku"], ""),
                                   "pcs": r["pieces"], "unit": r["unit_usd"], "amount": r["amount_usd"]}
                                  for i, r in enumerate(rows, start=1)],
                           total_pcs=total_pcs, total_amount=str(total_amt), words=usd_words(total_amt), notes=notes)
        elif dtp == "装箱单":
            tot = _pl_totals(rows)
            doc.numbers = {"cartons": tot["total_ctn"], "pieces": tot["total_pcs"], "gross_kg": tot["total_gw"],
                           "cbm": tot["total_cbm"], "version": ver}
            doc.template = None if form == "Excel" else "packing_list.html.j2"
            rev_date = _date(s["ship_date"], -1)
            if s["waybill"] == t.facts["a6.waybill"] and ver == t.facts["a6.revised_version"]:
                rev_date = t.facts["a6.t_rev2_posted"].split(" ")[0]
            doc.ctx = dict(common, theme=PL_THEME.get(s["customer"], "qimu"),
                           pl_no=f"{prof['code']}PL{s['waybill'][2:6]}-{s['waybill'][-3:]}", version=ver,
                           rev_date=rev_date, lines=_pl_lines(rows), total_words=words(tot["total_ctn"]),
                           marks=[f"FBA {s['fba_warehouse']}", " / ".join(r["sku"] for r in rows),
                                  f"C/NO. 1-{tot['total_ctn']}", "MADE IN CHINA"],
                           notes=[], **tot)
        elif dtp == "提单":
            r = rows[0]
            doc.numbers = {"cartons": int(r["cartons"]), "gross_kg": r["gross_kg"], "cbm": r["cbm"]}
            doc.template = "bill_of_lading.html.j2"
            wb = s["waybill"]
            doc.ctx = dict(common, carrier=CARRIER, bl_no=f"{CARRIER['code']}SZ{wb[2:6]}{wb[-4:]}",
                           booking_no=f"BK{wb[2:6]}-{wb[-4:]}",
                           shipper=[prof["en"], prof["cn"], prof["addr"]],
                           consignee=[common["buyer"]["name"], common["buyer"]["addr"]],
                           notify=["SAME AS CONSIGNEE"], receipt="SHENZHEN, CHINA", vessel="HONGYU PIONEER",
                           voyage=f"V.{wb[2:6]}E", delivery=f"FBA {s['fba_warehouse']}",
                           container=f"{CARRIER['code']}LU{wb[-4:]}073", seal=f"{CARRIER['code']}{wb[2:6]}{wb[-3:]}",
                           marks=[f"FBA {s['fba_warehouse']}", r["sku"], f"C/NO. 1-{r['cartons']}"],
                           packages=int(r["cartons"]), pkg_words=words(int(r["cartons"])),
                           desc=[f"{EN_NAME.get(r['sku'], r['sku']).upper()} {r['item_name']}",
                                 f"({fmt_qty(r['pieces'])} PCS)"],
                           gw=r["gross_kg"], cbm=r["cbm"], freight="PREPAID", issue_place="SHENZHEN",
                           issue_date=s["ship_date"], onboard_date=s["ship_date"])
        elif dtp == "报关草单":
            lines = [{"no": i, "hs": HS_PLACEHOLDER.format(HS_SLOT.get(r["sku"], "00")), "declared": r["declared_name"],
                      "spec": "品牌:无 | 型号:—", "pcs": r["pieces"], "unit": r["unit_usd"], "amount": r["amount_usd"]}
                     for i, r in enumerate(rows, start=1)]
            doc.numbers = {"declared_name": rows[0]["declared_name"], "cartons": sum(int(r["cartons"]) for r in rows),
                           "pieces": sum(int(r["pieces"]) for r in rows),
                           "amount_usd": str(sum(Decimal(r["amount_usd"]) for r in rows)),
                           "gross_kg": str(sum(Decimal(r["gross_kg"]) for r in rows))}
            doc.template = "customs_draft.html.j2"
            doc.ctx = dict(common, forwarder=FORWARDER, draft_no=f"BG{s['waybill'][2:6]}-{s['waybill'][-4:]}",
                           exporter=prof["cn"], transport="水路运输", country="美国",
                           pol=POL_CN, pod=POD_CN[pod], cartons=doc.numbers["cartons"], gw=doc.numbers["gross_kg"],
                           terms="FOB", lines=lines, remark="",
                           attachments=["发票", "装箱单", "报关委托书", "申报要素"],
                           maker=_handler_for(t, s["customer"]))
        elif dtp == "箱唛":
            r = rows[0]
            pr = t.products[r["sku"]]
            doc.numbers = {"cartons": int(r["cartons"]), "pcs_per_ctn": int(pr["pcs_per_ctn"]),
                           "kg_per_ctn": pr["kg_per_ctn"]}
            doc.template = "shipping_mark.html.j2"
            doc.viewport, doc.scale = (1100, 780), 1.4
            doc.ctx = {"vw": 1100, "vh": 780, "body_bg": "#c39a68", "fba": s["fba_warehouse"], "sku": r["sku"],
                       "name": r["item_name"], "en": EN_NAME.get(r["sku"], "").upper(), "ppc": pr["pcs_per_ctn"],
                       "kgc": pr["kg_per_ctn"], "carton_no": int(r["cartons"]) // 2 - 2, "cartons": int(r["cartons"]),
                       "ref": s["waybill"], "battery": r["battery"] == "是"}
        doc.numbers = doc.numbers or _handwritten_numbers(rows, dtp)
        out.append(doc)
    _attach_a1_clues(t, out)
    return out


def _handler_for(t: Truth, customer: str) -> str:
    # 拓浪的票由小陈与赵雅琴经手(gen_truth.KEY_CUSTOMER_HANDLERS);草单署名用赵雅琴,与小陈区分
    return "赵雅琴" if customer == "拓浪科技" else CHEN["name"]


def _handwritten_numbers(rows: list[dict], dtp: str) -> dict:
    if dtp == "发票":
        return {"pieces": sum(int(r["pieces"]) for r in rows),
                "amount_usd": str(sum(Decimal(r["amount_usd"]) for r in rows))}
    tot = _pl_totals(rows)
    return {"cartons": tot["total_ctn"], "pieces": tot["total_pcs"], "gross_kg": tot["total_gw"],
            "cbm": tot["total_cbm"], "version": rows[0]["version"]}


def _handwritten_ctx(t: Truth, s: dict, dtp: str, rows: list[dict]) -> dict:
    prof = CUSTOMER_PROFILE[s["customer"]]
    date = _date(s["ship_date"], -1)
    y, m, d = date.split("-")
    base = {"form_no": f"00{s['waybill'][-4:]}", "customer": prof["cn"].replace("(虚构)", ""),
            "date": f"{y}.{int(m)}.{int(d)}", "ref": s["waybill"], "dest": f"FBA {s['fba_warehouse']}",
            "signer": "李", "blank_rows": 6, "seller_line": f"{prof['cn']} · 手写单据(合成样本)",
            "form_subtitle": "", "note": ""}
    if dtp == "发票":
        cols = [{"label": "品名规格", "w": "40%"}, {"label": "单位", "w": "10%"}, {"label": "数量", "w": "14%"},
                {"label": "单价(USD)", "w": "16%"}, {"label": "金额(USD)", "w": "20%"}]
        body = [[f"{r['item_name']} {r['sku']}", "个", r["pieces"], r["unit_usd"], r["amount_usd"]] for r in rows]
        tot_pcs = sum(int(r["pieces"]) for r in rows)
        tot_amt = str(sum(Decimal(r["amount_usd"]) for r in rows))
        return dict(base, form_title="发 票", form_subtitle="INVOICE", columns=cols, rows=body,
                    total_row=["", "", str(tot_pcs), "", tot_amt], amount_label="合计金额:",
                    amount_text=f"美元 {tot_amt}", note="带电,MSDS 后补")
    cols = [{"label": "品名", "w": "34%"}, {"label": "箱数", "w": "12%"}, {"label": "每箱", "w": "12%"},
            {"label": "总数量", "w": "14%"}, {"label": "毛重KG", "w": "14%"}, {"label": "体积m³", "w": "14%"}]
    body = [[f"{r['item_name']} {r['sku']}", r["cartons"], r["pcs_per_ctn"], r["pieces"], r["gross_kg"], r["cbm"]]
            for r in rows]
    tot = _pl_totals(rows)
    return dict(base, form_title="装 箱 单", form_subtitle="PACKING LIST", columns=cols, rows=body,
                total_row=["", str(tot["total_ctn"]), "", str(tot["total_pcs"]), tot["total_gw"], tot["total_cbm"]],
                amount_label="共计:", amount_text=f"{tot['total_ctn']} 箱", note="")


def _attach_a1_clues(t: Truth, docs: list[Doc]) -> None:
    """把 shipments.csv 的线索列落到具体文件上(manifest 的 clue_refs)。"""
    for d in docs:
        s = t.shipments[d.waybill]
        clue = s["clue_ids"]
        if clue == "P7" and d.doc_type in ("发票", "装箱单"):
            d.clue_refs.append("P7")
        if clue == "P4" and d.doc_type in ("装箱单", "提单"):
            d.clue_refs.append("P4")
        if clue == "P5" and d.doc_type in ("发票", "报关草单"):
            d.clue_refs.append("P5")
        if d.form in IMAGE_FORMS:
            d.clue_refs.append("K4")
        d.shows = _a1_shows(d)


def _a1_shows(d: Doc) -> str:
    n = d.numbers
    if d.doc_type == "发票":
        return f"发票合计 {n['pieces']} 件、USD {fmt_money(n['amount_usd'])}"
    if d.doc_type == "装箱单":
        return (f"装箱单({n['version']})合计 {n['cartons']} 箱、{n['pieces']} 件、毛重 {n['gross_kg']} KG、"
                f"体积 {n['cbm']} CBM")
    if d.doc_type == "提单":
        return f"提单(副本){n['cartons']} 箱、毛重 {n['gross_kg']} KG、体积 {n['cbm']} CBM"
    if d.doc_type == "报关草单":
        return f"报关草单申报品名「{n['declared_name']}」,{n['cartons']} 箱 {n['pieces']} 件,USD {fmt_money(n['amount_usd'])}"
    if d.doc_type == "箱唛":
        return f"箱唛:每箱 {n['pcs_per_ctn']} 件、毛重 {n['kg_per_ctn']} KG,共 {n['cartons']} 箱"
    return ""


# ---------------------------------------------------------------------------
# A3 小陈的小抄
# ---------------------------------------------------------------------------
# (SKU, HS 占位序号列表, 申报品名覆写, 备注, 更新月份, 样式)
A3_ROWS = [
    ("TL-E12", ["01"], None, "品牌、型号、是否带电;附 MSDS", "2026-03", ""),
    ("TL-PB10", ["02"], None, "容量 mAh 必须写;带电走特货", "2026-05", ""),
    ("TL-PS300", ["02"], "电子配件", "新品,先套移动电源的码;报关行说要单独归、写 Wh?还没改", "2026-08", "yellow"),
    ("TL-CB01", ["04"], None, "材质:尼龙编织 + 铜", "2025-11", ""),
    ("TL-HD05", ["05", "11"], None, "赵姐报 -11,我报 -05,哪个对?问报关行", "2026-07", "red"),
    ("QH-ZN20", ["06"], None, "材质 PP", "2025-09", ""),
    ("QH-YJ15", ["07"], None, "植绒算不算纺织品?问过,按塑料报", "2025-09", ""),
    ("SM-ST02", ["08"], None, "钢架 + PP 面;用途:家用", "2025-12", ""),
    ("SM-SH11", ["09"], None, "竹制品要不要熏蒸证明??", "2026-02", ""),
    ("DH-MG30", ["10"], None, "带电!电池 Wh 要写", "2026-04", ""),
    ("YJ-HL01", ["13", "12"], None, "今年调了,老对照表的码作废(划掉的别用)", "2026-01", "strike"),
    ("XZ-ST50", ["14"], None, "功率、电压", "2025-10", ""),
    ("XZ-DL08", ["15"], None, "内置电池,按带电走", "2026-06", ""),
    ("YZ-HB07", ["16"], None, "接口数、品牌", "2025-08", ""),
    ("LK-CH65", ["17"], None, "功率 W", "2026-03", ""),
    ("QP-CM03", ["18"], None, "要不要 3C?问报关行", "2026-05", ""),
    ("XS-DR12", ["19"], None, "电池可拆,要不要单独报?", "2026-07", ""),
    ("JF-LT02", ["20"], None, "", "2025-07", ""),
]
A3_FIELDS = [
    ("拓浪", "CTN / QTY(PCS) / G.W.(KG)", "箱数 / 件数 / 毛重", "整票合计在最后一行;带电品附 MSDS"),
    ("青禾", "「数量」", "件数(不是箱数!)", "发票和箱单分开发,经常对不上 → 先问客户以哪个为准"),
    ("栖木", "「包装数」", "箱数", "改单多,文件名带「改1 / 改2」,一定用最新版"),
    ("稻禾", "手写单", "—", "1 和 7 分不清,打电话确认"),
    ("野径", "PCS/CTN", "每箱件数", "只发照片,要原件"),
    ("星渚", "Qty / Amount", "件数 / 金额", "每次列顺序都不一样,别直接复制粘贴"),
]


def a3_doc(t: Truth) -> Doc:
    rows = []
    for sku, slots, decl, note, upd, style in A3_ROWS:
        p = t.products[sku]
        rows.append({"cust": _short(t, p["customer"]), "inv_name": f"{p['name']} {sku}",
                     "declared": decl or p["declared_name"], "decl_note": "(一直这么报)" if decl else "",
                     "hs": [HS_PLACEHOLDER.format(x) for x in slots], "battery": p["battery"],
                     "ppc": p["pcs_per_ctn"], "note": note, "updated": upd, "style": style})
    ctx = {"file_title": f"单证小抄-{CHEN['name']}.xlsx", "rows": rows, "fields": A3_FIELDS,
           "active_cell": "C5", "active_value": "电子配件",
           "sheets": ["品名对照", "客户字段", "仓库代码", "Sheet4"], "updated": "2026-09-18"}
    return Doc(key="A3-01", artifact="A3", file="cheatsheet.png", title="小陈的 Excel 小抄(截图)", doc_type="小抄截图",
               form="截图", template="cheatsheet.html.j2", viewport=(1440, 900), scale=1.25, ctx=ctx,
               clue_refs=["P5"],
               numbers={"rows": len(rows), "pcs_per_ctn": {r[0]: int(t.products[r[0]]["pcs_per_ctn"]) for r in A3_ROWS}},
               shows="「品名对照」18 行:同一品名两种编码、作废的老码、储能电源仍写「电子配件」、多处「问报关行」;"
                     "下方「客户字段对照」6 家客户各自的写法。HS 编码一律为占位符")


# ---------------------------------------------------------------------------
# A5 来料统计图
# ---------------------------------------------------------------------------
A5_SERIES = [("xlsx", "Excel", "#2a78d6"), ("pdf", "电子PDF", "#eb6834"), ("image", "图片/扫描件", "#1baf7a")]


def a5_doc(t: Truth) -> Doc:
    days = []
    order = []
    for r in t.intake:
        if r["weekday"] not in order:
            order.append(r["weekday"])
    for wd in order:
        rec = {"day": wd}
        for f, _, _ in A5_SERIES:
            rec[f] = sum(int(r["count"]) for r in t.intake if r["weekday"] == wd and r["format"] == f)
        rec["total"] = sum(rec[f] for f, _, _ in A5_SERIES)
        days.append(rec)
    tot = {f: sum(d[f] for d in days) for f, _, _ in A5_SERIES}
    grand = sum(tot.values())
    share = {f: round(tot[f] * 100 / grand) for f in tot}
    subs: dict[str, int] = {}
    chans: dict[str, int] = {}
    for r in t.intake:
        chans[r["channel"]] = chans.get(r["channel"], 0) + int(r["count"])
        if r["format"] == "image":
            subs[r["subtype"]] = subs.get(r["subtype"], 0) + int(r["count"])
    # 图表几何(SVG 坐标,单位 px)
    ch_h, ch_w, top, left = 430, 620, 30, 56
    ymax = ((max(d["total"] for d in days) + 49) // 50) * 50
    band = ch_w / len(days)
    bar_w = 24                         # dataviz:柱宽不超过 24px,带宽剩下的留白
    bars = []
    for i, d in enumerate(days):
        x = left + band * i + (band - bar_w) / 2
        y = top + ch_h
        segs = []
        for i_s, (f, label, color) in enumerate(A5_SERIES):
            h = d[f] / ymax * ch_h
            gap = 2 if i_s else 0              # 段与段之间留 2px 底色缝,最下面一段贴住基线
            segs.append({"x": round(x, 1), "y": round(y - h, 1), "w": bar_w, "h": round(max(h - gap, 0), 1),
                         "color": color, "label": label, "n": d[f]})
            y -= h
        bars.append({"x": round(x + bar_w / 2, 1), "day": d["day"], "total": d["total"], "top": round(y, 1),
                     "segs": segs})
    ticks = [{"v": v, "y": round(top + ch_h - v / ymax * ch_h, 1)} for v in range(0, ymax + 1, 50)]
    ctx = {"days": days, "tot": tot, "grand": grand, "share": share, "series": A5_SERIES, "subs": subs,
           "chans": chans, "bars": bars, "ticks": ticks, "chart": {"w": left + ch_w + 10, "h": top + ch_h + 40,
                                                                   "left": left, "top": top, "ch_w": ch_w,
                                                                   "ch_h": ch_h, "base": top + ch_h}}
    return Doc(key="A5-01", artifact="A5", file="intake_week.png", title="近一周来料文件统计", doc_type="统计图",
               form="截图", template="intake_chart.html.j2", viewport=(1200, 720), scale=1.5, ctx=ctx,
               clue_refs=["P3"],
               numbers={"xlsx": tot["xlsx"], "pdf": tot["pdf"], "image": tot["image"], "total": grand,
                        "share_pct": f"{share['xlsx']}/{share['pdf']}/{share['image']}"},
               shows=f"Excel {tot['xlsx']}、电子PDF {tot['pdf']}、图片/扫描件 {tot['image']},合计 {grand};"
                     f"占比 {share['xlsx']}%/{share['pdf']}%/{share['image']}%")


# ---------------------------------------------------------------------------
# A6 改单截图与报关行旧邮件
# ---------------------------------------------------------------------------
def _pdf_file(name: str) -> dict:
    return {"kind": "file", "file": name}


def a6_docs(t: Truth) -> list[Doc]:
    f = t.facts
    wb, cust = f["a6.waybill"], f["a6.customer"]
    short = _short(t, cust)
    orig, rev, add, ver = f["a6.original_cartons"], f["a6.revised_cartons"], f["a6.added_cartons"], f["a6.revised_version"]
    o_rows = t.lines("A6-03", version="原版")
    o = o_rows[0]
    item = o["item_name"]
    tail = wb[-4:]
    customer_person = {"name": f"{short}-阿May", "avatar": short[0], "color": "#8c6d4f"}
    me = {"name": f"澜途-{CHEN['name']}", "avatar": "陈", "color": "#3f7f5f"}
    wh = {"name": "仓库-老郑", "avatar": "郑", "color": "#4f6d8c"}
    liu = {"name": "澜途操作部-刘", "avatar": "刘", "color": "#8c4f5e"}

    def msg(who, side, text=None, file=None, image=None):
        return {"kind": "msg", "who": who, "side": side, "text": text, "file": file, "image": image}

    chat1 = [
        {"kind": "time", "text": _cn_time(f["a6.t_original_posted"])},
        msg(customer_person, "l", text=f"{tail} {item} {orig} 箱,装箱单发群里了,麻烦安排~"),
        msg(me, "r", text="收到"),
        {"kind": "time", "text": _cn_time(f["a6.t_rev1_posted"])},
        msg(customer_person, "l", text="改1 发群里了:只是箱唛上的 FBA 货件编号更正一下,数量不变"),
        {"kind": "time", "text": _cn_time(f["a6.t_rev2_posted"])},
        msg(customer_person, "l", text=f"@{CHEN['name']} 不好意思,{tail} 客户临时再加 {add} 箱{item},一共 {rev} 箱"),
        msg(customer_person, "l", file=f"{wb}_装箱单_{ver}.pdf"),
        msg(customer_person, "l", text="明天麻烦同步一下仓库和报关哈"),
        {"kind": "time", "text": _cn_time(f["a6.t_chen_ack"])},
        msg(me, "r", text=f"收到,系统里已改成 {rev} 箱"),
    ]
    chat2 = [
        {"kind": "time", "text": _cn_time(f["a6.t_warehouse_report"])},
        msg(wh, "l", image={"cartons": 8}),
        msg(wh, "l", text=f"{tail} {short}的{item}到了 {rev} 箱,单子上写的 {orig} 箱,板是按 {orig} 箱打的,多出来 {add} 箱放哪?"),
        msg(me, "r", text=f"客户昨晚在群里改了,{ver} 是 {rev} 箱,我转给你"),
        msg(me, "r", file=f"{wb}_装箱单_{ver}.pdf"),
        msg(wh, "l", text="板已经打好缠膜了,要拆了重打"),
        msg(liu, "l", text="报关那边报的多少箱?"),
        msg(me, "r", text=f"报关行用的是昨天下午邮件里的原版,{orig} 箱……我马上问"),
    ]
    docs = [
        Doc(key="A6-01", artifact="A6", file=f"01_group-chat_{wb}.png", title=f"客户群改单截图({wb})",
            doc_type="群聊截图", form="截图", waybill=wb, customer=cust, template="chat.html.j2",
            viewport=(390, 844), scale=3.0,
            ctx={"group": f"{cust} × 澜途 出货对接群(6)",
                 "clock": _plus_minutes(f["a6.t_chen_ack"], 1), "items": chat1},
            clue_refs=["P4"],
            numbers={"original_cartons": int(orig), "revised_cartons": int(rev), "added_cartons": int(add),
                     "version": ver},
            shows=f"{_cn_time(f['a6.t_rev2_posted'])} 客户在群里加 {add} 箱,改成 {rev} 箱({ver});"
                  f"次日 {f['a6.t_chen_ack'].split(' ')[1]} 小陈只回「系统里已改」,没有同步仓库与报关行"),
        Doc(key="A6-02", artifact="A6", file=f"02_warehouse-chat_{wb}.png", title=f"仓库群截图({wb})",
            doc_type="群聊截图", form="截图", waybill=wb, customer=cust, template="chat.html.j2",
            viewport=(390, 844), scale=3.0,
            ctx={"group": "澜途操作部 × 仓库 对接群(9)", "clock": _plus_minutes(f["a6.t_warehouse_report"], 15),
                 "items": chat2},
            clue_refs=["P4"],
            numbers={"original_cartons": int(orig), "revised_cartons": int(rev), "added_cartons": int(add),
                     "version": ver},
            shows=f"仓库实收 {rev} 箱、按旧单 {orig} 箱打了板;报关行用的是邮件里的原版 {orig} 箱"),
    ]
    email_ctx = {
        "account": f"{CHEN['name']} <{CHEN['mail']}>", "search": wb, "folder": "",
        "list": [
            {"from": BROKER["team"], "subject": f"回复:{wb} {cust}(虚构) 出口报关资料",
             "time": _cn_time(f["a6.t_broker_reply"]), "att": False, "selected": True},
            {"from": f"我 → {BROKER['team']}", "subject": f"{wb} {cust}(虚构) 出口报关资料",
             "time": _cn_time(f["a6.t_email_sent"]), "att": True, "selected": False},
        ],
        "subject": f"{wb} {cust}(虚构) 出口报关资料",
        "reply": {"from": f"{BROKER['team']} <{BROKER['mail']}>", "to": f"{CHEN['name']} <{CHEN['mail']}>",
                  "time": f["a6.t_broker_reply"],
                  "body": ["陈小姐好:",
                           f"{wb} 已按附件资料申报:{item} {orig} 箱,毛重 {fmt_kg(o['gross_kg'])} KG,"
                           f"体积 {o['cbm']} CBM。提单按申报数据出。",
                           BROKER["team"]]},
        "orig": {"from": f"{CHEN['name']} <{CHEN['mail']}>", "to": f"{BROKER['team']} <{BROKER['mail']}>",
                 "time": f["a6.t_email_sent"],
                 "body": ["恒通单证组好:", f"附件为 {wb}({cust}(虚构))出口报关资料,请安排申报:",
                          f"品名:{item}({o['sku']})", f"箱数:{orig} 箱({fmt_qty(o['pieces'])} 件)",
                          f"毛重:{fmt_kg(o['gross_kg'])} KG　体积:{o['cbm']} CBM",
                          f"起运港:{POL_CN[2:]}　目的港:{POD_CN[POD[t.shipments[wb]['fba_warehouse']]]}"
                          f"(FBA {t.shipments[wb]['fba_warehouse']})",
                          "谢谢!", f"{CHEN['name']}  {FORWARDER['short']}单证组"],
                 "attachments": [f"{wb}_发票.pdf", f"{wb}_装箱单.pdf"]},
    }
    docs.append(Doc(key="A6-03", artifact="A6", file=f"03_email-to-broker_{wb}.png",
                    title=f"发给报关行的旧邮件({wb})", doc_type="邮件截图", form="截图", waybill=wb, customer=cust,
                    template="email.html.j2", viewport=(1280, 800), scale=1.5, ctx=email_ctx, clue_refs=["P4"],
                    numbers={"original_cartons": int(orig), "original_pieces": int(o["pieces"]),
                             "gross_kg": o["gross_kg"], "cbm": o["cbm"]},
                    shows=f"{_cn_time(f['a6.t_email_sent'])} 发给报关行的是原版 {orig} 箱 / {fmt_kg(o['gross_kg'])} KG;"
                          f"报关行次日按此申报;此后没有改单邮件"))
    return docs


# ---------------------------------------------------------------------------
# A7 FMS 录单界面与导入模板
# ---------------------------------------------------------------------------
def a7_docs(t: Truth) -> list[Doc]:
    f = t.facts
    wb = f["a6.waybill"]
    s = t.shipments[wb]
    rows = t.lines("A7-01")
    tot = _pl_totals(rows)
    pod = POD[s["fba_warehouse"]]
    ctx = {"user": CHEN["name"], "fms": FMS, "company": FORWARDER["short"], "waybill": wb,
           "customer": f"{s['customer']}(虚构)", "biz": "海运出口(FBA 头程)", "ship_date": s["ship_date"],
           "pol": POL_CN, "pod": POD_CN[pod], "fba": s["fba_warehouse"], "version": rows[0]["version"],
           "handler": CHEN["name"], "modified": f["a7.fms_last_modified"],
           "lines": [dict(ln, hs=HS_PLACEHOLDER.format(HS_SLOT.get(ln["sku"], "00")), declared=r["declared_name"],
                          battery=r["battery"]) for ln, r in zip(_pl_lines(rows), rows)], **tot}
    imp = t.lines("A7-02")
    docs = [
        Doc(key="A7-01", artifact="A7", file="fms_order-entry.png", title="运链通 FMS 录单界面(截图)",
            doc_type="系统截图", form="截图", waybill=wb, customer=s["customer"], template="fms_entry.html.j2",
            viewport=(1366, 768), scale=1.5, ctx=ctx, clue_refs=["K2", "P4"],
            numbers={"cartons": tot["total_ctn"], "pieces": tot["total_pcs"], "gross_kg": tot["total_gw"],
                     "cbm": tot["total_cbm"], "version": rows[0]["version"]},
            shows=f"录单界面:{wb} 已按{rows[0]['version']}改成 {tot['total_ctn']} 箱;「API 对接」按钮灰色(未开通,增值服务);"
                  "批量录入只能「导入Excel」"),
        Doc(key="A7-02", artifact="A7", file="fms_import-template.xlsx", title="运链通 FMS Excel 导入模板",
            doc_type="导入模板", form="Excel", ctx={"rows": imp}, clue_refs=["K2"],
            numbers={"example_rows": len(imp),
                     "example_waybills": sorted({r["waybill"] for r in imp})},
            shows="「导入数据」表头 19 列(带 * 必填);「填写说明」写明系统不提供外部数据接口、改单只能在界面逐票修改;"
                  f"「示例」{len(imp)} 行取自样本包两票电子来料"),
    ]
    return docs


# ---------------------------------------------------------------------------
# A8 旧 OCR 工具的合同首页与验收单
# ---------------------------------------------------------------------------
def a8_docs(t: Truth) -> list[Doc]:
    f = t.facts
    amount = int(f["a8.contract_amount_cny"])
    first, final = int(f["a8.payment_first_cny"]), int(f["a8.payment_final_cny"])
    year = f["a8.contract_year"]
    no = f"LT-CG-{year}-017"
    contract = {"no": no, "party_a": FORWARDER["cn"], "party_b": OCR_VENDOR["cn"], "product": OCR_VENDOR["product"],
                "sign_date": f["a8.sign_date"], "amount": amount, "amount_cn": cn_upper(amount),
                "first_pct": int(f["a8.payment_first_pct"]), "first": first, "first_cn": cn_upper(first),
                "final": final, "final_cn": cn_upper(final), "users": int(f["a8.license_users"]), "fms": FMS,
                "accuracy": f["a8.vendor_accuracy_claim"], "pdf": True}
    stop_y, stop_m = f["a8.stop_month"].split("-")
    acc = {"no": no, "product": OCR_VENDOR["product"], "party_a": FORWARDER["cn"], "party_b": OCR_VENDOR["cn"],
           "date": f["a8.acceptance_date"], "users": int(f["a8.license_users"]), "fms": FMS,
           "accuracy": f["a8.vendor_accuracy_claim"],
           "note_lines": [f"{int(stop_m)}月起停用:识别完还得一张张核对,", f"再手工录进FMS,比直接录还慢。—— 刘 {stop_y}.{int(stop_m)}"],
           "sign_a": "刘", "sign_b": "孟××"}
    return [
        Doc(key="A8-01", artifact="A8", file="ocr_contract_page1.pdf", title="票据识别助手采购合同(首页)",
            doc_type="合同首页", form="电子PDF", template="contract.html.j2", ctx=contract, clue_refs=["K1"],
            numbers={"amount_cny": amount, "first_cny": first, "final_cny": final, "sign_date": f["a8.sign_date"]},
            shows=f"合同金额 ¥{amount:,}({cn_upper(amount)}),{f['a8.sign_date']} 签;第二条写明「不含与{FMS}的接口对接、"
                  "数据写回」;验收标准是乙方标准样张"),
        Doc(key="A8-02", artifact="A8", file="ocr_acceptance_scan.jpg", title="票据识别助手验收单(扫描件)",
            doc_type="验收单", form="扫描件", template="acceptance.html.j2", ctx=acc, degrade=_degrade_for("A8/验收单"),
            clue_refs=["K1"],
            numbers={"acceptance_date": f["a8.acceptance_date"], "stop_month": f["a8.stop_month"],
                     "abandon_after_months": int(f["a8.abandon_after_months"])},
            shows=f"{f['a8.acceptance_date']} 同意验收(乙方样张);「与 FMS 对接」一栏写「不在合同范围」;"
                  f"手写批注「{int(stop_m)}月起停用:识别完还得一张张核对,再手工录进FMS」"),
    ]


# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
def build_docs(t: Truth | None = None) -> list[Doc]:
    t = t or load_truth()
    docs = a1_docs(t) + [a3_doc(t), a5_doc(t)] + a6_docs(t) + a7_docs(t) + a8_docs(t)
    seen = set()
    for d in docs:
        assert d.rel not in seen, d.rel
        seen.add(d.rel)
    return docs
