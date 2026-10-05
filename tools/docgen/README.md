# tools/docgen —— 合成单据:先造账,再造单

方案 4.1 的离线数据流水线(步骤 1–8 全部在这里):先生成一套自洽的真值账本,再把账渲染成用户能下载、能看的资料,
保证异常表、费用表、样本单据、截图之间能对上。
所有公司、人名、数据均为虚构;每份资料都带「合成样本·训练用」的显式与隐式标识(方案 8.2)。

## 运行

```bash
python3 -m venv tools/docgen/.venv
tools/docgen/.venv/bin/pip install -r tools/docgen/requirements.txt
tools/docgen/.venv/bin/python tools/docgen/gen_truth.py     # 写 scenarios/freight-docs/truth/*
tools/docgen/.venv/bin/python tools/docgen/render_xlsx.py   # 写 A2/A4/A5 的 xlsx(并刷新 manifest)
tools/docgen/.venv/bin/python tools/docgen/render_docs.py   # 写 A1/A3/A5 图/A6/A7/A8(并刷新 manifest),约 15 秒
tools/docgen/.venv/bin/python tools/docgen/check_truth.py   # 真值与 Excel 自检,全部 PASS 才返回 0
tools/docgen/.venv/bin/python tools/docgen/check_docs.py    # 合成单据自检,全部 PASS 才返回 0
```

`render_docs.py` 需要无头 Chromium(默认 `/opt/pw-browsers/chromium`,可用环境变量 `FDE_CHROMIUM` 指定)和中文字体
`/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc`。

确定性:固定随机种子,重复运行 CSV、xlsx、PDF、图片、manifest 都字节级一致(xlsx 固定 zip 时间戳;PDF 改写元数据、
固定日期与文件 ID;图片的劣化随机流按资料编号派生),可以直接提交 diff。

## 脚本

| 脚本 | 做什么 | 产出 |
|---|---|---|
| `gen_truth.py` | 步骤 1–4:票据真值表(含三条线索票)、Q3 异常表 428 行、按类别把损失拆到具体异常、经手人票量、近一周来料;合成单据的辅助真值(产品主数据、逐份逐行数字、A6/A8 时间线与金额) | `truth/shipments.csv` `exceptions.csv` `loss.csv` `customers.csv` `handler_volume.csv` `intake_week.csv` `products.csv` `doc_lines.csv` `doc_facts.csv` `meta.json` |
| `render_xlsx.py` | 步骤 5(Excel 资料):只把可见列写进资料 | `artifacts/A2/exceptions_q3.xlsx`、`A4/loss_q3.xlsx`、`A5/intake_week.xlsx` |
| `docs_spec.py` | 合成单据清单:每份文件是什么、用哪一票的数字、藏了哪条线索、用哪个模板、怎么劣化 | (被下面三个脚本引用) |
| `render_docs.py` | 步骤 5–6:Jinja2 模板 → 无头 Chromium 截图 / 打印 PDF → 照片与扫描件劣化 → 盖标识;三份 Excel 用 openpyxl | `artifacts/A1/*`(14 份)、`A3/cheatsheet.png`、`A5/intake_week.png`、`A6/*`(3 张)、`A7/*`、`A8/*` |
| `degrade.py` | 劣化(旋转 1–7 度、透视、桌面背景与投影、不均匀光照、折痕、模糊、噪点、水印、JPEG)与标识(右下角标识牌、PNG 文本块、JPEG EXIF) | (被 render_docs / check_docs 引用) |
| `manifest.py` | 步骤 7:写 `artifacts/manifest.yaml`,A1–A8 每个文件对应哪票、显示了哪些数字、藏了哪条线索、sha256、劣化参数 | `artifacts/manifest.yaml` |
| `check_truth.py` | 步骤 8 + 4.3 校验器中与数据相关的项:合计、比例、双向对齐、A2 不含真值列、按运单号联表还原 X3/X5、逐条复算 YAML 里的文字结论、无真实主体、manifest 的 sha256 | 终端 PASS/FAIL 表,失败返回非零 |
| `check_docs.py` | 合成单据自检:文件数与命名(与引擎 `artifactFiles()` 同一规则)、≤1.5 MB、显式标识(按像素核对)与隐式标识、manifest 覆盖与 sha256、三条 A1 线索落点、劣化范围;独立地从 `truth/*.csv` 推出每份文件应显示的数字,与 manifest 和文件里实际渲染的文字逐一比对;合规(无真实主体、HS 只用占位符、公司名带「虚构」、邮箱用 `.example`) | 终端 PASS/FAIL 表,失败返回非零 |

## 资料与线索

