# tools/docgen —— 合成单据「先造账」

方案 4.1 的离线数据流水线(本目录只做步骤 1–3、7、8,加两份 Excel 资料的渲染;图片渲染与劣化在后续周次)。
先生成一套自洽的真值账本,再把账渲染成用户能下载的资料,保证异常表、费用表、样本之间能对上。
所有公司、人名、数据均为虚构;每份资料都带「合成样本·训练用 · 公司与数据均为虚构」。

## 运行

```bash
python3 -m venv tools/docgen/.venv
tools/docgen/.venv/bin/pip install -r tools/docgen/requirements.txt
tools/docgen/.venv/bin/python tools/docgen/gen_truth.py     # 写 scenarios/freight-docs/truth/*
tools/docgen/.venv/bin/python tools/docgen/render_xlsx.py   # 写 A2/A4/A5 的 xlsx 和 artifacts/manifest.yaml
tools/docgen/.venv/bin/python tools/docgen/check_truth.py   # 自检,全部 PASS 才返回 0
```

固定随机种子,重复运行 CSV 和 xlsx 都字节级一致(xlsx 的 zip 时间戳与文档日期已固定),可以直接提交 diff。

## 脚本

| 脚本 | 做什么 | 产出 |
|---|---|---|
| `gen_truth.py` | 步骤 1–4:票据真值表(含三条线索票)、Q3 异常表 428 行、按类别把损失拆到具体异常、经手人票量、近一周来料 | `truth/shipments.csv` `exceptions.csv` `loss.csv` `customers.csv` `handler_volume.csv` `intake_week.csv` `meta.json` |
| `render_xlsx.py` | 步骤 5(仅 Excel)与步骤 7:只把可见列写进资料;生成清单 | `artifacts/A2/exceptions_q3.xlsx`、`A4/loss_q3.xlsx`、`A5/intake_week.xlsx`、`artifacts/manifest.yaml` |
| `check_truth.py` | 步骤 8 + 4.3 校验器中与数据相关的项:合计、比例、双向对齐、A2 不含真值列、按运单号联表还原 X3/X5、逐条复算 YAML 里的文字结论、无真实主体、manifest 的 sha256 | 终端 PASS/FAIL 表,失败返回非零 |

## 哪些数字是【设定】

`scenario.yaml` 存在时一律从它读取(`meta.json` 的 `params_source` 记录来源);不存在时才用 `gen_truth.py` 顶部的 `SPEC_FALLBACK` 常量块(逐字抄自方案 3.5)。要改业务数字,请改 `scenario.yaml` 后重跑三步。

| 来自 YAML 的【设定】 | 值 | YAML 位置 |
|---|---|---|
| 异常件数 / 各类件数 | 428 = 132 / 113 / 71 / 58 / 37 / 17 | `truth.error_log_total`、`truth.error_categories[].count` |
| 各类直接损失 | 61,800 / 148,500 / 212,000 / 27,400 / 38,600 / 9,700,合计 498,000 | `truth.error_categories[].loss`、`truth.loss_total` |
| 录入类中图片来源 | 21 | `E_KEYIN` 的 name 文本 |
| Q3 票量 | 19,800 | `truth.period` 文本 |
| 来料格式 | xlsx 937 / pdf 318 / image 257 | `truth.intake_formats` |
| 拓浪 HS 件数与损失 | 19 件 / 86,000 | `truth.key_customer` |
| 拓浪占全部异常 | 14% → 60 行 | `experiments.X5` 文本 |
| 拓浪 Q3 查验 | 两次 → 2 行「海关查验」 | `facts.S2` 文本 |
| 新人 | 5 人,票量 31% → 6,138,异常 34% → 146 | `facts.RH1` 文本 |
| X4 抽样 | 30 票 / 7 票不一致 / 5 出货前 / 2 报关 | `experiments.X4` 文本 |
| 线索票 | LT2609-0387(1200 vs 1150)、LT2609-0412(改2 46 箱 vs 提单 40 箱)、带电笼统品名 | `artifacts.A1.clues` |

生成器自己的设计参数(不是 YAML 里的数字,可以按真实经验调):30 家虚构客户与产品、14 名单证员与入职日期、各类"产生费用"的件数(`COSTED`)、每类费用的单笔量级(`fee_nominal`)、发现环节分布、异常描述模板与同义写法、拓浪以外的 2 次查验、FBA 仓代码。

## 资料里故意留的"手工味"

- A2「异常描述」是自由文本:每类 8–22 套模板,同义词随机替换(发票/CI/invoice,装箱单/箱单/PL…),前后缀与标点口径不一,不出现类别名原文(K5)。
- A2「客户」偶尔写简称(如「拓浪」与「拓浪科技」并存),按包含筛选可以合并;约一成「处理方式」空着;海关查验行手工标红。
- A4「汇总」只按费用类型归集,不按原因;要得到各原因的金额,必须和 A2 按运单号对上(X3)。

## 待办(后续周次)

- A1 样本包的 PDF/PNG 渲染与劣化:线索与样本组成已写在 `truth/shipments.csv` 的 `clue_ids`、`clue_note`、`a1_docs`、`x4_*` 列;带电产品的具体 HS 编码与申报要素留给作者补。
- A5 的 `intake_week.png` 由 `A5/intake_week.xlsx` 渲染。
- 上线前按方案 3.5.4 在企查查与搜索引擎里查一遍客户名、人名,避免撞到真实主体。
