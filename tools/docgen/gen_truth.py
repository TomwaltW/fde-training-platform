#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_truth.py —— 「先造账」:为 freight-docs 场景生成一套自洽的真值账本。

对应方案 4.1 流水线的步骤 1–4(票据真值表、异常表、费用表、在真值表里注入线索)。
输出到 scenarios/freight-docs/truth/:

    shipments.csv       约 60 票,供样本包(A1)与三单交叉核对(X4)使用;含三条线索票
    exceptions.csv      Q3 异常登记 428 行 = A2 的 8 个可见列 + 隐藏真值列
    loss.csv            财务口径的费用明细(按运单号挂到异常上),合计 498,000
    customers.csv       虚构客户清单(含异常表里的简称/别名)
    handler_volume.csv  14 名单证员的 Q3 经手票量、入职时间、是否新人
    intake_week.csv     近一周来料文件统计(按星期、渠道、格式)
    products.csv        产品主数据(每箱件数、每箱毛重/体积、单价、是否带电),合成单据逐行取数用
    doc_lines.csv       合成单据逐份逐行的数字:A1 样本包 14 份,以及 A6/A7 引用的 LT2609-0412 各版本
    doc_facts.csv       A6 改单时间线、A8 旧 OCR 合同与验收单的金额与日期(金额、年份、弃用月数取自 K1)
    meta.json           关键合计与各 CSV 的 sha256

确定性:固定种子 + 各部分独立的随机流;重复运行得到字节级一致的 CSV。
所有公司、人名、数据均为虚构(合成样本·训练用)。
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import math
import random
import re
import sys
from copy import deepcopy
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENARIO_DIR = ROOT / "scenarios" / "freight-docs"
SCENARIO_YAML = SCENARIO_DIR / "scenario.yaml"
TRUTH_DIR = SCENARIO_DIR / "truth"

SEED = 20260930

# =============================================================================
# 【设定】常量块 —— 逐字取自方案 3.5 的 scenario.yaml。
# scenario.yaml 存在时,load_params() 以 YAML 为准并覆盖这里的值(来源记入 meta.json);
# 不存在时才使用这里。要改业务数字,请改 scenario.yaml,而不是只改这里。
# =============================================================================
SPEC_FALLBACK = {
    "error_log_total": 428,
    "categories": [
        {"id": "E_INCONSIST", "name": "客户资料自相矛盾(发票、装箱单、箱唛对不上)", "count": 132, "loss": 61800},
        {"id": "E_CHANGE", "name": "客户改单后未同步(系统、报关行、仓库版本不一致)", "count": 113, "loss": 148500},
        {"id": "E_HS", "name": "HS 编码、品名归类、申报要素错误", "count": 71, "loss": 212000},
        {"id": "E_KEYIN", "name": "录入手误或看错(其中 21 件来自图片或扫描件)", "count": 58, "loss": 27400},
        {"id": "E_MISSING", "name": "资料缺失或迟交", "count": 37, "loss": 38600},
        {"id": "E_OTHER", "name": "其他(地址、仓代码、标签)", "count": 17, "loss": 9700},
    ],
    "loss_total": 498000,
    "intake_formats": {"xlsx": 937, "pdf": 318, "image": 257},
    "period": "2026 年 Q3,约 19800 票",
    "key_customer": {"name": "拓浪科技(虚构)", "revenue_share": 0.18, "hs_cases": 19, "hs_loss": 86000},
    # 以下文本用于派生目标值(新人比例、拓浪占比、查验次数),并供 check_truth.py 复核
    "texts": {
        "S2": "最大客户拓浪(占营收 18%)Q3 两次因申报问题被查验延误,放话要把三成货量转走",
        "P1": "操作部有一张手工维护的《异常登记表》,Q3 共 428 条",
        "P2": "按件数,资料矛盾 31%、改单未同步 26%、HS 与申报 17%、录入手误 14%",
        "P3": "来料 62% 是 Excel、21% 是电子 PDF,只有 17% 是照片或扫描件",
        "C2": "Q3 直接损失约 49.8 万,分类明细见费用汇总",
        "C3": "按金额排,HS 与申报类最贵(21.2 万,43%),改单类第二(14.85 万,30%),录入类只有 2.74 万",
        "RH1": "刘姐说「就是那几个新人不认真」;登记表显示 5 个新人经手 31% 的票、占 34% 的异常,差别不大",
        "T1": "识别或录入不是主要错误来源(件数 13.6%、损失 5.5%;图片来料仅 17%)",
        "T2": "主因是多份单据之间、多个版本之间不一致(资料矛盾加改单未同步,件数合计 57%)",
        "T3": "按金额最贵的是 HS 与申报类(43%),目前靠个人小抄",
        "X2": "资料矛盾 132、改单未同步 113、HS 与申报 71、录入手误 58(其中图片来源 21)、缺资料 37、其他 17。",
        "X3": "先按原因归类(件数同 X2),再对上损失——HS 与申报 21.2 万、改单 14.85 万、资料矛盾 6.18 万、缺资料 3.86 万、录入 2.74 万、其他 0.97 万。件数排序和金额排序不一样。",
        "X4": "30 票里 7 票至少一处不一致;5 票出货前被人工发现,2 票流到了报关环节。",
        "X5": "拓浪占全部异常的 14%,但占 HS 与申报类的 27%(19 件),对应损失 8.6 万。",
        "A1_clues": [
            "14 份里 9 份是照片或扫描件,与日常 17% 的比例不符(指向 K4)",
            "运单 LT2609-0387 发票 1200 件、装箱单 1150 件(指向 P7)",
            "运单 LT2609-0412 装箱单有「改2」版 46 箱,提单仍是 40 箱(指向 P4)",
            "一张带电产品发票对应的报关草单品名很笼统(指向 P5;HS 细节由作者按真实经验补)",
        ],
        # 合成单据(A8 旧 OCR 合同与验收单)从这句取金额、年份与弃用月数
        "K1": "前年花 6.8 万买过 OCR 录单工具,3 个月弃用——识别完还得人工核对,再手工录进 FMS,比直接录还慢",
    },
}
# 实验结果文本里的类别简称 → 类别 id(check_truth.py 解析 X2/X3 时用)
CATEGORY_LABELS = {
    "X2": {"资料矛盾": "E_INCONSIST", "改单未同步": "E_CHANGE", "HS 与申报": "E_HS",
           "录入手误": "E_KEYIN", "缺资料": "E_MISSING", "其他": "E_OTHER"},
    "X3": {"HS 与申报": "E_HS", "改单": "E_CHANGE", "资料矛盾": "E_INCONSIST",
           "缺资料": "E_MISSING", "录入": "E_KEYIN", "其他": "E_OTHER"},
}
CN_NUM = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
# =============================================================================
# 以上为【设定】;以下是生成器自己的设计参数(不是 YAML 里的业务数字)
# =============================================================================

Q3_START = dt.date(2026, 7, 1)
Q3_END = dt.date(2026, 9, 30)
REF_DATE = Q3_END                      # 计算司龄、"新人"的基准日
NEW_HIRE_MONTHS = 6                    # 司龄 < 6 个月算新人
MONTH_VOLUME_WEIGHTS = {7: 65, 8: 66, 9: 67}     # Q3 票量按月分摊 → 6500/6600/6700
WAYBILL_MONTH_VOLUME = {5: 6200, 6: 6300, 7: 6500, 8: 6600, 9: 6700}  # 运单号月流水上限
HOLIDAYS = {dt.date(2026, 9, 25): 0.15}  # 中秋(周五)来件少
KEY_CUSTOMER = "拓浪科技"
KEY_CUSTOMER_HANDLERS = ["陈晓雯", "赵雅琴"]
NON_KEY_INSPECTIONS = 2                # 拓浪以外的海关查验件数(都在 HS 类)

# 每个类别(HS 拆成拓浪/非拓浪两组)里"产生费用"的件数
COSTED = {
    "E_INCONSIST": 64, "E_CHANGE": 92, ("E_HS", True): 17, ("E_HS", False): 44,
    "E_KEYIN": 33, "E_MISSING": 29, "E_OTHER": 11,
}
FEE_TYPES = ["改单费", "查验费", "滞港/仓储费", "罚款", "客户赔付", "其他"]

STAGES = ["录单", "出货前核对", "订舱", "入仓", "报关", "海关查验", "提单确认", "目的港", "派送", "客户反馈"]
STAGE_WEIGHTS = {
    "E_INCONSIST": {"录单": 34, "出货前核对": 16, "入仓": 25, "报关": 20, "订舱": 5},
    "E_CHANGE": {"入仓": 30, "报关": 25, "提单确认": 15, "订舱": 10, "目的港": 10, "录单": 10},
    "E_HS": {"报关": 72, "录单": 12, "客户反馈": 6, "出货前核对": 10},
    "E_KEYIN": {"提单确认": 30, "报关": 25, "入仓": 15, "客户反馈": 15, "录单": 15},
    "E_MISSING": {"报关": 35, "订舱": 25, "录单": 25, "入仓": 15},
    "E_OTHER": {"目的港": 35, "派送": 30, "入仓": 20, "客户反馈": 15},
}
COSTED_STAGE_WEIGHT = {"录单": 0.25, "出货前核对": 0.3, "订舱": 0.7, "入仓": 0.9, "报关": 1.2,
                       "海关查验": 1.0, "提单确认": 1.0, "目的港": 1.3, "派送": 1.3, "客户反馈": 1.2}