| 资料 | 文件 | 藏的线索 |
|---|---|---|
| A1 样本单据包 | 14 份:7 票 × 2 份,其中 9 份照片 / 扫描件 / 手写(劣化),5 份电子 PDF 或 Excel | K4:9/14 是图片,日常只占 17%;P7:LT2609-0387 发票 600+600=1200 件 vs Excel 装箱单 600+550=1150 件;P4:LT2609-0412 装箱单「改2」46 箱 vs 提单(扫描件)40 箱;P5:LT2609-0446 发票写明内置锂电池,报关草单品名只写「电子配件」 |
| A3 小抄 | `cheatsheet.png` | P5:HS 编码靠个人小抄,同一货号两种编码、作废的老码、「问报关行」;储能电源一栏仍写「电子配件」 |
| A5 来料统计 | `intake_week.png` | P3:Excel 937、电子 PDF 318、图片 257,62% / 21% / 17% |
| A6 改单截图 | 客户群截图、仓库群截图、发给报关行的邮件截图 | P4:LT2609-0412 夜里加 6 箱改成 46 箱;小陈只改了系统;仓库按 40 箱打板;报关行按下午邮件里的原版 40 箱申报 |
| A7 FMS | 录单界面截图、Excel 导入模板 | K2:「API 对接」未开通(增值服务);批量数据只能按模板导入,改单只能在界面逐票改 |
| A8 旧 OCR | 合同首页(PDF)、验收单(扫描件) | K1:合同 6.8 万,写明不含与 FMS 对接;验收按乙方样张;手写批注 3 个月后停用 |

每个文件的细节(显示的数字、线索编号、劣化效果)见 `artifacts/manifest.yaml`。

## 哪些数字是【设定】

`scenario.yaml` 存在时一律从它读取(`meta.json` 的 `params_source` 记录来源);不存在时才用 `gen_truth.py` 顶部的 `SPEC_FALLBACK` 常量块(逐字抄自方案 3.5)。要改业务数字,请改 `scenario.yaml` 后重跑全部步骤。

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
| 旧 OCR 工具 | 6.8 万 → 68,000 元;「前年」→ 2024;3 个月弃用 | `facts.K1` 文本 |

生成器自己的设计参数(不是 YAML 里的数字,可以按真实经验调):30 家虚构客户与产品、14 名单证员与入职日期、各类"产生费用"的件数(`COSTED`)、每类费用的单笔量级(`fee_nominal`)、发现环节分布、异常描述模板与同义写法、拓浪以外的 2 次查验、FBA 仓代码;A8 的签约日、验收日、首付比例、账号数、乙方宣称的准确率;A6 的改单时间点(都写进 `truth/doc_facts.csv`,`basis` 列注明来源)。

## 资料里故意留的"手工味"

- A2「异常描述」是自由文本:每类 8–22 套模板,同义词随机替换(发票/CI/invoice,装箱单/箱单/PL…),前后缀与标点口径不一,不出现类别名原文(K5)。
- A2「客户」偶尔写简称(如「拓浪」与「拓浪科技」并存),按包含筛选可以合并;约一成「处理方式」空着;海关查验行手工标红。
- A4「汇总」只按费用类型归集,不按原因;要得到各原因的金额,必须和 A2 按运单号对上(X3)。
- A1 每家客户一种格式(青禾小公司中文风、拓浪品牌外贸风、栖木素净中文风、野径户外橙色、星渚蓝色表格、稻禾文具店手写单),同一客户的发票与装箱单格式一致。
- 劣化只求「七成像」(方案 9.1 第 5 条):线索比逼真重要,所有数字在劣化后仍清晰可读。

## 合规约定(方案 4.1 规矩、8.2 标识)

- 公司名、产品名一律带「(虚构)/(FICTITIOUS)」;人名用称呼或化名(阿May、老郑、刘、孟××);邮箱只用保留域名 `.example`;地址写「示例路…(虚构地址)」。
- HS 编码一律是明显无效的占位符 `XXXX.XX-序号`(序号只表示「同一个码 / 不同的码」);具体编码与申报要素留给作者按真实经验补。
- 报关类只做货代内部「出口报关资料草单(内部核对稿,非正式报关单)」,不仿制任何官方抬头;合同、验收单、发票签章处只写「(合成样本,不含印章)」,不画印章。
- 手写效果用文泉驿正黑逐字随机旋转、位移模拟,没有引入额外的手写字体。
- 显式标识:图片右下角不透明标识牌「合成样本·训练用」;PDF 页脚与 xlsx 单元格「合成样本·训练用 · 公司与数据均为虚构」。
- 隐式标识:PNG 文本块 `AIGC=合成样本·训练用`(tEXt 与 iTXt 各一份);JPEG EXIF ImageDescription(UTF-8)与注释段;PDF 元数据 Subject;xlsx 工作簿 description。

## 待办

- 上线前按方案 3.5.4 在企查查与搜索引擎里查一遍客户名、人名、虚构承运人/报关行/OCR 厂商名,避免撞到真实主体。
- 作者按真实经验补 LT2609-0446 储能电源的 HS 编码与申报要素(现在是占位符)。
