#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
manifest.py —— 写 scenarios/freight-docs/artifacts/manifest.yaml(方案 4.1 步骤 7)。

清单回答三件事:每个文件对应哪份资料、哪一票;藏了哪条线索;文件指纹(sha256)。裁判据此判断用户是否自己从资料里
发现了线索,check_truth.py / check_docs.py 据此自检。render_xlsx.py 与 render_docs.py 都调用 write_manifest(),
两者谁后跑都得到同一份完整清单;还没渲染出来的文件记为 status: pending。

source_sha256 是「这个文件是用哪份 HTML 渲染出来的」的凭据(check_docs 拿它判断图片/PDF 是不是按当前真值与模板
渲染的),所以只有本次真正渲染了的单据才重算(write_manifest 的 rendered 参数);别的单据沿用旧清单里的记录,
旧清单里也没有就不写。否则只跑 render_xlsx.py 刷新清单时,会把真值变了却没重渲染的图片"洗白"。

清单只由脚本生成,不要手改。
"""
from __future__ import annotations

import csv
import hashlib
from collections.abc import Callable, Iterable
from pathlib import Path

import yaml

import docs_spec as S
from gen_truth import FEE_TYPES, LOSS_COLUMNS, SCENARIO_DIR, TRUTH_DIR, VISIBLE_COLUMNS, load_params

ART = SCENARIO_DIR / "artifacts"
MANIFEST_PATH = ART / "manifest.yaml"
A2_PATH = ART / "A2" / "exceptions_q3.xlsx"
A4_PATH = ART / "A4" / "loss_q3.xlsx"
A5_XLSX = ART / "A5" / "intake_week.xlsx"
HEADER = """\
# scenarios/freight-docs/artifacts/manifest.yaml
# 由 tools/docgen/manifest.py 生成(render_xlsx.py、render_docs.py 都会调用),请勿手改;
# 改数据请改 scenario.yaml / gen_truth.py 后依次重跑 gen_truth.py → render_xlsx.py → render_docs.py。
# 用途(方案 4.1 步骤 7):每个文件对应哪份资料、哪一票、藏了哪条线索;裁判据此判断用户是否自己从资料里发现了线索。
"""
IMPLICIT = {"png": "PNG 文本块 AIGC=合成样本·训练用(tEXt + iTXt)", "jpg": "JPEG EXIF ImageDescription=合成样本·训练用",
            "pdf": "PDF 元数据 Subject=合成样本·训练用", "xlsx": "工作簿属性 description + 单元格显式标识"}


def _csv(name: str) -> list[dict]:
    with open(TRUTH_DIR / name, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _file_entry(path: Path, rel: str) -> dict:
    if path.exists():
        return {"path": rel, "sha256": sha256(path)}
    return {"path": rel, "status": "pending"}


def previous_sources(path: Path = MANIFEST_PATH) -> dict[str, str]:
    """旧清单里每个文件记录的 source_sha256(按 path);没有旧清单或读不出来时为空。"""
    if not path.exists():
        return {}
    try:
        old = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return {}
    return {f["path"]: f["source_sha256"] for a in old.get("artifacts", []) for f in a.get("files", [])
            if isinstance(f, dict) and f.get("path") and f.get("source_sha256")}


def _scenario_artifacts() -> dict:
    y = yaml.safe_load((SCENARIO_DIR / "scenario.yaml").read_text(encoding="utf-8"))
    return {a["id"]: a for a in y["artifacts"]}


# ---------------------------------------------------------------------------
# A2 / A4 / A5(Excel,render_xlsx.py 产出)
# ---------------------------------------------------------------------------
def excel_entries() -> tuple[dict, dict, dict, dict, list]:
    p = load_params()
    t = p["targets"]
    cats = p["categories"]
    exc, loss, handlers, intake = _csv("exceptions.csv"), _csv("loss.csv"), _csv("handler_volume.csv"), _csv("intake_week.csv")
    loss_by_wb: dict[str, int] = {}
    for x in loss:
        loss_by_wb[x["运单号"]] = loss_by_wb.get(x["运单号"], 0) + int(x["金额"])
    cat_loss = {c["id"]: sum(loss_by_wb.get(r["运单号"], 0) for r in exc if r["category"] == c["id"]) for c in cats}
    cat_cnt = {c["id"]: sum(1 for r in exc if r["category"] == c["id"]) for c in cats}
    new_names = {h["handler"] for h in handlers if h["is_new_hire"] == "true"}
    new_exc = sum(1 for r in exc if r["经手人"] in new_names)
    new_vol = sum(int(h["vol_q3"]) for h in handlers if h["is_new_hire"] == "true")
    vol_total = sum(int(h["vol_q3"]) for h in handlers)
    key = [r for r in exc if r["customer_canon"] == "拓浪科技"]
    key_hs = [r for r in key if r["category"] == "E_HS"]
    key_insp = sorted(r["运单号"] for r in key if r["发现环节"] == "海关查验")
    total_loss = sum(int(x["金额"]) for x in loss)
    fmt = {f: sum(int(x["count"]) for x in intake if x["format"] == f) for f in ("xlsx", "pdf", "image")}
    n_in = sum(fmt.values())
    rel = lambda path: path.relative_to(SCENARIO_DIR).as_posix()  # noqa: E731

    a2 = {
        "id": "A2", "title": "异常登记表 Q3(428 行)", "holder": "liu",
        "files": [dict(_file_entry(A2_PATH, rel(A2_PATH)), sheets=[
            {"name": "异常登记", "header_row": 2, "rows": len(exc), "columns": list(VISIBLE_COLUMNS),
             "source": "truth/exceptions.csv(只含 8 个可见列;category、image_source、loss 等真值列不出现)"},
            {"name": "经手票量", "header_row": 2, "rows": len(handlers),
             "columns": ["经手人", "入职时间", "7月", "8月", "9月", "Q3合计"], "source": "truth/handler_volume.csv"}])],
        "waybills": "见 truth/exceptions.csv 的 运单号 列(与 truth/shipments.csv 不重叠)",
        "supports": {"facts": ["P1", "K5", "RH1", "S2"], "experiments": ["X2", "X5"], "diagnosis": ["T1", "T2"]},
        "clues": [
            {"fact": "P1", "where": f"「异常登记」共 {len(exc)} 行"},
            {"fact": "K5", "where": "「异常描述」是自由文本、口径不一:同一根因有多种说法(如「改单没同步」「客户改了没跟报关行说」"
                                    "「仓库按老箱数打的板」),要自己重新归类"},
            {"fact": "RH1", "where": f"「经手票量」里 {len(new_names)} 名入职不满 6 个月的新人经手 {new_vol}/{vol_total}"
                                     f"={new_vol / vol_total:.0%} 的票;「异常登记」里新人经手 {new_exc}/{len(exc)}"
                                     f"={new_exc / len(exc):.0%},差别不大"},
            {"fact": "S2", "where": f"拓浪(客户列写作「拓浪科技」或「拓浪」)有 {len(key_insp)} 行 发现环节=海关查验:"
                                    + "、".join(key_insp)},
            {"experiment": "X2", "where": "按「异常描述」重新归类得到 " + "/".join(str(cat_cnt[c["id"]]) for c in cats)
                                          + f"(录入类中描述提到照片/扫描/手写等的 {t['keyin_image']} 件)"},
        ],
    }
    a4 = {
        "id": "A4", "title": "Q3 异常费用汇总(财务)", "holder": "wang",
        "files": [dict(_file_entry(A4_PATH, rel(A4_PATH)), sheets=[
            {"name": "汇总", "header_row": 4, "rows": len(FEE_TYPES),
             "columns": ["费用类型", "7月", "8月", "9月", "合计", "笔数", "占比"],
             "note": "按费用类型归集,不按原因;要得到按原因的金额必须和 A2 按运单号对上(X3)"},
            {"name": "明细", "header_row": 2, "rows": len(loss), "columns": list(LOSS_COLUMNS),
             "source": "truth/loss.csv"}])],
        "supports": {"facts": ["C1", "C2"], "experiments": ["X3", "X5"]},
        "clues": [
            {"fact": "C2", "where": f"「汇总」合计 {total_loss:,} 元"},
            {"fact": "C1", "where": "费用类型:" + "、".join(FEE_TYPES)},
            {"fact": "S2", "where": "「明细」里拓浪的两笔查验费"},
        ],
    }
    a5_xlsx = dict(_file_entry(A5_XLSX, rel(A5_XLSX)), role="data_source",
                   note="scenario.yaml 里 A5 的正式文件是 intake_week.png,由本表同一份数据(truth/intake_week.csv)渲染",
                   sheets=[{"name": "来料统计", "header_row": 4, "source": "truth/intake_week.csv"}])
    a5_clue = {"fact": "P3", "where": f"Excel {fmt['xlsx']}、电子PDF {fmt['pdf']}、图片/扫描件 {fmt['image']},合计 {n_in};"
                                      f"占比 {fmt['xlsx'] / n_in:.0%}/{fmt['pdf'] / n_in:.0%}/{fmt['image'] / n_in:.0%}"}
    joins = [{
        "id": "A2xA4", "artifacts": ["A2", "A4"], "key": "运单号",
        "rule": "A4「明细」的每个运单号都在 A2 且 是否产生费用=是;A2 里 是否产生费用=是 的每个运单号在 A4 至少有一行",
        "supports": {"facts": ["C3", "P2"], "experiments": ["X3", "X5"], "diagnosis": ["T1", "T3"]},
        "expected_loss_by_cause": {c["id"]: {"count": cat_cnt[c["id"]], "loss": cat_loss[c["id"]]} for c in cats},
        "expected_key_customer": {"name": "拓浪科技", "rows": len(key), "hs_rows": len(key_hs),
                                  "hs_loss": sum(loss_by_wb.get(r["运单号"], 0) for r in key_hs),
                                  "inspections": len(key_insp)},
    }]
    return a2, a4, a5_xlsx, a5_clue, joins


# ---------------------------------------------------------------------------
# 合成单据(render_docs.py 产出)
# ---------------------------------------------------------------------------
def _degrade_summary(p: dict) -> dict:
    effects = ["旋转", "模糊", "JPEG 压缩", "噪点"]
    if p["mode"] == "photo":
        effects += ["透视变形", "不均匀光照", "纸张投影"]
        effects.append("桌面背景" if p["background"] in ("wood", "desk") else "地面背景")
    else:
        effects += ["扫描边缘阴影", "不均匀光照", "去饱和与灰底", "墨点"]
    if p.get("crease"):
        effects.append("折痕")
    if p.get("watermark"):
        effects.append(f"水印({p['watermark']['text']})")
    return {"mode": {"photo": "手机拍照", "scan": "扫描/复印"}[p["mode"]], "rotate_deg": p["rotate"],
            "blur": p["blur"], "jpeg_quality": p["jpeg_quality"], "effects": effects}


def doc_file_entry(d: S.Doc, src: Callable[[S.Doc], str | None]) -> dict:
    """src(d) 给出这份单据的 source_sha256(本次渲染的按当前 HTML 重算,其余沿用旧清单),None 表示不写。"""
    e = _file_entry(d.path, d.rel)
    e["key"] = d.key
    e["title"] = d.title
    e["doc"] = d.doc_type
    e["form"] = d.form
    for k in ("waybill", "customer", "version"):
        v = getattr(d, k)
        if v:
            e[k] = v
    e["shows"] = d.shows
    e["numbers"] = d.numbers
    e["clue_refs"] = list(d.clue_refs)
    if d.template and (source := src(d)):
        e["source_sha256"] = source
    if d.degrade:
        e["degrade"] = _degrade_summary(d.degrade)
    e["label"] = {"visible": "右下角「合成样本·训练用」" if d.is_image else "页面/表格内「" + S.MARK + "」",
                  "implicit": IMPLICIT[d.kind]}
    return e


def doc_artifacts(t: S.Truth, docs: list[S.Doc], src: Callable[[S.Doc], str | None], a5_xlsx: dict,
                  a5_clue: dict) -> dict[str, dict]:
    scen = _scenario_artifacts()
    by_art: dict[str, list[S.Doc]] = {}
    for d in docs:
        by_art.setdefault(d.artifact, []).append(d)

    def base(aid: str) -> dict:
        a = scen[aid]
        return {"id": aid, "title": a["title"], "holder": a["holder"], "pattern": a["files"]}

    out: dict[str, dict] = {}
    # ---- A1 ----
    a1 = by_art["A1"]
    imgs = [d for d in a1 if d.form in S.IMAGE_FORMS]

    def f(wb: str, dtp: str) -> S.Doc:
        return next(d for d in a1 if d.waybill == wb and d.doc_type == dtp)
    p7 = next(s for s in t.shipments.values() if s["clue_ids"] == "P7")["waybill"]
    p4 = next(s for s in t.shipments.values() if s["clue_ids"] == "P4")["waybill"]
    p5 = next(s for s in t.shipments.values() if s["clue_ids"] == "P5")["waybill"]
    inv7, pl7 = f(p7, "发票"), f(p7, "装箱单")
    pl4, bl4 = f(p4, "装箱单"), f(p4, "提单")
    inv5, cd5 = f(p5, "发票"), f(p5, "报关草单")
    out["A1"] = dict(base("A1"), files=[doc_file_entry(d, src) for d in a1],
                     supports={"facts": ["K4", "P7", "P4", "P5"], "experiments": ["X1", "X4"], "diagnosis": ["T5", "T2"]},
                     composition={"docs": len(a1), "images": len(imgs), "electronic": len(a1) - len(imgs),
                                  "by_form": {k: sum(1 for d in a1 if d.form == k) for k in
                                              ("照片", "扫描件", "手写", "电子PDF", "Excel")}},
                     clues=[
                         {"fact": "K4", "where": f"{len(a1)} 份里 {len(imgs)} 份是照片/扫描件/手写(" +
                                                 "、".join(d.file for d in imgs) + ");日常来料图片只占 17%(A5)"},
                         {"fact": "P7", "waybill": p7,
                          "where": f"{inv7.file} 发票合计 {inv7.numbers['pieces']} 件 vs {pl7.file} 装箱单合计 "
                                   f"{pl7.numbers['pieces']} 件(同一货号发票与装箱单件数不同)"},
                         {"fact": "P4", "waybill": p4,
                          "where": f"{pl4.file} 装箱单「{pl4.numbers['version']}」{pl4.numbers['cartons']} 箱 / "
                                   f"{pl4.numbers['gross_kg']} KG vs {bl4.file} 提单 {bl4.numbers['cartons']} 箱 / "
                                   f"{bl4.numbers['gross_kg']} KG"},
                         {"fact": "P5", "waybill": p5,
                          "where": f"{inv5.file} 发票写明内置锂离子电池;{cd5.file} 报关草单申报品名只写"
                                   f"「{cd5.numbers['declared_name']}」、未体现带电;HS 编码为占位符,具体编码与申报要素留给作者补"},
                     ],
                     x4_support="truth/shipments.csv 的 x4_sample / x4_issue / x4_caught_stage 列(30 票、7 票不一致、5 票出货前、"
                                "2 票报关环节);样本包里 " + f"{p7}、{p4} 两票在其中")
    # ---- A3 ----
    a3 = by_art["A3"][0]
    out["A3"] = dict(base("A3"), files=[doc_file_entry(a3, src)], supports={"facts": ["P5"], "diagnosis": ["T3"]},
                     clues=[{"fact": "P5", "where": "「品名对照」靠个人整理:同一货号两人报两种编码、今年作废的老码划掉还留着、"
                                                    "多处「问报关行」;储能电源一栏申报品名仍写「电子配件」(与样本包 "
                                                    f"{cd5.file} 一致)。HS 编码一律为占位符 XXXX.XX-序号"}])
    # ---- A5 ----
    a5 = by_art["A5"][0]
    out["A5"] = dict(base("A5"), files=[doc_file_entry(a5, src), a5_xlsx],
                     supports={"facts": ["P3"], "diagnosis": ["T1"]}, clues=[a5_clue])
    # ---- A6 ----
    a6 = by_art["A6"]
    fx = t.facts
    out["A6"] = dict(base("A6"), files=[doc_file_entry(d, src) for d in a6],
                     supports={"facts": ["P4"], "diagnosis": ["T2"]},
                     clues=[{"fact": "P4", "waybill": fx["a6.waybill"],
                             "where": f"{a6[0].file}:{fx['a6.t_rev2_posted']} 客户在群里加 {fx['a6.added_cartons']} 箱、"
                                      f"改成 {fx['a6.revised_cartons']} 箱({fx['a6.revised_version']}),小陈次日只回「系统里已改」;"
                                      f"{a6[1].file}:仓库按 {fx['a6.original_cartons']} 箱打了板;{a6[2].file}:"
                                      f"{fx['a6.t_email_sent']} 发给报关行的是原版 {fx['a6.original_cartons']} 箱,报关行据此申报,"
                                      "此后没有改单邮件"}])
    # ---- A7 ----
    a7 = by_art["A7"]
    out["A7"] = dict(base("A7"), files=[doc_file_entry(d, src) for d in a7],
                     supports={"facts": ["K2"], "diagnosis": ["T4"]},
                     clues=[{"fact": "K2", "where": f"{a7[0].file}:「API 对接」按钮灰色、提示「数据接口为增值服务,当前版本未开通」;"
                                                    f"{a7[1].file}「填写说明」:系统不提供外部数据接口,批量数据只能按模板导入,"
                                                    "改单只能在界面逐票修改"}])
    # ---- A8 ----
    a8 = by_art["A8"]
    out["A8"] = dict(base("A8"), files=[doc_file_entry(d, src) for d in a8],
                     supports={"facts": ["K1"], "diagnosis": ["T4"]},
                     clues=[{"fact": "K1", "where": f"{a8[0].file}:合同金额人民币 {int(fx['a8.contract_amount_cny']):,} 元"
                                                    f"({fx['a8.sign_date']} 签),第二条写明不含与运链通 FMS 的接口对接、数据写回,"
                                                    f"验收按乙方标准样张;{a8[1].file}:{fx['a8.acceptance_date']} 同意验收,"
                                                    f"手写批注 {fx['a8.stop_month']} 起停用(识别完还要核对、再手工录进 FMS)"}])
    return out


def build_manifest(t: S.Truth | None = None, docs: list[S.Doc] | None = None, env=None,
                   rendered: Iterable[str] = (), previous: dict[str, str] | None = None) -> dict:
    """rendered:本次运行真正渲染过的单据编号(Doc.key),只有它们的 source_sha256 按当前 HTML 重算;
    previous:其余单据沿用的 source_sha256(按 path),默认读磁盘上的旧清单。"""
    t = t or S.load_truth()
    docs = docs if docs is not None else S.build_docs(t)
    env = env or S.make_env()
    done = set(rendered)
    prev = previous_sources() if previous is None else previous

    def src(d: S.Doc) -> str | None:
        return S.html_sha256(env, d) if d.key in done else prev.get(d.rel)

    p = load_params()
    a2, a4, a5_xlsx, a5_clue, joins = excel_entries()
    d = doc_artifacts(t, docs, src, a5_xlsx, a5_clue)
    arts = [d["A1"], a2, d["A3"], a4, d["A5"], d["A6"], d["A7"], d["A8"]]
    return {
        "schema_version": 0.2,
        "scenario": "freight-docs",
        "notice": S.MARK,
        "truth": {"dir": "truth/", "meta": "truth/meta.json", "params_source": p["source"],
                  "docs": ["truth/products.csv", "truth/doc_lines.csv", "truth/doc_facts.csv"]},
        "label": {"text": S.LABEL, "visible": "图片右下角;PDF 页脚;Excel 单元格",
                  "implicit": "PNG tEXt/iTXt AIGC;JPEG EXIF ImageDescription;PDF Subject;xlsx 工作簿 description"},
        "artifacts": arts,
        "joins": joins,
    }


def write_manifest(t: S.Truth | None = None, docs: list[S.Doc] | None = None, env=None,
                   rendered: Iterable[str] = ()) -> Path:
    """重写清单。rendered 必须只列本次真正渲染过的单据:render_docs.py 传全部单据,render_xlsx.py 不传
    (它不渲染单据,合成单据的 source_sha256 原样沿用,没重渲染的图片会被 check_docs 报出来)。"""
    m = build_manifest(t, docs, env, rendered=rendered)
    body = yaml.safe_dump(m, allow_unicode=True, sort_keys=False, width=110, default_flow_style=None)
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(HEADER + body, encoding="utf-8")
    return MANIFEST_PATH