# ---------------------------------------------------------------------------
# 虚构客户(约 30 家)。名称均为编造,上线前需按方案 3.5.4 做一次名称查重。
# (名称, 异常表里可能出现的简称, 行业, 异常权重, 出货权重, HS 类倾向, 产品)
# 产品: (SKU, 品名, 申报品名, 每箱件数, 每箱毛重kg, 每箱体积m³, 单价USD, 是否带电)
# ---------------------------------------------------------------------------
CUSTOMERS = [
    ("拓浪科技", ["拓浪"], "消费电子", None, 10, 1.0, [
        ("TL-E12", "蓝牙耳机", "蓝牙耳机", 100, 9.6, 0.042, 6.8, True),
        ("TL-PB10", "移动电源10000mAh", "移动电源", 40, 12.4, 0.038, 7.5, True),
        ("TL-PS300", "便携式储能电源300W", "便携式储能电源", 2, 8.8, 0.052, 96.0, True),
        ("TL-CB01", "编织数据线1m", "数据线", 200, 10.8, 0.036, 0.9, False),
        ("TL-HD05", "车载手机支架", "手机支架", 100, 13.2, 0.048, 1.6, False)]),
    ("青禾跨境", ["青禾"], "家居收纳", 24, 3, 0.8, [
        ("QH-ZN20", "抽屉收纳盒", "塑料收纳盒", 50, 11.5, 0.085, 1.2, False),
        ("QH-YJ15", "植绒衣架", "塑料衣架", 50, 6.2, 0.030, 0.45, False)]),
    ("鲸帆电商", ["鲸帆"], "户外用品", 22, 3, 1.0, [
        ("JF-TP08", "防潮野餐垫", "野餐垫", 20, 9.8, 0.060, 3.2, False),
        ("JF-LT02", "露营挂灯", "露营灯", 40, 8.5, 0.045, 4.1, True)]),
    ("栖木家居", ["栖木"], "家具小件", 21, 3, 0.9, [
        ("SM-ST02", "折叠凳", "折叠凳", 6, 14.5, 0.110, 7.9, False),
        ("SM-SH11", "竹制置物架", "竹制置物架", 4, 12.0, 0.095, 9.5, False)]),
    ("南枝贸易", ["南枝"], "服装", 19, 2, 0.7, [
        ("NZ-HD30", "针织卫衣", "针织套头衫", 60, 16.0, 0.090, 5.6, False),
        ("NZ-LG12", "运动打底裤", "针织长裤", 100, 14.5, 0.070, 3.1, False)]),
    ("澄沐户外", [], "露营装备", 18, 2, 1.0, [
        ("CM-TN04", "四人帐篷", "帐篷", 4, 15.6, 0.120, 28.0, False),
        ("CM-CH07", "折叠月亮椅", "折叠椅", 6, 16.2, 0.130, 11.5, False)]),
    ("云屿宠物", [], "宠物用品", 17, 2, 0.9, [
        ("YY-BW05", "宠物慢食碗", "塑料宠物碗", 60, 10.5, 0.070, 1.8, False),
        ("YY-LS09", "自动伸缩牵引绳", "宠物牵引绳", 80, 12.0, 0.060, 2.6, False)]),
    ("砚舟电子", [], "电子配件", 17, 2, 2.0, [
        ("YZ-HB07", "七合一扩展坞", "扩展坞", 50, 9.2, 0.040, 12.5, False),
        ("YZ-KB61", "机械键盘", "键盘", 10, 12.8, 0.075, 18.0, False)]),
    ("麦垛生活", [], "厨房用品", 15, 2, 0.8, [
        ("MD-SP03", "硅胶锅铲", "硅胶厨具", 120, 11.0, 0.050, 0.95, False),
        ("MD-BX12", "玻璃保鲜盒", "玻璃保鲜盒", 24, 15.8, 0.070, 2.4, False)]),
    ("星渚照明", [], "LED 灯具", 15, 2, 1.8, [
        ("XZ-ST50", "LED灯带5米", "LED灯带", 100, 10.2, 0.045, 3.3, False),
        ("XZ-DL08", "太阳能庭院灯", "太阳能灯", 24, 11.6, 0.080, 4.8, True)]),
    ("蓝隼运动", [], "运动器材", 14, 2, 1.0, [
        ("LS-YM06", "瑜伽垫", "瑜伽垫", 10, 13.5, 0.110, 4.2, False),
        ("LS-RB05", "弹力带套装", "弹力带", 80, 12.0, 0.040, 1.9, False)]),
    ("若溪服饰", [], "服饰配件", 13, 1, 0.7, [
        ("RX-SC21", "针织围巾", "围巾", 120, 13.0, 0.080, 2.2, False),
        ("RX-HT03", "渔夫帽", "帽子", 150, 9.0, 0.090, 1.5, False)]),
    ("禾风母婴", [], "母婴用品", 13, 1, 1.2, [
        ("HF-BB02", "婴儿硅胶围兜", "硅胶围兜", 100, 10.0, 0.045, 1.7, False),
        ("HF-NB04", "便携奶瓶", "塑料奶瓶", 48, 9.5, 0.065, 2.9, False)]),
    ("墨芽文具", [], "文具", 12, 1, 0.8, [
        ("MY-NB10", "A5活页本", "纸质笔记本", 60, 14.0, 0.050, 1.3, False),
        ("MY-PN24", "中性笔24支装", "中性笔", 100, 12.5, 0.040, 1.1, False)]),
    ("野径户外", [], "户外用品", 12, 1, 1.0, [
        ("YJ-HL01", "户外头灯", "头灯", 60, 8.0, 0.040, 3.6, True),
        ("YJ-BT07", "运动水壶", "不锈钢水壶", 30, 13.0, 0.070, 3.0, False)]),
    ("柚光美妆", [], "美妆工具", 11, 1, 1.3, [
        ("YG-BR12", "化妆刷12支套装", "化妆刷", 100, 9.0, 0.050, 2.5, False),
        ("YG-MR05", "LED化妆镜", "化妆镜", 20, 11.0, 0.070, 6.2, True)]),
    ("铃果玩具", [], "玩具", 11, 1, 1.2, [
        ("LG-BK30", "拼插积木", "塑料积木玩具", 24, 12.0, 0.090, 4.5, False),
        ("LG-PL08", "毛绒公仔", "毛绒玩具", 50, 8.5, 0.110, 2.8, False)]),
    ("桐川五金", [], "五金工具", 10, 1, 1.4, [
        ("TC-SD32", "螺丝刀套装", "手工具套装", 40, 15.0, 0.040, 3.9, False),
        ("TC-HK20", "不锈钢挂钩", "不锈钢挂钩", 300, 14.0, 0.030, 0.35, False)]),
    ("岚岫厨具", [], "厨具", 10, 1, 1.0, [
        ("LX-PN28", "不粘煎锅28cm", "铝制煎锅", 10, 13.5, 0.085, 7.4, False),
        ("LX-KN05", "厨房刀具5件套", "刀具套装", 12, 12.0, 0.050, 9.8, False)]),
    ("霁蓝家纺", [], "家纺", 9, 1, 0.8, [
        ("JL-PC02", "真丝枕套", "枕套", 80, 9.5, 0.060, 4.0, False),
        ("JL-BL15", "法兰绒毯", "毛毯", 10, 14.0, 0.120, 6.5, False)]),
    ("橡山工具", [], "电动工具", 9, 1, 2.0, [
        ("XS-DR12", "12V锂电钻", "电钻", 6, 11.5, 0.060, 22.0, True),
        ("XS-BT20", "钻头套装", "钻头", 50, 13.0, 0.035, 2.2, False)]),
    ("拾贝饰品", [], "饰品", 8, 1, 1.3, [
        ("SB-ER40", "合金耳环", "合金耳环", 500, 6.0, 0.030, 0.6, False),
        ("SB-NK18", "锆石项链", "项链", 200, 5.5, 0.030, 1.9, False)]),
    ("雀屏智能", [], "智能家居", 8, 1, 1.8, [
        ("QP-PL01", "智能插座", "智能插座", 50, 9.0, 0.040, 5.5, False),
        ("QP-CM03", "家用监控摄像头", "摄像头", 20, 8.0, 0.050, 14.0, False)]),
    ("芒川汽配", [], "汽车配件", 7, 1, 1.5, [
        ("MC-WB24", "汽车雨刮片", "雨刮片", 50, 12.0, 0.060, 2.1, False),
        ("MC-OR10", "车载收纳袋", "车载收纳袋", 60, 10.0, 0.070, 1.6, False)]),
    ("屿森园艺", [], "园艺", 7, 1, 1.0, [
        ("YS-PT06", "陶瓷花盆", "陶瓷花盆", 12, 16.0, 0.080, 3.4, False),
        ("YS-SC03", "园艺剪", "园艺剪", 60, 13.0, 0.040, 2.7, False)]),
    ("朗渡箱包", [], "箱包", 6, 1, 1.0, [
        ("LD-BP22", "通勤双肩包", "双肩包", 20, 14.0, 0.120, 8.8, False),
        ("LD-TB05", "旅行收纳袋", "收纳袋", 100, 10.0, 0.060, 1.4, False)]),
    ("栗壳数码", [], "数码配件", 6, 1, 2.0, [
        ("LK-CS15", "手机壳", "手机保护壳", 200, 9.0, 0.050, 0.8, False),
        ("LK-CH65", "65W氮化镓充电器", "充电器", 50, 8.5, 0.035, 6.9, False)]),
    ("苇岸卫浴", [], "卫浴", 5, 1, 1.0, [
        ("WA-SH04", "增压花洒", "花洒", 20, 12.5, 0.060, 4.6, False),
        ("WA-TR02", "浴室置物架", "置物架", 12, 13.0, 0.080, 5.2, False)]),
    ("稻禾健康", [], "健身按摩", 5, 1, 2.0, [
        ("DH-MG30", "筋膜按摩枪", "按摩器", 8, 10.5, 0.050, 19.0, True),
        ("DH-RL01", "泡沫轴", "泡沫轴", 12, 6.0, 0.110, 3.1, False)]),
    ("叶舟骑行", [], "骑行配件", 4, 1, 1.0, [
        ("YZQ-LT3", "自行车尾灯", "自行车灯", 100, 8.0, 0.040, 2.4, True),
        ("YZQ-GL2", "骑行手套", "骑行手套", 120, 9.0, 0.070, 2.0, False)]),
]
CUSTOMER_ALIAS_PROB = 0.15            # 异常表里写简称的概率(手工表口径不一)

# 单证员 14 人(虚构)。陈晓雯 = 场景里的「小陈」(单证员,2 年)。
# (姓名, 入职日期, 票量权重)
HANDLERS = [
    ("陈晓雯", dt.date(2024, 9, 2), 1.12),
    ("赵雅琴", dt.date(2019, 3, 11), 1.10),
    ("孙丽娟", dt.date(2018, 7, 16), 1.05),
    ("吴佳慧", dt.date(2021, 5, 10), 1.02),
    ("郑美玲", dt.date(2020, 10, 19), 1.00),
    ("黄思敏", dt.date(2022, 8, 1), 0.98),
    ("何静", dt.date(2023, 3, 6), 0.95),
    ("马俊杰", dt.date(2023, 11, 13), 0.93),
    ("杨帆", dt.date(2025, 8, 4), 0.90),
    ("许嘉怡", dt.date(2026, 4, 20), 1.08),
    ("谢雨桐", dt.date(2026, 5, 11), 1.03),
    ("罗子豪", dt.date(2026, 5, 25), 1.00),
    ("梁欣然", dt.date(2026, 6, 8), 0.96),
    ("宋佳琪", dt.date(2026, 6, 22), 0.93),
]
NEW_HIRE_MONTH_RAMP = (0.30, 0.33, 0.37)   # 新人 7/8/9 月票量逐月爬坡

# FBA 仓代码(公开的仓库代码,只作为目的仓标识,不涉及任何主体)
FBA_CODES = ["ONT8", "LGB8", "SBD1", "LAX9", "GYR3", "PHX7", "SMF3", "FTW1", "IND9", "MDW2", "CLT2", "ABE8", "TEB9", "RDU1"]

# ---------------------------------------------------------------------------
# 异常描述模板(K5:原因栏是自由文本、口径不一)。同一根因故意用多种说法;
# 不出现类别名原文。占位符:{inv}{pl}{bl}{customs}{wh} 每行随机取同义写法。
# (模板编号, 文本, 适用发现环节(None=不限), 权重)
# ---------------------------------------------------------------------------
TEMPLATES = {
    "E_INCONSIST": [
        ("IN01", "{inv}{n1}件,{pl}{n2}件,对不上", None, 3),
        ("IN02", "{inv}和{pl}数量不一致,差{d}件", None, 3),
        ("IN03", "箱唛写{ctn1}箱,{pl}上是{ctn2}箱", ["入仓", "出货前核对", "录单"], 2),
        ("IN04", "客户给的资料自己都对不上,{inv}金额跟合同不一样", None, 1),
        ("IN05", "{pl}毛重{kg1}KG,{inv}附页写的{kg2}KG", None, 2),
        ("IN06", "同一个货{inv}写{prod},{pl}写的是{prod_alt}", None, 2),
        ("IN07", "单价乘数量跟总价不一致,客户{inv}自己算错了", ["录单", "报关", "出货前核对"], 2),
        ("IN08", "{pl}明细加起来{n2}件,汇总那行写{n1}", None, 2),
        ("IN09", "箱规算下来体积不对,{pl}写{cbm1}方,实际{cbm2}方左右", ["入仓", "订舱"], 2),
        ("IN10", "{inv}抬头和{pl}抬头不是同一个公司", ["录单", "报关"], 1),
        ("IN11", "毛重净重写反了,净重比毛重还大", None, 1),
        ("IN12", "{pl}列了{k}个SKU,{inv}只有{k1}个", None, 2),
        ("IN13", "客户两份资料打架,问了说以{pl}为准", None, 2),
        ("IN14", "箱唛上的型号和{inv}不一致", ["入仓", "出货前核对"], 2),
        ("IN15", "数量对不上,客户自己也说不清哪个对", None, 2),
        ("IN16", "{inv}币种写RMB,{pl}后面的金额又是美金", ["录单", "报关"], 1),
        ("IN17", "装柜清单和{pl}箱数差{dc}箱", ["入仓", "订舱"], 1),
        ("IN18", "客户资料前后不一,{inv}总数{n1},{pl}总数{n2}", None, 2),
        ("IN19", "每箱件数跟{pl}写的不一样,抽了几箱都是{pcs2}个一箱", ["入仓"], 1),
        ("IN20", "{inv}跟{pl}又不一样,客户说就是写错了", None, 1),
        ("IN21", "实际到仓{ctn2}箱,客户{pl}写{ctn1}箱,不知道哪个准", ["入仓"], 1),
    ],
    "E_CHANGE": [
        ("CH01", "客户改了没跟{customs}说", None, 3),
        ("CH02", "改单没同步", None, 3),
        ("CH03", "{wh}按老箱数打的板", ["入仓", "订舱"], 3),
        ("CH04", "客户晚上在群里把箱数从{ctn1}改成{ctn2},第二天{customs}报的还是{ctn1}", ["报关"], 2),
        ("CH05", "{customs}拿的是旧版{inv}", ["报关"], 3),
        ("CH06", "系统里改了,{wh}还是原来的", ["入仓"], 2),
        ("CH07", "客户临时加了{dc}箱,{bl}没改过来", ["提单确认", "目的港"], 2),
        ("CH08", "改2版的{pl}没发给{customs}", ["报关"], 2),
        ("CH09", "客户换了一个SKU,只改了{pl},{inv}没换", None, 2),
        ("CH10", "群里改的那条消息漏看了", None, 2),
        ("CH11", "客户邮件改了一次微信又改一次,用错版本", None, 2),
        ("CH12", "入仓数和最新资料对不上,客户说前天就改了", ["入仓"], 2),
        ("CH13", "截关前客户改数量,{customs}来不及改", ["报关"], 2),
        ("CH14", "版本搞混,发出去的是第一版", None, 2),
        ("CH15", "客户撤了{dc}箱没通知{wh},多打了一板", ["入仓", "订舱"], 1),
        ("CH16", "客户改了收货仓,{bl}和订舱还是原来的", ["提单确认", "目的港", "订舱"], 2),
        ("CH17", "又改单,报关用的老数据", ["报关"], 2),
        ("CH18", "客户说改过了,我们这边没收到最新的", None, 2),
        ("CH19", "改完以后{pl}和{bl}箱数不一样,{ctn2}对{ctn1}", ["提单确认", "目的港"], 2),
        ("CH20", "{wh}按{ctn1}箱入的,客户后来改成{ctn2}箱", ["入仓"], 2),
        ("CH21", "数量前后不一致,客户说中间改过一次", None, 1),
        ("CH22", "夜里改的单早上没人看到,按旧的走了", None, 2),
    ],
    "E_HS": [
        ("HS01", "{prod}归类有问题,{customs}退回来要重新归", ["报关"], 3),
        ("HS02", "申报要素没写全,缺品牌型号", None, 3),
        ("HS03", "品名报得太笼统,被要求补充", ["报关"], 3),
        ("HS04", "带电的没按带电报,{customs}打回", ["报关", "录单"], 2),
        ("HS05", "编码是按老对照表套的,今年已经调了", None, 2),
        ("HS06", "{prod}套了{prod_alt}的编码,税率不一样", None, 2),
        ("HS07", "材质那栏没写,要补申报要素", None, 2),
        ("HS08", "{customs}说这个编码要监管证件,客户没有", ["报关"], 2),
        ("HS09", "品牌写的无品牌,实际外箱有logo", None, 2),
        ("HS10", "新品不知道怎么报,随手套了个以前的", None, 2),
        ("HS11", "用途写错了,要求说明", ["报关"], 1),
        ("HS12", "成分比例没报,补资料", None, 1),
        ("HS13", "申报价格偏低被质疑,要补价格说明", ["报关"], 1),
        ("HS14", "同一个品两个人报的编码不一样", None, 2),
        ("HS15", "{prod}到底归哪类,问了几个人说法都不一样", ["录单", "出货前核对"], 2),
        ("HS16", "报关品名跟实物对不上", None, 2),
        ("HS17", "规格型号漏报,删单重报", ["报关"], 2),
        ("HS18", "{inv}品名和报关品名不是一个东西", None, 1),
        ("HS19", "小抄上的编码是错的,一直这么报", None, 1),
    ],
    "E_HS_INSPECT": [
        ("HI01", "被海关查验,申报品名和实物不符,压了{days}天", None, 1),
        ("HI02", "查验!{prod}申报要素不全,货在港区扣了{days}天", None, 1),
        ("HI03", "抽中查验,编码归错,改完才放行,耽误{days}天", None, 1),
        ("HI04", "海关查验发现带电没申报,耽误{days}天", None, 1),
    ],
    "E_KEYIN": [
        ("KE01", "录系统时多打了个0", None, 2),
        ("KE02", "毛重净重填反了", None, 2),
        ("KE03", "件数录成了箱数", None, 2),
        ("KE04", "收货人复制错了一行", None, 1),
        ("KE05", "{bl}上的件数录错,{n1}录成{n2}", ["提单确认", "报关"], 2),
        ("KE06", "Excel复制粘贴错行,两票的数据串了", None, 2),
        ("KE07", "单价小数点点错一位", None, 1),
        ("KE08", "柜型选错了", ["提单确认", "入仓"], 1),
        ("KE09", "录单时漏了一行SKU", None, 2),
        ("KE10", "重量录错,{kg1}录成{kg2}", None, 2),
        ("KE11", "我自己看错了,{ctn1}箱写成{ctn2}箱", None, 2),
        ("KE12", "资料挂到别的单上了,运单号对错", None, 1),
        ("KE13", "两个SKU的数量录反了", None, 2),
        ("KE14", "体积录错一位", None, 1),
    ],
    "E_KEYIN_IMAGE": [   # 这 21 件的描述里都有"图片/扫描"类线索,便于 X2 拆出"图片来源 21"
        ("KI01", "客户发的照片太糊,{n1}看成{n2}了", None, 2),
        ("KI02", "扫描件看不清,毛重录错", None, 2),
        ("KI03", "手机拍的{pl}反光,箱数看错", None, 2),
        ("KI04", "客户发的截图,型号字母看错一位", None, 1),
        ("KI05", "手写的单子,1和7分不清,录错了", None, 2),
        ("KI06", "图片是歪的,看串行了,数量录到下一行", None, 2),
        ("KI07", "扫描件糊了一块,猜着录的,错了", None, 1),
        ("KI08", "照片拍得不全,最后一行漏录", None, 2),
        ("KI09", "客户拍照发来的{inv},金额小数点看错", None, 1),
        ("KI10", "传真件太淡,重量看错", None, 1),
        ("KI11", "{pl}是手机拍的,{ctn1}看成{ctn2}", None, 2),
        ("KI12", "群里发的图压缩了,数字看不清,录错", None, 2),
    ],
    "E_MISSING": [
        ("MI01", "客户迟迟不给{inv}", None, 2),
        ("MI02", "截关前还没收到{pl}", ["报关", "订舱"], 2),
        ("MI03", "带电的缺MSDS和电池测试报告", ["订舱", "报关"], 2),
        ("MI04", "资料晚到,赶不上这班船", ["订舱", "报关"], 2),
        ("MI05", "申报要素的资料客户一直没给", ["报关"], 2),
        ("MI06", "少一份{pl},催了三次", None, 2),
        ("MI07", "客户说发了其实没发", None, 2),
        ("MI08", "缺报关委托书", ["报关"], 1),
        ("MI09", "等资料等到截关,甩柜了", ["报关", "订舱"], 2),
        ("MI10", "空派的缺签字盖章版{inv}", ["报关", "录单"], 1),
        ("MI11", "品牌授权没给,报不了", ["报关"], 1),
        ("MI12", "资料只给了一半,剩下的说明天给", None, 2),
        ("MI13", "周五晚上才发资料,周末没人弄", None, 1),
        ("MI14", "缺箱唛照片,{wh}没法核", ["入仓"], 1),
    ],
    "E_OTHER": [
        ("OT01", "仓库代码{fba}写成{fba2},送错仓", ["目的港", "派送"], 2),
        ("OT02", "收件地址少了门牌号", ["派送", "目的港"], 2),
        ("OT03", "外箱标签贴错了", ["入仓", "目的港", "派送"], 2),
        ("OT04", "FBA预约过期,重新约", ["目的港", "派送"], 2),
        ("OT05", "Shipment ID填错一位", None, 1),
        ("OT06", "派送地址邮编不对,退回", ["派送"], 1),
        ("OT07", "箱标打印不清,扫不出来", None, 1),
        ("OT08", "{fba}拒收,标签位置不对", ["目的港", "派送"], 1),
        ("OT09", "客户给的仓库地址是旧的", None, 1),
        ("OT10", "托盘标签漏贴", ["入仓", "目的港"], 1),
    ],
}
IMAGE_CUE_WORDS = ["照片", "扫描", "拍的", "截图", "手写", "图片", "传真", "的图", "拍照"]

SYNONYMS = {
    "inv": ["发票", "发票", "发票", "CI", "invoice", "商业发票"],
    "pl": ["装箱单", "装箱单", "箱单", "PL", "packing"],
    "bl": ["提单", "提单", "提单草稿", "B/L"],
    "customs": ["报关行", "报关行", "报关那边", "报关公司", "关务"],
    "wh": ["仓库", "仓库", "仓里", "仓库那边"],
}
STAGE_PREFIX = {
    "入仓": ["仓库说", "仓库反馈:", "入仓时发现"],
    "报关": ["报关行反馈:", "报关那边说"],
    "目的港": ["目的港反馈:", "海外仓说"],
    "派送": ["派送那边说", "海外仓反馈:"],
    "客户反馈": ["客户投诉:", "客户说", "客户那边反馈"],
}
GENERIC_PREFIX = ["又是", "今天发现", "查了下,", "注意:", "补记:"]
SUFFIXES = [("", 30), ("。", 10), ("!", 4), ("!!", 2), (",已处理", 6), (",第二次了", 3), (",下次注意", 4),
            ("(待跟进)", 3), (",已跟客户确认", 5), (",客户不认", 2), (",刘姐知道", 1.5)]

# 处理方式:ANY 不论是否有费用都可用;COST 暗示产生了费用,只用于"是否产生费用=是"的行
HANDLING = {
    "E_INCONSIST": {"ANY": ["跟客户确认后以装箱单为准", "让客户重发发票", "客户确认数量后更正", "按实际入仓数据改", "已改",
                            "退回客户重做资料", "按发票数量走,客户确认过", "重新核对后出货"],
                    "COST": ["报关行按新资料重做", "提单改单", "复称复尺后更正"]},
    "E_CHANGE": {"ANY": ["已跟客户说以后改单要发邮件", "按最新版本重新出资料", "仓库重新点数", "补发最新版给报关行",
                         "跟客户确认最终版"],
                 "COST": ["重新打板", "通知报关行改单", "提单改单", "删单重报", "改单后放行"]},
    "E_HS": {"ANY": ["补申报要素", "改品名后再报", "已更新小抄", "按报关行意见改了", "问了报关行再报"],
             "COST": ["报关行改编码重报", "删单重报", "改品名后重新申报", "客户补资料后放行"]},
    "E_HS_INSPECT": {"ANY": [], "COST": ["配合查验,补资料后放行", "查验后改单放行", "配合查验,已跟客户解释",
                                         "查验放行,客户要求赔付"]},
    "E_KEYIN": {"ANY": ["已更正", "重新录入", "改了", "跟仓库核对后更正", "补录后重新推送"],
                "COST": ["提单改单", "联系船东更正"]},
    "E_MISSING": {"ANY": ["催客户补资料", "等资料", "客户补发后放行", "先报关后补"],
                  "COST": ["改下一班船", "甩柜,改船期", "客户补齐后重新订舱"]},
    "E_OTHER": {"ANY": ["客户重新预约", "补贴标签"],
                "COST": ["改派", "重新贴标", "更正地址后重新派送", "联系海外仓重新预约"]},
}
COSTLY_TPL = {"MI04", "MI09", "HS17", "CH15"}       # 描述本身暗示有费用,只给"产生费用"的行
BATTERY_TPL = {"HS04", "HI04", "MI03"}              # 只给有带电产品的客户
HANDLING_BLANK_PROB = 0.10

VAGUE_DECLARED_NAMES = ["电子配件", "电子产品", "配件", "电源"]

FEE_NOTES = {
    "改单费": ["报关行改单", "删单重报", "提单更正", "舱单更改", "改单", ""],
    "查验费": ["海关查验", "查验吊柜"],
    "滞港/仓储费": ["港区堆存", "超期仓储", "重新打板", "等资料压仓", "查验期间堆存", ""],
    "罚款": ["海关罚款"],
    "客户赔付": ["延误赔付", "客户索赔(延误)", "延误补偿"],
    "其他": ["加急费", "重新贴标", "改派费", "甩柜费", "复称复尺", "人工加班", ""],
}


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def apportion(total: int, weights: list[float]) -> list[int]:
    """最大余数法:按权重把整数 total 分摊成整数,合计严格等于 total。"""
    s = float(sum(weights))
    raw = [total * w / s for w in weights]
    base = [int(math.floor(r)) for r in raw]
    rem = total - sum(base)
    order = sorted(range(len(weights)), key=lambda i: (-(raw[i] - base[i]), i))
    for i in order[:rem]:
        base[i] += 1
    return base


def weighted_sample(rng: random.Random, items: list, weights: list[float], k: int) -> list:
    """不放回加权抽样(Efraimidis–Spirakis),确定性。"""
    keyed = [(rng.random() ** (1.0 / w), i) for i, w in enumerate(weights)]
    keyed.sort(key=lambda t: (-t[0], t[1]))
    return [items[i] for _, i in keyed[:k]]


def months_between(d0: dt.date, d1: dt.date) -> float:
    return (d1 - d0).days / 30.4375


def stream(name: str) -> random.Random:
    """每个生成部分用独立随机流,改一处不牵连别处。"""
    h = int(hashlib.sha256(f"{SEED}:{name}".encode()).hexdigest()[:12], 16)
    return random.Random(h)


def round_amount(x: float) -> int:
    step = 100 if x >= 1000 else 50
    return max(step, int(round(x / step)) * step)


def csv_bytes(header: list[str], rows: list[list]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    for r in rows:
        w.writerow(r)
    return buf.getvalue().encode("utf-8")


def q3_days() -> list[dt.date]:
    return [Q3_START + dt.timedelta(i) for i in range((Q3_END - Q3_START).days + 1)]


# ---------------------------------------------------------------------------
# 参数:优先读 scenario.yaml
# ---------------------------------------------------------------------------
def load_params() -> dict:
    p = deepcopy(SPEC_FALLBACK)
    p["source"] = "gen_truth.py SPEC_FALLBACK(scenario.yaml 不存在)"
    if SCENARIO_YAML.exists():
        import yaml  # noqa: WPS433
        y = yaml.safe_load(SCENARIO_YAML.read_text(encoding="utf-8"))
        t = y["truth"]
        p["error_log_total"] = int(t["error_log_total"])
        p["categories"] = [{"id": c["id"], "name": c["name"], "count": int(c["count"]), "loss": int(c["loss"])}
                           for c in t["error_categories"]]
        p["loss_total"] = int(t["loss_total"])
        p["intake_formats"] = {k: int(v) for k, v in t["intake_formats"].items()}
        p["period"] = t["period"]
        kc = t["key_customer"]
        p["key_customer"] = {"name": kc["name"], "revenue_share": kc["revenue_share"],
                             "hs_cases": int(kc["hs_cases"]), "hs_loss": int(kc["hs_loss"])}
        facts = {f["id"]: f["statement"] for f in y.get("facts", [])}
        exps = {x["id"]: x["result"] for x in y.get("experiments", [])}
        for k in list(p["texts"].keys()):
            if k in facts:
                p["texts"][k] = facts[k]
            elif k in exps:
                p["texts"][k] = exps[k]
            elif k in {d["id"]: d for d in t.get("diagnosis_items", [])}:
                p["texts"][k] = {d["id"]: d["statement"] for d in t["diagnosis_items"]}[k]
        arts = {a["id"]: a for a in y.get("artifacts", [])}
        if "A1" in arts and arts["A1"].get("clues"):
            p["texts"]["A1_clues"] = list(arts["A1"]["clues"])
        p["source"] = "scenarios/freight-docs/scenario.yaml"
    p["targets"] = derive_targets(p)
    return p


def derive_targets(p: dict) -> dict:
    """把 YAML 里的文字型设定(比例、次数)换算成整数目标。"""
    total = p["error_log_total"]
    m = re.search(r"约\s*(\d+)\s*票", p["period"])
    volume = int(m.group(1))
    keyin = next(c for c in p["categories"] if c["id"] == "E_KEYIN")
    m = re.search(r"其中\s*(\d+)\s*件", keyin["name"])
    keyin_image = int(m.group(1))
    m = re.search(r"(\d+)\s*个新人经手\s*(\d+)%\s*的票、占\s*(\d+)%\s*的异常", p["texts"]["RH1"])
    n_new, new_vol_pct, new_exc_pct = int(m.group(1)), int(m.group(2)), int(m.group(3))
    m = re.search(r"占全部异常的\s*(\d+)%", p["texts"]["X5"])
    key_share_pct = int(m.group(1))
    m = re.search(r"Q3\s*([一两二三四五六七八九十])次.*查验", p["texts"]["S2"])
    inspections = CN_NUM[m.group(1)]
    return {
        "volume_q3": volume,
        "keyin_image": keyin_image,
        "new_hires": n_new,
        "new_hire_volume": int(round(volume * new_vol_pct / 100)),
        "new_hire_exceptions": int(round(total * new_exc_pct / 100)),
        "new_hire_volume_pct": new_vol_pct,
        "new_hire_exception_pct": new_exc_pct,
        "key_rows": int(round(total * key_share_pct / 100)),
        "key_share_pct": key_share_pct,
        "key_hs": p["key_customer"]["hs_cases"],
        "key_hs_loss": p["key_customer"]["hs_loss"],
        "key_inspections": inspections,
    }


# ---------------------------------------------------------------------------
# 1. 票据真值表(含步骤 4 注入线索)
# ---------------------------------------------------------------------------
def cust_by_name() -> dict:
    return {c[0]: c for c in CUSTOMERS}


def waybill_date(month: int, seq: int, year: int = 2026) -> dt.date:
    first = dt.date(year, month, 1)
    nxt = dt.date(year + (month // 12), month % 12 + 1, 1)
    days = (nxt - first).days
    vol = WAYBILL_MONTH_VOLUME[month]
    return first + dt.timedelta(days=min(days - 1, int((seq - 1) / vol * days)))


def make_shipment(rng, wb, customer, lines, channel, fba, pl_version="原版"):
    """lines: [(product, cartons)]"""
    cust = cust_by_name()[customer]
    sku_parts, gross, vol, amount, pieces, cartons = [], 0.0, 0.0, 0.0, 0, 0
    decl, desc, battery = [], [], False
    for prod, ctn in lines:
        sku, name, dname, ppc, kg, cbm, usd, batt = prod
        pcs = ctn * ppc
        sku_parts.append(f"{sku} {name} {pcs}件/{ctn}箱")
        gross += ctn * kg
        vol += ctn * cbm
        amount += pcs * usd
        pieces += pcs
        cartons += ctn
        if dname not in decl:
            decl.append(dname)
        if name not in desc:
            desc.append(name)
        battery = battery or batt
    seq = int(wb.split("-")[1])
    gross = round(gross, 1)
    return {
        "waybill": wb, "ship_date": waybill_date(9, seq).isoformat(), "customer": customer,
        "industry": cust[2], "channel": channel, "fba_warehouse": fba,
        "sku_lines": "; ".join(sku_parts), "sku_count": len(lines),
        "cartons": cartons, "pieces": pieces, "gross_weight_kg": f"{gross:.1f}", "volume_cbm": f"{vol:.2f}",
        "invoice_desc": "、".join(desc), "declared_name": "、".join(decl),
        "amount_usd": f"{amount:.2f}", "battery": "是" if battery else "否",
        "inv_pieces": pieces, "pl_version": pl_version, "bl_cartons": cartons, "bl_gross_kg": f"{gross:.1f}",
        "clue_ids": "", "clue_note": "", "x4_sample": "false", "x4_issue": "", "x4_caught_stage": "",
        "a1_docs": "",
    }


SHIPMENT_COLUMNS = [
    "waybill", "ship_date", "customer", "industry", "channel", "fba_warehouse", "sku_lines", "sku_count",
    "cartons", "pieces", "gross_weight_kg", "volume_cbm", "invoice_desc", "declared_name", "amount_usd",
    "battery", "inv_pieces", "pl_version", "bl_cartons", "bl_gross_kg", "clue_ids", "clue_note",
    "x4_sample", "x4_issue", "x4_caught_stage", "a1_docs",
]


def gen_shipments(p: dict) -> list[dict]:
    rng = stream("shipments")
    cb = cust_by_name()
    prods = {c[0]: {pr[0]: pr for pr in c[6]} for c in CUSTOMERS}
    rows = []

    # --- 线索票 1:LT2609-0387 发票 1200 件、装箱单 1150 件(P7) ---
    s = make_shipment(rng, "LT2609-0387", "青禾跨境",
                      [(prods["青禾跨境"]["QH-ZN20"], 12), (prods["青禾跨境"]["QH-YJ15"], 11)], "海运", "ONT8")
    s["inv_pieces"] = 1200          # 发票两行各 600 件;装箱单第二行只有 550 件
    usd = 600 * 1.2 + 600 * 0.45
    s["amount_usd"] = f"{usd:.2f}"
    s["clue_ids"] = "P7"
    s["clue_note"] = "发票 QH-ZN20×600 + QH-YJ15×600 = 1200 件;装箱单 QH-YJ15 只有 550 件(11 箱),合计 1150 件"
    assert s["pieces"] == 1150
    rows.append(s)

    # --- 线索票 2:LT2609-0412 装箱单「改2」46 箱,提单仍是 40 箱(P4) ---
    s = make_shipment(rng, "LT2609-0412", "栖木家居", [(prods["栖木家居"]["SM-ST02"], 46)], "海运", "LGB8",
                      pl_version="改2")
    s["bl_cartons"] = 40
    s["bl_gross_kg"] = f"{40 * 14.5:.1f}"
    s["clue_ids"] = "P4"
    s["clue_note"] = "客户夜里在群里加了 6 箱,装箱单改2 版 46 箱;提单(与报关行手里的旧邮件版)仍按原版 40 箱"
    rows.append(s)

    # --- 线索票 3:带电产品,报关草单品名笼统(P5) ---
    s = make_shipment(rng, "LT2609-0446", KEY_CUSTOMER, [(prods[KEY_CUSTOMER]["TL-PS300"], 60)], "海运", "SBD1")
    s["invoice_desc"] = "便携式储能电源300W(内置锂离子电池 288Wh)"
    s["declared_name"] = "电子配件"
    s["clue_ids"] = "P5"
    s["clue_note"] = "发票写明内置锂电池,报关草单品名只写「电子配件」、未体现带电;具体 HS 编码与申报要素留给作者按真实经验补"
    rows.append(s)

    # --- 其余 57 票 ---
    fixed = {387, 412, 446}
    seqs = sorted(rng.sample([n for n in range(1, WAYBILL_MONTH_VOLUME[9] + 1) if n not in fixed], 57))
    names = [c[0] for c in CUSTOMERS]
    ship_w = [c[4] for c in CUSTOMERS]
    for seq in seqs:
        cname = rng.choices(names, weights=ship_w)[0]
        cust = cb[cname]
        channel = "海运" if rng.random() < 0.7 else "空派"
        plist = list(cust[6])
        if channel == "空派":
            plist = [pr for pr in plist if not pr[7]] or plist
        k = min(len(plist), rng.choice([1, 1, 2, 2, 3]))
        chosen = rng.sample(plist, k)
        lines = []
        for pr in chosen:
            ctn = rng.randint(6, 60) if channel == "海运" else rng.randint(2, 18)
            lines.append((pr, ctn))
        if any(pr[7] for pr, _ in lines):
            channel = "海运"
        pv = "改1" if rng.random() < 0.12 else "原版"
        rows.append(make_shipment(rng, f"LT2609-{seq:04d}", cname, lines, channel, rng.choice(FBA_CODES), pv))

    rows.sort(key=lambda r: r["waybill"])
    by_wb = {r["waybill"]: r for r in rows}
    others = [r["waybill"] for r in rows if not r["clue_ids"]]

    # --- X4:抽 30 票做三单交叉核对;7 票不一致,5 票出货前发现,2 票流到报关 ---
    x4_others = sorted(rng.sample(others, 28))
    for wb in ["LT2609-0387", "LT2609-0412"] + x4_others:
        by_wb[wb]["x4_sample"] = "true"
    by_wb["LT2609-0387"].update(x4_issue="件数不一致(发票 vs 装箱单)", x4_caught_stage="出货前")
    by_wb["LT2609-0412"].update(x4_issue="箱数不一致(装箱单改2 vs 提单)", x4_caught_stage="报关环节")
    issue_plan = [("件数", "出货前"), ("件数", "报关环节"), ("毛重", "出货前"), ("毛重", "出货前"), ("箱数", "出货前")]
    for (kind, stage), wb in zip(issue_plan, sorted(rng.sample(x4_others, 5))):
        r = by_wb[wb]
        if kind == "件数":
            ppc = max(1, r["pieces"] // max(1, r["cartons"]))
            r["inv_pieces"] = r["pieces"] + ppc * rng.choice([1, 2, -1])
            r["x4_issue"] = "件数不一致(发票 vs 装箱单)"
        elif kind == "毛重":
            r["bl_gross_kg"] = f"{float(r['gross_weight_kg']) + rng.choice([-1, 1]) * rng.randint(25, 80):.1f}"
            r["x4_issue"] = "毛重不一致(装箱单 vs 提单)"
        else:
            r["bl_cartons"] = r["cartons"] + (rng.choice([-2, -1, 1, 2]) if r["cartons"] > 2 else rng.choice([1, 2]))
            r["x4_issue"] = "箱数不一致(装箱单 vs 提单)"
        r["x4_caught_stage"] = stage

    # --- A1 样本包(14 份,9 份照片/扫描/手写)的组成计划,供后续渲染使用 ---
    plain = [wb for wb in others if not by_wb[wb]["x4_issue"]]
    s4, s5, s6, s7 = sorted(rng.sample(plain, 4))
    a1_plan = {
        "LT2609-0387": "发票:照片|装箱单:Excel",
        "LT2609-0412": "装箱单(改2):电子PDF|提单:扫描件",
        "LT2609-0446": "发票:照片|报关草单:扫描件",
        s4: "发票:手写|装箱单:手写",
        s5: "装箱单:照片|箱唛:照片",
        s6: "发票:电子PDF|装箱单:扫描件",
        s7: "发票:Excel|装箱单:电子PDF",
    }
    for wb, docs in a1_plan.items():
        by_wb[wb]["a1_docs"] = docs
    return rows


# ---------------------------------------------------------------------------
# 2. 异常表
# ---------------------------------------------------------------------------
def gen_handler_volume(p: dict) -> list[dict]:
    rng = stream("handler_volume")
    t = p["targets"]
    vol_total, new_total = t["volume_q3"], t["new_hire_volume"]
    is_new = [months_between(h[1], REF_DATE) < NEW_HIRE_MONTHS for h in HANDLERS]
    assert sum(is_new) == t["new_hires"], "HANDLERS 里的新人数与 RH1 不一致"
    totals = [0] * len(HANDLERS)
    for grp, gtotal in ((True, new_total), (False, vol_total - new_total)):
        idx = [i for i, n in enumerate(is_new) if n == grp]
        w = [HANDLERS[i][2] * rng.uniform(0.97, 1.03) for i in idx]
        for i, v in zip(idx, apportion(gtotal, w)):
            totals[i] = v
    month_tot = apportion(vol_total, list(MONTH_VOLUME_WEIGHTS.values()))
    ideal = []
    for i, tot in enumerate(totals):
        ramp = NEW_HIRE_MONTH_RAMP if is_new[i] else (0.335, 0.333, 0.332)
        ideal.append([tot * r for r in ramp])
    matrix = [[0, 0, 0] for _ in HANDLERS]
    for m in range(2):
        alloc = apportion(month_tot[m], [ideal[i][m] for i in range(len(HANDLERS))])
        for i, v in enumerate(alloc):
            matrix[i][m] = v
    for i in range(len(HANDLERS)):
        matrix[i][2] = totals[i] - matrix[i][0] - matrix[i][1]
        assert matrix[i][2] > 0
    out = []
    for i, (name, hired, _) in enumerate(HANDLERS):
        out.append({"handler": name, "hire_date": hired.isoformat(),
                    "tenure_months": f"{months_between(hired, REF_DATE):.1f}",
                    "is_new_hire": "true" if is_new[i] else "false",
                    "vol_jul": matrix[i][0], "vol_aug": matrix[i][1], "vol_sep": matrix[i][2],
                    "vol_q3": totals[i]})
    return out


def fill_slots(rng: random.Random, cust: tuple, all_products: list) -> dict:
    prods = cust[6]
    prod = rng.choice(prods)[1]
    same = [pr[1] for pr in prods if pr[1] != prod]
    alt = rng.choice(same) if same else rng.choice([pr[1] for pr in all_products if pr[1] != prod])
    n1 = rng.choice([rng.randint(20, 300) * 10, rng.randint(4, 60) * 50])
    d = rng.choice([10, 20, 24, 30, 48, 50, 60, 100, 120, 200])
    n2 = n1 - d if n1 - d > 0 else n1 + d
    ctn1 = rng.randint(8, 80)
    dc = rng.choice([1, 2, 2, 3, 4, 5, 6, 8])
    ctn2 = ctn1 + dc if rng.random() < 0.6 else max(1, ctn1 - dc)
    dc = abs(ctn2 - ctn1)
    kg1 = rng.randint(120, 2600)
    kg2 = kg1 + rng.choice([-1, 1]) * rng.randint(6, 90)
    cbm1 = round(rng.uniform(1.2, 9.8), 1)
    cbm2 = round(cbm1 + rng.choice([-1, 1]) * rng.uniform(0.5, 2.0), 1)
    k = rng.randint(3, 8)
    fba = rng.choice(FBA_CODES)
    fba2 = rng.choice([fba.replace("O", "0", 1) if "O" in fba else fba[:-1] + str((int(fba[-1]) + 1) % 10),
                       rng.choice([c for c in FBA_CODES if c != fba])])
    # 看错类:一位数字看串
    conf = {"6": "8", "8": "6", "1": "7", "7": "1", "3": "8", "5": "6", "0": "8", "9": "0", "2": "7", "4": "9"}
    s = str(n1)
    pos = rng.randrange(len(s))
    n1_mis = int(s[:pos] + conf[s[pos]] + s[pos + 1:]) if not (pos == 0 and conf[s[pos]] == "0") else n1 + 100
    slots = {
        "prod": prod, "prod_alt": alt, "n1": n1, "n2": n2, "d": abs(n1 - n2), "ctn1": ctn1, "ctn2": ctn2,
        "dc": dc, "kg1": kg1, "kg2": kg2, "cbm1": cbm1, "cbm2": cbm2, "k": k, "k1": k - rng.choice([1, 2]),
        "pcs2": rng.choice([10, 12, 20, 24, 30, 40, 48]), "days": rng.randint(3, 9), "fba": fba, "fba2": fba2,
        "n1_mis": n1_mis,
    }
    for key, opts in SYNONYMS.items():
        slots[key] = rng.choice(opts)
    return slots


def render_desc(rng, cat, stage, cust, all_products, image, inspection, costed) -> tuple[str, str]:
    if inspection:
        pool = TEMPLATES["E_HS_INSPECT"]
    elif cat == "E_KEYIN" and image:
        pool = TEMPLATES["E_KEYIN_IMAGE"]
    else:
        pool = TEMPLATES[cat]
    has_battery = any(pr[7] for pr in cust[6])
    usable = [t for t in pool if (costed or t[0] not in COSTLY_TPL) and (has_battery or t[0] not in BATTERY_TPL)]
    cand = [t for t in usable if t[2] is None or stage in t[2]] or usable
    tid, text, _, _ = rng.choices(cand, weights=[t[3] for t in cand])[0]
    slots = fill_slots(rng, cust, all_products)
    if tid in ("KI01",):
        slots["n2"] = slots["n1_mis"]
    body = text.format(**slots)
    # 前缀:优先按发现环节,偶尔用泛用前缀
    r = rng.random()
    if stage in STAGE_PREFIX and r < 0.30:
        body = rng.choice(STAGE_PREFIX[stage]) + body
    elif r > 0.88:
        body = rng.choice(GENERIC_PREFIX) + body
    body += rng.choices([x[0] for x in SUFFIXES], weights=[x[1] for x in SUFFIXES])[0]
    # 标点口径不一:约三成用半角逗号或空格
    r = rng.random()
    if r < 0.2:
        body = body.replace(",", ",")
    elif r < 0.3:
        body = body.replace(",", " ")
    return tid, body


EXC_COLUMNS = ["日期", "运单号", "客户", "经手人", "发现环节", "异常描述", "处理方式", "是否产生费用",
               "category", "image_source", "loss", "customer_canon", "handler_is_new", "desc_tpl"]
VISIBLE_COLUMNS = EXC_COLUMNS[:8]
LOSS_COLUMNS = ["日期", "运单号", "客户", "费用类型", "金额", "备注"]


def gen_exceptions(p: dict, shipments: list[dict], handlers: list[dict]):
    t = p["targets"]
    cats = p["categories"]
    total = p["error_log_total"]
    assert sum(c["count"] for c in cats) == total
    assert sum(c["loss"] for c in cats) == p["loss_total"]
    cb = cust_by_name()
    all_products = [pr for c in CUSTOMERS for pr in c[6]]

    # ---- 2.1 类别与客户 ----
    rng = stream("exc_customers")
    rows = [{"category": c["id"]} for c in cats for _ in range(c["count"])]
    key_hs = t["key_hs"]
    key_rest = t["key_rows"] - key_hs
    non_hs = [c for c in cats if c["id"] != "E_HS"]
    key_split = dict(zip([c["id"] for c in non_hs], apportion(key_rest, [c["count"] for c in non_hs])))
    key_split["E_HS"] = key_hs
    remaining = []
    for cid in [c["id"] for c in cats]:
        idx = [i for i, r in enumerate(rows) if r["category"] == cid]
        for i in idx[:key_split[cid]]:
            rows[i]["customer"] = KEY_CUSTOMER
        remaining.extend(idx[key_split[cid]:])
    others = [c for c in CUSTOMERS if c[0] != KEY_CUSTOMER]
    cap = dict(zip([c[0] for c in others], apportion(len(remaining), [c[3] for c in others])))
    rng.shuffle(remaining)
    for i in remaining:
        names = [n for n in cap if cap[n] > 0]
        w = [cap[n] * (cb[n][5] if rows[i]["category"] == "E_HS" else 1.0) for n in names]
        n = rng.choices(names, weights=w)[0]
        rows[i]["customer"] = n
        cap[n] -= 1

    # ---- 2.2 日期 ----
    rng = stream("exc_dates")
    days = q3_days()
    dw = []
    for d in days:
        w = {5: 0.45, 6: 0.12}.get(d.weekday(), 1.0) * MONTH_VOLUME_WEIGHTS[d.month]
        dw.append(w * HOLIDAYS.get(d, 1.0))
    order = list(range(len(rows)))
    rng.shuffle(order)
    sampled = sorted(rng.choices(days, weights=dw, k=len(rows)))
    for i, d in zip(order, sampled):
        rows[i]["date"] = d

    # ---- 2.3 海关查验(拓浪 2 次,分别在 8 月、9 月;另有少量其他客户)----
    rng = stream("exc_inspections")
    key_hs_idx = [i for i, r in enumerate(rows) if r["customer"] == KEY_CUSTOMER and r["category"] == "E_HS"]
    insp_key = rng.sample(key_hs_idx, t["key_inspections"])
    windows = [(dt.date(2026, 8, 10), dt.date(2026, 8, 28)), (dt.date(2026, 9, 7), dt.date(2026, 9, 24))]
    for n, i in enumerate(insp_key):
        lo, hi = windows[n % len(windows)]
        cand = [lo + dt.timedelta(k) for k in range((hi - lo).days + 1)]
        cand = [d for d in cand if d.weekday() < 5 and d not in HOLIDAYS]
        rows[i]["date"] = rng.choice(cand)
    other_hs_idx = [i for i, r in enumerate(rows) if r["customer"] != KEY_CUSTOMER and r["category"] == "E_HS"]
    insp_other = rng.sample(other_hs_idx, NON_KEY_INSPECTIONS)
    for i, r in enumerate(rows):
        r["inspection"] = i in insp_key or i in insp_other

    # ---- 2.4 发现环节 ----
    rng = stream("exc_stage")
    for r in rows:
        if r["inspection"]:
            r["stage"] = "海关查验"
        else:
            sw = STAGE_WEIGHTS[r["category"]]
            r["stage"] = rng.choices(list(sw.keys()), weights=list(sw.values()))[0]

    # ---- 2.5 录入类里 21 件来自图片/扫描件 ----
    rng = stream("exc_image")
    keyin_idx = [i for i, r in enumerate(rows) if r["category"] == "E_KEYIN"]
    img = set(rng.sample(keyin_idx, t["keyin_image"]))
    for i, r in enumerate(rows):
        r["image_source"] = i in img

    # ---- 2.6 是否产生费用 ----
    rng = stream("exc_costed")
    for key, n in COSTED.items():
        if isinstance(key, tuple):
            idx = [i for i, r in enumerate(rows)
                   if r["category"] == key[0] and (r["customer"] == KEY_CUSTOMER) == key[1]]
        else:
            idx = [i for i, r in enumerate(rows) if r["category"] == key]
        forced = [i for i in idx if rows[i]["inspection"]]
        rest = [i for i in idx if not rows[i]["inspection"]]
        pick = forced + weighted_sample(rng, rest, [COSTED_STAGE_WEIGHT[rows[i]["stage"]] for i in rest],
                                        n - len(forced))
        for i in idx:
            rows[i]["costed"] = i in pick
    for r in rows:
        r.setdefault("costed", False)

    # ---- 2.7 经手人(新人合计 146 件;大客户有固定对接人)----
    rng = stream("exc_handlers")
    hv = {h["handler"]: h for h in handlers}
    names = [h["handler"] for h in handlers]
    new_names = [n for n in names if hv[n]["is_new_hire"] == "true"]
    old_names = [n for n in names if hv[n]["is_new_hire"] == "false"]
    hcap = {}
    for grp, gtotal in ((new_names, t["new_hire_exceptions"]), (old_names, total - t["new_hire_exceptions"])):
        w = [hv[n]["vol_q3"] * rng.uniform(0.85, 1.15) for n in grp]
        hcap.update(zip(grp, apportion(gtotal, w)))
    primary = {KEY_CUSTOMER: KEY_CUSTOMER_HANDLERS}
    for c in CUSTOMERS:
        if c[0] != KEY_CUSTOMER:
            primary[c[0]] = rng.sample(names, 2)
    order = list(range(len(rows)))
    rng.shuffle(order)
    for i in order:
        cands = [n for n in names if hcap[n] > 0]
        w = [hcap[n] * (5.0 if n in primary[rows[i]["customer"]] else 1.0) for n in cands]
        n = rng.choices(cands, weights=w)[0]
        rows[i]["handler"] = n
        hcap[n] -= 1

    # ---- 2.8 描述与处理方式 ----
    rng = stream("exc_text")
    for r in rows:
        cust = cb[r["customer"]]
        r["desc_tpl"], r["desc"] = render_desc(rng, r["category"], r["stage"], cust, all_products,
                                               r["image_source"], r["inspection"], r["costed"])
        hk = "E_HS_INSPECT" if r["inspection"] else r["category"]
        opts = HANDLING[hk]["ANY"] + (HANDLING[hk]["COST"] if r["costed"] else [])
        if not r["inspection"] and rng.random() < HANDLING_BLANK_PROB:
            r["handling"] = ""
        else:
            r["handling"] = rng.choice(opts)
        aliases = cust[1]
        r["customer_display"] = rng.choice(aliases) if aliases and rng.random() < CUSTOMER_ALIAS_PROB else cust[0]

    # ---- 2.9 运单号(与 shipments.csv 不重叠;号段按月流水,与日期大致对应)----
    rng = stream("exc_waybills")
    used = {s["waybill"] for s in shipments}
    for r in sorted(rows, key=lambda r: r["date"]):
        if r["stage"] in ("目的港", "派送"):
            lag = rng.randint(12, 35)
        elif r["stage"] in ("录单", "出货前核对", "订舱"):
            lag = rng.randint(0, 2)
        else:
            lag = rng.randint(1, 6)
        wd = r["date"] - dt.timedelta(days=lag)
        first = wd.replace(day=1)
        nxt = (first + dt.timedelta(days=32)).replace(day=1)
        ndays = (nxt - first).days
        vol = WAYBILL_MONTH_VOLUME[wd.month]
        while True:
            pos = (wd.day - 1 + rng.random()) / ndays
            seq = min(vol, int(pos * vol) + 1)
            wb = f"LT26{wd.month:02d}-{seq:04d}"
            if wb not in used:
                used.add(wb)
                r["waybill"] = wb
                break

    # ---- 3. 费用:按类别拆到具体异常,分组合计严格等于设定 ----
    loss_rows = gen_losses(p, rows)

    rows.sort(key=lambda r: (r["date"], r["waybill"]))
    return rows, loss_rows


def fee_nominal(rng: random.Random, r: dict) -> list[tuple[str, float]]:
    cat, U = r["category"], rng.uniform
    key = r["customer"] == KEY_CUSTOMER
    lines: list[tuple[str, float]] = []
    if cat == "E_HS":
        if r["inspection"]:
            if key:
                lines = [("查验费", U(2000, 3500)), ("滞港/仓储费", U(5000, 9000)), ("客户赔付", U(10000, 18000))]
            else:
                lines = [("查验费", U(1800, 3000)), ("滞港/仓储费", U(3000, 7000)), ("客户赔付", U(6000, 12000))]
        else:
            lines = [("改单费", U(500, 1500))]
            if rng.random() < 0.40:
                lines.append(("滞港/仓储费", U(800, 3000)))
            if rng.random() < 0.20:
                lines.append(("客户赔付", U(1500, 4000)))
            if rng.random() < 0.05:
                lines.append(("罚款", U(2000, 4000)))
    elif cat == "E_CHANGE":
        lines = [("改单费", U(300, 1200))]
        if rng.random() < 0.35:
            lines.append(("滞港/仓储费", U(400, 2000)))
        if rng.random() < 0.15:
            lines.append(("客户赔付", U(1000, 3000)))
        if rng.random() < 0.20:
            lines.append(("其他", U(200, 800)))
    elif cat == "E_INCONSIST":
        lines = [("改单费", U(200, 900))] if rng.random() < 0.7 else [("其他", U(100, 600))]
        if rng.random() < 0.25:
            lines.append(("滞港/仓储费", U(300, 1500)))
        if rng.random() < 0.10:
            lines.append(("客户赔付", U(800, 2500)))
    elif cat == "E_KEYIN":
        lines = [("改单费", U(200, 900))] if rng.random() < 0.8 else [("其他", U(150, 600))]
        if rng.random() < 0.20:
            lines.append(("其他", U(100, 500)))
        if rng.random() < 0.10:
            lines.append(("客户赔付", U(800, 2500)))
    elif cat == "E_MISSING":
        lines = [("滞港/仓储费", U(400, 1500))]
        if rng.random() < 0.35:
            lines.append(("其他", U(300, 1200)))
        if rng.random() < 0.20:
            lines.append(("改单费", U(200, 600)))
        if rng.random() < 0.08:
            lines.append(("客户赔付", U(1000, 2500)))
    else:  # E_OTHER
        lines = [("其他", U(300, 1200))]
        if rng.random() < 0.30:
            lines.append(("滞港/仓储费", U(200, 1000)))
    # 同一运单同一费用类型合并为一行;最多 3 行
    merged: dict[str, float] = {}
    for ft, a in lines:
        merged[ft] = merged.get(ft, 0.0) + a
    return list(merged.items())[:3]


def gen_losses(p: dict, rows: list[dict]) -> list[dict]:
    rng = stream("losses")
    t = p["targets"]
    targets = {}
    for c in p["categories"]:
        if c["id"] == "E_HS":
            targets[("E_HS", True)] = t["key_hs_loss"]
            targets[("E_HS", False)] = c["loss"] - t["key_hs_loss"]
        else:
            targets[c["id"]] = c["loss"]
    fee_lines = []   # [row_index, fee_type, amount]
    rows_sorted = sorted(range(len(rows)), key=lambda i: (rows[i]["date"], rows[i]["waybill"]))
    for gkey, target in targets.items():
        if isinstance(gkey, tuple):
            idx = [i for i in rows_sorted if rows[i]["category"] == gkey[0]
                   and (rows[i]["customer"] == KEY_CUSTOMER) == gkey[1] and rows[i]["costed"]]
        else:
            idx = [i for i in rows_sorted if rows[i]["category"] == gkey and rows[i]["costed"]]
        group = []
        for i in idx:
            for ft, a in fee_nominal(rng, rows[i]):
                group.append([i, ft, a])
        s = sum(g[2] for g in group)
        for g in group:
            g[2] = round_amount(g[2] * target / s)
        diff = target - sum(g[2] for g in group)
        order = sorted(range(len(group)), key=lambda j: (-group[j][2], j))
        j = 0
        while diff != 0:
            step = 100 if abs(diff) >= 100 else 50
            g = group[order[j % len(order)]]
            delta = step if diff > 0 else -step
            if g[2] + delta >= 100:
                g[2] += delta
                diff -= delta
            j += 1
        assert sum(g[2] for g in group) == target
        fee_lines.extend(group)

    out = []
    for i, ft, amt in fee_lines:
        r = rows[i]
        lag = rng.randint(5, 20) if ft == "客户赔付" else rng.randint(0, 12)
        d = min(Q3_END, r["date"] + dt.timedelta(days=lag))
        note = rng.choice(FEE_NOTES[ft])
        if r["inspection"] and ft == "滞港/仓储费":
            note = "查验期间堆存"
        out.append({"date": d, "waybill": r["waybill"], "customer": r["customer"], "fee_type": ft,
                    "amount": amt, "note": note, "_row": i})
    loss_by_row: dict[int, int] = {}
    for f in out:
        loss_by_row[f["_row"]] = loss_by_row.get(f["_row"], 0) + f["amount"]
    for i, r in enumerate(rows):
        r["loss"] = loss_by_row.get(i, 0)
        assert (r["loss"] > 0) == r["costed"]
    out.sort(key=lambda f: (f["date"], f["waybill"], FEE_TYPES.index(f["fee_type"])))
    return out


# ---------------------------------------------------------------------------
# 近一周来料
# ---------------------------------------------------------------------------
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
INTAKE_DAY_WEIGHTS = [1.08, 1.00, 0.97, 1.02, 1.12, 0.52, 0.29]
INTAKE_CHANNEL = {"xlsx": {"微信群": 0.58, "邮件": 0.42}, "pdf": {"微信群": 0.45, "邮件": 0.55},
                  "image": {"微信群": 0.90, "邮件": 0.10}}
INTAKE_SUBTYPE = {"xlsx": {".xlsx": 0.91, ".xls": 0.09}, "pdf": {"电子PDF": 1.0},
                  "image": {"手机照片": 0.62, "截图": 0.16, "扫描件": 0.22}}


def gen_intake(p: dict) -> list[dict]:
    rng = stream("intake")
    out = []
    for fmt, total in p["intake_formats"].items():
        per_day = apportion(total, [w * rng.uniform(0.9, 1.1) for w in INTAKE_DAY_WEIGHTS])
        for di, n_day in enumerate(per_day):
            chans = INTAKE_CHANNEL[fmt]
            per_ch = apportion(n_day, [v * rng.uniform(0.9, 1.1) for v in chans.values()])
            for ch, n_ch in zip(chans.keys(), per_ch):
                subs = INTAKE_SUBTYPE[fmt]
                per_sub = apportion(n_ch, list(subs.values()))
                for st, n in zip(subs.keys(), per_sub):
                    out.append({"weekday": WEEKDAYS[di], "day_index": di + 1, "channel": ch, "format": fmt,
                                "subtype": st, "count": n})
    out.sort(key=lambda r: (r["day_index"], r["channel"], list(p["intake_formats"]).index(r["format"]),
                            r["subtype"]))
    return out


# ---------------------------------------------------------------------------
# 5. 合成单据的辅助真值(W3):产品主数据、每份单据逐行的数字、A6/A8 的时间线与金额
#    渲染脚本只从这些 CSV 取数,不在模板里另编数字。本节不使用随机数,
#    也不改动上面任何一张表的内容。
# ---------------------------------------------------------------------------
PRODUCT_COLUMNS = ["customer", "sku", "name", "declared_name", "pcs_per_ctn", "kg_per_ctn", "cbm_per_ctn",
                   "unit_usd", "battery"]
DOC_LINE_COLUMNS = ["doc_key", "artifact", "waybill", "doc_type", "version", "form", "line_no", "sku", "item_name",
                    "declared_name", "cartons", "pcs_per_ctn", "pieces", "unit_usd", "amount_usd", "gross_kg", "cbm",
                    "battery"]
DOC_FACT_COLUMNS = ["key", "value", "basis"]
A1_IMAGE_FORMS = ("照片", "扫描件", "手写")

# A8 / A6 的设计参数(不是 YAML 里的业务数字;金额、年份、弃用月数从 K1 文本派生)
OCR_SIGN_MONTH_DAY = (3, 18)            # 合同签订日
OCR_ACCEPT_MONTH_DAY = (4, 22)          # 验收日
OCR_FIRST_PAYMENT_PCT = 50              # 签约后首付比例,余款验收后付
OCR_LICENSE_USERS = 5
OCR_VENDOR_ACCURACY_CLAIM = "≥95%"           # 乙方宣称值,测试样张由乙方提供
# LT2609-0412 改单时间线:出货前一晚客户在群里改单;报关资料在当天下午已用邮件发给报关行
A6_EVENING = {"original_posted": "14:05", "email_sent": "16:20", "rev1_posted": "20:16", "rev2_posted": "23:41"}
A6_NEXT_DAY = {"chen_ack": "08:52", "broker_reply": "09:47", "warehouse_report": "10:18"}

_Q2 = Decimal("0.01")


def _d(x) -> Decimal:
    return Decimal(str(x))


def _q2(x: Decimal) -> str:
    return str(x.quantize(_Q2, rounding=ROUND_HALF_UP))


def product_index() -> dict[str, tuple]:
    """SKU → (客户, 产品元组)。"""
    return {pr[0]: (c[0], pr) for c in CUSTOMERS for pr in c[6]}


def gen_products() -> list[list]:
    rows = []
    for c in CUSTOMERS:
        for sku, name, dname, ppc, kg, cbm, usd, batt in c[6]:
            rows.append([c[0], sku, name, dname, ppc, f"{kg:.1f}", f"{cbm:.3f}", f"{usd:.2f}", "是" if batt else "否"])
    return rows


def parse_sku_lines(s: str) -> list[tuple[str, int, int]]:
    """'QH-ZN20 抽屉收纳盒 600件/12箱; …' → [(sku, 件数, 箱数)]。"""
    out = []
    for part in s.split("; "):
        m = re.fullmatch(r"(\S+) (.+) (\d+)件/(\d+)箱", part)
        assert m, part
        out.append((m.group(1), int(m.group(3)), int(m.group(4))))
    return out


def gen_doc_lines(shipments: list[dict]) -> list[dict]:
    """把 A1 样本包(a1_docs 列)以及 A6/A7 要用到的票,展开成「每份单据 × 每一行」的数字。

    规则与 shipments.csv 的线索列一一对应:
      发票      件数 = 装箱单件数,inv_pieces 与 pieces 的差额记在最后一行(LT2609-0387:QH-YJ15 600 vs 550)
      装箱单    版本 = pl_version;箱数/件数/毛重/体积逐行,合计必须等于整票数
      提单      箱数 = bl_cartons,毛重 = bl_gross_kg(LT2609-0412:仍按原版 40 箱)
      报关草单  单行票的申报品名 = declared_name(LT2609-0446:笼统写成「电子配件」)
      箱唛      每箱件数、每箱毛重来自产品主数据
    """
    pidx = product_index()
    out: list[dict] = []

    def row(key, art, s, doc_type, version, form, n, **kw):
        base = {"doc_key": key, "artifact": art, "waybill": s["waybill"], "doc_type": doc_type, "version": version,
                "form": form, "line_no": n, "sku": "", "item_name": "", "declared_name": "", "cartons": "",
                "pcs_per_ctn": "", "pieces": "", "unit_usd": "", "amount_usd": "", "gross_kg": "", "cbm": "",
                "battery": s["battery"]}
        base.update(kw)
        out.append(base)

    def lines_of(s):
        res = []
        for sku, pcs, ctn in parse_sku_lines(s["sku_lines"]):
            _, pr = pidx[sku]
            res.append({"sku": sku, "pr": pr, "pcs": pcs, "ctn": ctn})
        return res

    def pl_rows(key, art, s, version, form, cartons_override=None, gross_override=None):
        ls = lines_of(s)
        if cartons_override is not None:          # 旧版本(箱数不同)只支持单品票
            assert len(ls) == 1
            ls[0] = dict(ls[0], ctn=cartons_override, pcs=cartons_override * ls[0]["pr"][3])
        tot_g, tot_v = Decimal(0), Decimal(0)
        for i, ln in enumerate(ls, start=1):
            sku, name, dname, ppc, kg, cbm, usd, batt = ln["pr"]
            g = _d(kg) * ln["ctn"]
            v = (_d(cbm) * ln["ctn"]).quantize(_Q2, rounding=ROUND_HALF_UP)
            tot_g += g
            tot_v += v
            row(key, art, s, "装箱单", version, form, i, sku=sku, item_name=name, declared_name=dname,
                cartons=ln["ctn"], pcs_per_ctn=ppc, pieces=ln["pcs"], gross_kg=str(g), cbm=_q2(v),
                battery="是" if batt else "否")
        if cartons_override is None:
            assert sum(ln["pcs"] for ln in ls) == int(s["pieces"]), s["waybill"]
            assert sum(ln["ctn"] for ln in ls) == int(s["cartons"]), s["waybill"]
            assert str(tot_g) == s["gross_weight_kg"], (s["waybill"], tot_g)
            assert _q2(tot_v) == s["volume_cbm"], (s["waybill"], tot_v)
        else:
            assert gross_override is None or str(tot_g) == gross_override, (s["waybill"], tot_g)

    by_wb = {s["waybill"]: s for s in shipments}
    a1 = [s for s in sorted(shipments, key=lambda r: r["waybill"]) if s["a1_docs"]]
    k = 0
    for s in a1:
        for spec in s["a1_docs"].split("|"):
            label, form = spec.split(":")
            doc_type = re.sub(r"\(.*\)", "", label)
            k += 1
            key = f"A1-{k:02d}"
            ls = lines_of(s)
            if doc_type == "发票":
                diff = int(s["inv_pieces"]) - int(s["pieces"])
                total = Decimal(0)
                for i, ln in enumerate(ls, start=1):
                    sku, name, dname, ppc, kg, cbm, usd, batt = ln["pr"]
                    pcs = ln["pcs"] + (diff if i == len(ls) else 0)
                    amt = _d(usd) * pcs
                    total += amt
                    item = s["invoice_desc"] if len(ls) == 1 else name
                    row(key, "A1", s, "发票", "", form, i, sku=sku, item_name=item, declared_name=dname,
                        pcs_per_ctn=ppc, pieces=pcs, unit_usd=f"{usd:.2f}", amount_usd=_q2(amt),
                        battery="是" if batt else "否")
                assert _q2(total) == s["amount_usd"], (s["waybill"], total)
            elif doc_type == "装箱单":
                m = re.search(r"\((.+)\)", label)
                assert m is None or m.group(1) == s["pl_version"], (label, s["pl_version"])
                pl_rows(key, "A1", s, s["pl_version"], form)
            elif doc_type == "提单":
                names = "、".join(ln["pr"][1] for ln in ls)
                if int(s["bl_cartons"]) == int(s["cartons"]):
                    pcs, v = int(s["pieces"]), s["volume_cbm"]
                else:
                    assert len(ls) == 1
                    pcs = int(s["bl_cartons"]) * ls[0]["pr"][3]
                    v = _q2(_d(ls[0]["pr"][5]) * int(s["bl_cartons"]))
                row(key, "A1", s, "提单", "原版", form, 1, sku="/".join(ln["sku"] for ln in ls), item_name=names,
                    declared_name=s["declared_name"], cartons=int(s["bl_cartons"]),
                    pcs_per_ctn=ls[0]["pr"][3] if len(ls) == 1 else "", pieces=pcs, gross_kg=s["bl_gross_kg"], cbm=v)
            elif doc_type == "报关草单":
                for i, ln in enumerate(ls, start=1):
                    sku, name, dname, ppc, kg, cbm, usd, batt = ln["pr"]
                    decl = s["declared_name"] if len(ls) == 1 else dname
                    row(key, "A1", s, "报关草单", "", form, i, sku=sku, item_name=name, declared_name=decl,
                        cartons=ln["ctn"], pcs_per_ctn=ppc, pieces=ln["pcs"], unit_usd=f"{usd:.2f}",
                        amount_usd=_q2(_d(usd) * ln["pcs"]), gross_kg=str(_d(kg) * ln["ctn"]),
                        cbm=_q2(_d(cbm) * ln["ctn"]), battery="是" if batt else "否")
            elif doc_type == "箱唛":
                assert len(ls) == 1
                sku, name, dname, ppc, kg, cbm, usd, batt = ls[0]["pr"]
                row(key, "A1", s, "箱唛", "", form, 1, sku=sku, item_name=name, declared_name=dname,
                    cartons=ls[0]["ctn"], pcs_per_ctn=ppc, pieces=ls[0]["pcs"], gross_kg=s["gross_weight_kg"],
                    cbm=s["volume_cbm"], battery="是" if batt else "否")
            else:
                raise ValueError(f"未知单据类型 {label}")

    # A6(改单截图、报关行旧邮件)与 A7(FMS 录单界面)都围绕 P4 线索票
    p4 = next(s for s in shipments if "P4" in s["clue_ids"])
    orig_ctn = int(p4["bl_cartons"])
    for key, form, versions in (("A6-01", "截图", ["原版", p4["pl_version"]]),
                                ("A6-02", "截图", ["原版", p4["pl_version"]]),
                                ("A6-03", "截图", ["原版"]),
                                ("A7-01", "截图", [p4["pl_version"]])):
        art = key[:2]
        for ver in versions:
            if ver == "原版":
                pl_rows(key, art, p4, "原版", form, cartons_override=orig_ctn, gross_override=p4["bl_gross_kg"])
            else:
                pl_rows(key, art, p4, ver, form)
    # A7 导入模板的两行示例:取样本包里两票电子来料(Excel 发票、电子 PDF 发票)
    for wb in [s["waybill"] for s in a1 if "发票:Excel" in s["a1_docs"] or "发票:电子PDF" in s["a1_docs"]]:
        pl_rows("A7-02", "A7", by_wb[wb], by_wb[wb]["pl_version"], "Excel")
    return out


def gen_doc_facts(p: dict, shipments: list[dict]) -> list[list]:
    """A6 时间线、A8 合同与验收单的数字。金额、年份、弃用月数逐字从 K1 派生。"""
    k1 = p["texts"]["K1"]
    m = re.search(r"花\s*([\d.]+)\s*万", k1)
    amount = int(Decimal(m.group(1)) * 10000)
    months = int(re.search(r"(\d+)\s*个月弃用", k1).group(1))
    assert "前年" in k1
    year = Q3_END.year - 2
    sign = dt.date(year, *OCR_SIGN_MONTH_DAY)
    accept = dt.date(year, *OCR_ACCEPT_MONTH_DAY)
    stop_m = accept.month + months
    stop = f"{year + (stop_m - 1) // 12}-{(stop_m - 1) % 12 + 1:02d}"
    first = amount * OCR_FIRST_PAYMENT_PCT // 100
    p4 = next(s for s in shipments if "P4" in s["clue_ids"])
    ship = dt.date.fromisoformat(p4["ship_date"])
    eve = (ship - dt.timedelta(days=1)).isoformat()
    rows = [
        ["a8.contract_amount_cny", amount, "K1「花 6.8 万」"],
        ["a8.abandon_after_months", months, "K1「3 个月弃用」"],
        ["a8.contract_year", year, "K1「前年」;场景年份 2026"],
        ["a8.sign_date", sign.isoformat(), "设计参数"],
        ["a8.acceptance_date", accept.isoformat(), "设计参数"],
        ["a8.stop_month", stop, "验收月 + K1 弃用月数"],
        ["a8.payment_first_pct", OCR_FIRST_PAYMENT_PCT, "设计参数"],
        ["a8.payment_first_cny", first, "合同金额 × 首付比例"],
        ["a8.payment_final_cny", amount - first, "合同金额 − 首付"],
        ["a8.license_users", OCR_LICENSE_USERS, "设计参数"],
        ["a8.vendor_accuracy_claim", OCR_VENDOR_ACCURACY_CLAIM, "设计参数(乙方宣称,以乙方标准样张测试)"],
        ["a6.waybill", p4["waybill"], "shipments.csv clue_ids=P4"],
        ["a6.customer", p4["customer"], "shipments.csv"],
        ["a6.original_cartons", p4["bl_cartons"], "shipments.csv bl_cartons(原版)"],
        ["a6.revised_cartons", p4["cartons"], "shipments.csv cartons(改2)"],
        ["a6.added_cartons", int(p4["cartons"]) - int(p4["bl_cartons"]), "改2 − 原版"],
        ["a6.revised_version", p4["pl_version"], "shipments.csv pl_version"],
    ]
    for k, t in A6_EVENING.items():
        rows.append([f"a6.t_{k}", f"{eve} {t}", "设计参数(出货前一天)"])
    for k, t in A6_NEXT_DAY.items():
        rows.append([f"a6.t_{k}", f"{ship.isoformat()} {t}", "设计参数(出货当天)"])
    rows.append(["a7.fms_last_modified", f"{ship.isoformat()} {A6_NEXT_DAY['chen_ack']}", "= a6.t_chen_ack"])
    return rows


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------
def build_all(p: dict | None = None) -> dict[str, bytes]:
    """生成全部 truth 文件内容(文件名 → 字节)。check_truth.py 也调用它来验证幂等。"""
    p = p or load_params()
    shipments = gen_shipments(p)
    handlers = gen_handler_volume(p)
    exc, losses = gen_exceptions(p, shipments, handlers)
    intake = gen_intake(p)

    files: dict[str, bytes] = {}
    files["shipments.csv"] = csv_bytes(SHIPMENT_COLUMNS, [[s[c] for c in SHIPMENT_COLUMNS] for s in shipments])
    files["exceptions.csv"] = csv_bytes(EXC_COLUMNS, [[
        r["date"].isoformat(), r["waybill"], r["customer_display"], r["handler"], r["stage"], r["desc"],
        r["handling"], "是" if r["costed"] else "否",
        r["category"], "true" if r["image_source"] else "false", r["loss"], r["customer"],
        next(h["is_new_hire"] for h in handlers if h["handler"] == r["handler"]), r["desc_tpl"],
    ] for r in exc])
    files["loss.csv"] = csv_bytes(LOSS_COLUMNS, [[f["date"].isoformat(), f["waybill"], f["customer"], f["fee_type"],
                                                  f["amount"], f["note"]] for f in losses])
    exc_by_handler: dict[str, int] = {}
    for r in exc:
        exc_by_handler[r["handler"]] = exc_by_handler.get(r["handler"], 0) + 1
    hcols = ["handler", "hire_date", "tenure_months", "is_new_hire", "vol_jul", "vol_aug", "vol_sep", "vol_q3",
             "exceptions_q3"]
    files["handler_volume.csv"] = csv_bytes(hcols, [[h[c] for c in hcols[:-1]] + [exc_by_handler.get(h["handler"], 0)]
                                                    for h in handlers])
    icols = ["weekday", "day_index", "channel", "format", "subtype", "count"]
    files["intake_week.csv"] = csv_bytes(icols, [[r[c] for c in icols] for r in intake])
    exc_by_cust: dict[str, int] = {}
    for r in exc:
        exc_by_cust[r["customer"]] = exc_by_cust.get(r["customer"], 0) + 1
    ccols = ["customer", "aliases", "industry", "is_key_customer", "exceptions_q3", "shipments_in_truth"]
    files["customers.csv"] = csv_bytes(ccols, [[
        c[0], "|".join(c[1]), c[2], "true" if c[0] == KEY_CUSTOMER else "false", exc_by_cust.get(c[0], 0),
        sum(1 for s in shipments if s["customer"] == c[0])] for c in CUSTOMERS])
    # 合成单据(W3)的辅助真值
    files["products.csv"] = csv_bytes(PRODUCT_COLUMNS, gen_products())
    doc_lines = gen_doc_lines(shipments)
    files["doc_lines.csv"] = csv_bytes(DOC_LINE_COLUMNS, [[d[c] for c in DOC_LINE_COLUMNS] for d in doc_lines])
    files["doc_facts.csv"] = csv_bytes(DOC_FACT_COLUMNS, gen_doc_facts(p, shipments))

    t = p["targets"]
    cat_stats = {c["id"]: {"name": c["name"], "count": sum(1 for r in exc if r["category"] == c["id"]),
                           "loss": sum(r["loss"] for r in exc if r["category"] == c["id"]),
                           "costed": sum(1 for r in exc if r["category"] == c["id"] and r["costed"])}
                 for c in p["categories"]}
    key_rows = [r for r in exc if r["customer"] == KEY_CUSTOMER]
    meta = {
        "notice": "合成样本·训练用 · 公司与数据均为虚构",
        "generator": "tools/docgen/gen_truth.py",
        "seed": SEED,
        "params_source": p["source"],
        "period": f"{Q3_START.isoformat()}..{Q3_END.isoformat()}",
        "exceptions": {"total": len(exc), "by_category": cat_stats,
                       "keyin_image_source": sum(1 for r in exc if r["image_source"]),
                       "costed": sum(1 for r in exc if r["costed"]),
                       "customs_inspections": sum(1 for r in exc if r["inspection"])},
        "loss": {"total": sum(f["amount"] for f in losses), "lines": len(losses),
                 "by_fee_type": {ft: sum(f["amount"] for f in losses if f["fee_type"] == ft) for ft in FEE_TYPES}},
        "key_customer": {"name": KEY_CUSTOMER, "rows": len(key_rows),
                         "hs_rows": sum(1 for r in key_rows if r["category"] == "E_HS"),
                         "hs_loss": sum(r["loss"] for r in key_rows if r["category"] == "E_HS"),
                         "inspections": sum(1 for r in key_rows if r["inspection"])},
        "handlers": {"count": len(handlers), "new_hires": sum(1 for h in handlers if h["is_new_hire"] == "true"),
                     "volume_total": sum(h["vol_q3"] for h in handlers),
                     "new_hire_volume": sum(h["vol_q3"] for h in handlers if h["is_new_hire"] == "true"),
                     "new_hire_exceptions": sum(1 for r in exc
                                                if any(h["handler"] == r["handler"] and h["is_new_hire"] == "true"
                                                       for h in handlers))},
        "intake_week": {fmt: sum(r["count"] for r in intake if r["format"] == fmt) for fmt in p["intake_formats"]},
        "shipments": {"total": len(shipments),
                      "clues": {s["waybill"]: s["clue_ids"] for s in shipments if s["clue_ids"]},
                      "x4_sample": sum(1 for s in shipments if s["x4_sample"] == "true"),
                      "x4_issues": sum(1 for s in shipments if s["x4_issue"])},
        "docs": {"products": sum(len(c[6]) for c in CUSTOMERS),
                 "a1_docs": len({d["doc_key"] for d in doc_lines if d["artifact"] == "A1"}),
                 "a1_images": len({d["doc_key"] for d in doc_lines if d["artifact"] == "A1"
                                   and d["form"] in A1_IMAGE_FORMS}),
                 "doc_lines": len(doc_lines)},
        "targets": t,
        "files_sha256": {k: hashlib.sha256(v).hexdigest() for k, v in sorted(files.items())},
    }
    files["meta.json"] = (json.dumps(meta, ensure_ascii=False, indent=2, sort_keys=False) + "\n").encode("utf-8")
    return files


def main() -> int:
    p = load_params()
    files = build_all(p)
    TRUTH_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (TRUTH_DIR / name).write_bytes(data)
        print(f"wrote {(TRUTH_DIR / name).relative_to(ROOT)}  ({len(data):,} bytes)")
    print(f"params source: {p['source']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
