# FDE 训练平台

给想做 FDE 的人一个可以翻车的客户现场:AI 扮演的老板、主管、一线和财务各说各的,你去问、去要数据、去做判断,最后拿到一份逐轮指出问题的复盘。

产品与开发方案见 [`FDE训练平台-产品与开发方案-v1.md`](./FDE训练平台-产品与开发方案-v1.md)。本仓库按方案第 5.2 节的里程碑推进,当前完成的是 **W0–W7 的工程部分**:

- 引擎与算分(命令行可玩,回归评测可跑)、合成单据、裁判标定工具;
- 网页:对局、复盘、我的对局、管理页;邀请码 + 邮箱验证码登录,手机号 + 短信验证码登录(配好短信才开放);
- 内测与增长要用的:候补名单(W0「候补表单」、W5–W7「分批邀请」)、方案 6.3 继续/转向/放弃指标的看板(自建事件表)、预售页与兑换码核销(7.3「站内不收款」);
- 部署与合规材料、CI;
- 接真模型之前能做的准备:在线质量门槛与对抗集(`pnpm evals --live` 没过门槛会判失败)、模型预检、本地用真引擎试玩并把对局导出成标定用例、第一关的内容与试玩草稿、场景事实核对备忘。

上线前还需要人工完成的事见文末「上线前还要做的」。

## 快速开始

```bash
pnpm install
pnpm validate          # 场景校验(方案 4.3 的检查项)
pnpm test              # 单元测试
pnpm evals             # 回归评测:10 个脚本化玩家,离线、确定性
pnpm play --offline    # 命令行试玩(关键词闸门 + 模板台词,只用来调规则)
pnpm check             # 类型检查 + 单元测试 + 场景校验 + 回归评测
```

网页(Next.js,离线引擎 + 内存库,不需要数据库和模型 Key):

```bash
FDE_DEV_LOGIN_CODES=1 ADMIN_EMAILS=you@example.com pnpm dev:web
# 打开 http://localhost:3000/login,用 ADMIN_EMAILS 里的邮箱登录(验证码直接显示在页面上,不需要邀请码),
# 在 /admin 生成邀请码给别人。数据落在 .data/dev-store.json。
# 再加 FDE_DEV_SMS_LOGIN=1 可以在本地试手机号登录(不真发短信,验证码同样显示在页面上)。
pnpm build:web         # 生产构建(standalone 产物,Docker 镜像用的就是它)
pnpm test:e2e:mock     # 前端 e2e:拦截接口返回 fixtures,手机和电脑两个视口
pnpm test:e2e:real     # 真后端 e2e:构建 standalone 产物并启动,从登录走到复盘
```

接口与存储的契约在 `packages/contracts/`(冻结);`pnpm fixtures` 用离线引擎重新生成前端 e2e 用的接口样例。

CI(`.github/workflows/ci.yml`)在每个 PR 上跑三组:类型检查与单元测试与回归评测、合成单据自检、网页构建与两套 e2e。本地一键跑第一组:`pnpm ci:local`;各组怎么在本地复现见 [`docs/ci.md`](./docs/ci.md)。

接真模型(四个环节都用 DeepSeek,只需要 `DEEPSEEK_API_KEY`;百炼的配置留在 `config/models.yaml` 里,换回去只改 `stages`):

```bash
cp .env.example .env            # 填 DEEPSEEK_API_KEY
pnpm models:check               # 第一个要跑的:每个环节的 Key、真请求、JSON 输出、价格登记、快照固定,见 docs/models.md
pnpm play                       # 闸门、演员、裁判、复盘都走 config/models.yaml
pnpm evals --live               # 闸门和演员用真模型跑回归,打印质量门槛表;没过门槛退出码为 1
pnpm evals:adversarial --live   # 对抗集:泄露 60 轮、追问数字 61 轮,只看实际交付给用户的台词
pnpm calibrate --live           # 裁判标定:稳定性(3 次极差 ≤ 6)与人工标注一致性(≥ 80%),见 docs/calibration.md
```

不调模型时 `pnpm calibrate --mock` 回放仓库里的示例用例,用来检查工具本身;`pnpm models:check --no-network` 只做静态检查。

质量门槛(方案 4.3 与 W1 验收)写在 `config/quality-gates.yaml`:闸门触发器命中率、多命中率、每轮中位耗时 < 4 秒、兜底台词比例、交付台词里的泄露与白名单外数字、单局花费。泄露和编造由一个独立的交付台词审计判(认得「四百多」「六万八」「三成」这类说法),不信守卫的自查。三个没有方案出处的阈值标了【待验证】,第一次真跑之后按 [`docs/quality-gates.md`](./docs/quality-gates.md) 校准一次。

部署(阿里云 ECS + Docker Compose + Caddy + PostgreSQL 16)见 [`docs/deploy.md`](./docs/deploy.md),上线前的合规清单(备案、算法与模型公示、AIGC 标识、个人信息保护)见 [`docs/compliance-checklist.md`](./docs/compliance-checklist.md)。所有环境变量列在 `.env.example`,`infra/test` 会检查代码里读到的每个变量都在里面。

合成数据(Python,离线工具,不进线上):

```bash
python3 -m venv tools/docgen/.venv && tools/docgen/.venv/bin/pip install -r tools/docgen/requirements.txt
tools/docgen/.venv/bin/python tools/docgen/gen_truth.py
tools/docgen/.venv/bin/python tools/docgen/render_xlsx.py
tools/docgen/.venv/bin/python tools/docgen/render_docs.py   # 单据图片与 PDF(需要无头 Chromium 和中文字体)
tools/docgen/.venv/bin/python tools/docgen/check_truth.py   # 113 项自洽检查
tools/docgen/.venv/bin/python tools/docgen/check_docs.py    # 合成单据自检(线索、标识、可读性)
```

每份合成单据都有可见的「合成样本·训练用」标识和元数据里的 AIGC 标识;单据上的公司、人名、单号都是虚构的。详见 [`tools/docgen/README.md`](./tools/docgen/README.md)。

## 内测运营

都在 `/admin` 页面底部(各自展开后才加载):

- **候补名单**:没有邀请码的人在落地页或 `/waitlist` 留邮箱。发内容时把链接写成 `https://<域名>/waitlist?from=xhs`(或 `/?from=jike`),来源会记下来。管理页里按登记顺序或勾选发邀请码;配了 SMTP 会发邀请邮件(链接自动填好邮箱和邀请码),没配就在页面上复制。可导出 CSV。邀请码在对方验证通过时才消耗,输错邮箱不会作废。
- **继续 / 转向 / 放弃(方案 6.3)**:三关指标按时间范围算,门槛在 `config/gates.yaml`(数值照抄方案,按你的粉丝基数校准一次)。完成者在线时长按事件间隔算(空闲超过 10 分钟按 10 分钟计);"新用户从落地页到第一句话"的秒数也在这里。
- **兑换码**:商品在 `config/products.yaml`(默认两个商品都没上架,价格待定)。线下成交或企业试点时给任意商品生成兑换码,对方在 `/redeem` 兑换;上架商品后预售页 `/presale` 才出现,站内只核销兑换码、不收款。
- **手机号登录**:短信签名和模板审核通过后,按 [`docs/sms.md`](./docs/sms.md) 填四个 `ALIYUN_SMS_*`,登录页就会出现手机号入口。

## 第一关:试玩与内容(备案下来之前)

方案 6.1 的 L0/L1 和附录 E 第 3–7 天。引擎已经有了,L1 试玩直接用真引擎在本机跑,不再做单提示词版(没有 Key 时才退回单提示词):

```bash
pnpm playtest --dry-run    # 只做启动前检查:Key、管理员邮箱、库文件路径
pnpm playtest              # 本机用真引擎起网页(只监听 127.0.0.1),试玩者当面或腾讯会议远程控制
pnpm playtest --offline    # 不调模型,只彩排流程;对局存进另一个文件,不拿去标定
pnpm session:export --list                              # 列出本地或线上库里的对局
pnpm session:export --id <对局 id> --calibrate <caseId>  # 一局导出成标定用例(方案 3.4.4)
```

怎么组织一场试玩、每局后问哪三个问题、怎么让远程的人玩,见 [`docs/playtest.md`](./docs/playtest.md)。首条内容、备用角度、试玩招募话术、试玩记录表和第一关判定表的草稿在 [`docs/gate1/`](./docs/gate1/),要按你自己的经历改写后再发。

## 目录

```text
packages/engine/      引擎(纯 TypeScript,不依赖任何模型 SDK)
  src/scenario/       场景 schema(严格模式)、加载、校验器
  src/director.ts     导演:时间、承诺账本、信任与授权、解锁、压力时刻、态度指令
  src/guard.ts        守卫:数字白名单、金丝雀词、出戏词、附和词
  src/prompts/        演员、闸门提示词(附录 A、D)
  src/judge.ts        裁判提示词与输出校验(附录 B)
  src/scoring.ts      D1–D7 与封顶规则(全部由代码算)
  src/debrief.ts      复盘数据与文稿(附录 C)
  src/engine.ts       把闸门 → 导演 → 演员 → 守卫串起来;收工后裁判 → 算分 → 复盘
  src/offline/        不接模型的实现:关键词闸门、模板演员(测试与调试用)
  src/view.ts         给浏览器的视图(PublicView / PublicReport):只有已出现的人、已拿到的资料
packages/llm/         模型网关:OpenAI 兼容协议、按环节选模型、重试、计费日志
packages/contracts/   接口与存储契约(api.ts、store.ts)和接口样例 fixtures
packages/store/       存储:MemoryStore(开发、测试)与 PgStore(线上),共用一套一致性测试
apps/web/             网页:Next.js 16(App Router)
  app/api/            接口(登录、对局、资料文件、复盘、反馈、管理)
  app/                页面:落地页、登录、对局、复盘、我的对局、管理页、协议页
  lib/server/         服务端:鉴权、限频、引擎接入、资料下发
  content/legal/      用户协议、隐私政策、AI 说明(草稿,须法务审阅)
  e2e/mock/           前端 e2e(拦截接口)
  e2e/real/           真后端 e2e(standalone 产物 + 离线引擎 + 内存库)
apps/cli/             命令行:play(试玩)、validate(场景校验)、models-check(模型预检)
tools/evals/          回归评测运行器;src/calibration/ 是裁判标定工具,src/quality/ 是质量门槛与交付台词审计,
                      src/adversarial/ 是对抗集运行器;session-export.ts、playtest.ts 是对局导出和本地试玩
tools/docgen/         合成数据:先造账(真值表、异常表、费用表),再出 Excel 和单据图片、PDF
scenarios/freight-docs/
  scenario.yaml       场景一:货代公司的「单据识别」
  truth/              真值表(只给导演、裁判和数据脚本用)
  artifacts/          资料文件(经鉴权接口下发,不打包进前端)
  narratives/         现场观察、参考路径、现实对照(预先写好,不由模型生成)
  evals/players/      10 个脚本化玩家
  evals/adversarial/  对抗集:泄露(leak.yaml)与追问数字(numbers.yaml)
  evals/calibration/  标定用例(现有两个是示例,正式标定时删掉)
config/models.yaml    线上模型配置
config/quality-gates.yaml  方案 4.3 质量门槛与 W1 验收(在线回归和对抗集按它判过不过)
config/gates.yaml     方案 6.3 的指标门槛
config/products.yaml  商品、免费场景、预售开关
infra/                Dockerfile、docker-compose、Caddyfile、备份脚本;db/ 是建表脚本
docs/                 部署、合规清单、标定流程、质量门槛、模型预检、试玩、短信、CI、各轮开发规格;
                      gate1/ 是第一关内容草稿,author-review/ 是给作者的场景事实核对
.github/workflows/    CI
```

## 引擎的几条硬约束

这些是方案第 3 章的核心,代码和测试都围绕它们:

1. **演员不知道答案。** 演员的上下文里只有它自己的人设、公共背景、它已经说过的事实、本轮导演允许它说的内容。未解锁的事实物理上不在上下文里(`tools/evals/test/players.test.ts` 跑遍所有脚本化玩家检查这一点)。
2. **闸门只做标注。** 闸门只看到触发器描述("什么样的提问算命中"),看不到事实内容。
3. **导演是代码。** 解锁、时间、信任、授权、承诺账本、压力时刻、态度指令全部由规则决定,同样的输入永远得到同样的结果,可以回归。
4. **模型不出分。** 裁判只抽证据(引用回合号或判断表单字段),程序先校验引用再算分;D1、D2、D6 纯规则,D3 由闸门标签汇总。
5. **一切可回归。** 改提示词、换模型之后先跑 `pnpm evals --live`。

## 回归评测

`scenarios/freight-docs/evals/players/` 下每个文件是一个脚本化玩家,对应 `scenario.yaml` 里 `evals` 的一条。每一步说话都附带一份"标准答案"闸门标注:

- **离线模式(默认)**:直接把标注喂给导演,演员用模板、裁判用玩家文件里的固定输出。完全确定,测的是导演、算分和场景设计。`EV_good` 按方案 3.5.3 的参考路径走,每个检查点的累计用时与方案一致(40 / 80 / 120 / 185 / 235 / 275 / 320 分钟)。
- **在线模式(`--live`)**:闸门和演员用真模型,标注用来对照闸门命中率;泄露、编造、出戏、附和这几类断言只有在线模式才有意义。跑完打印质量门槛表,任何一道门槛没过退出码为 1(离线时只在线才有意义的门槛显示「跳过」)。

另有两套对抗集(`scenarios/freight-docs/evals/adversarial/`):注入、索要答案、跳出角色(60 轮),和向每个角色追问他不该知道的数字(61 轮)。离线跑是冒烟测试(在 `pnpm test` 里),在线跑(`pnpm evals:adversarial --live`)才判方案 4.3 的「泄露为 0」「编造为 0」。

当前离线结果(总分):EV_good 98 · EV_boss_only 45(封顶前 48.2)· EV_leading 27 · EV_rude 20 · EV_numbers 17 · EV_offtopic 17 · EV_sycophancy 16 · EV_jailbreak 14 · EV_lazy 14 · EV_rush 4。

玩家文件里的裁判固定输出和闸门标注都按严格模式校验:拼错的键、未知的触发器 id、被拒绝的按钮动作、会话提前结束后没执行的步骤,都会让评测失败,而不是悄悄通过。

`pnpm test` 还会跑一条不变量检查:把 10 个玩家全部跑一遍,确认每次演员调用的提示词里都没有该角色还没说过的事实原文或印象,闸门提示词里没有任何事实内容。

## 相对方案 YAML 的改动

方案说 3.5 节的 YAML 是初稿。为了让条件能被代码判定,做了这些改动(都通过了校验器):

| 位置 | 改动 | 原因 |
|---|---|---|
| `flags` | 改成 `{desc, granted_by}` | 代码要知道授权找谁要 |
| `facts[].canaries` | 新增,给 7 条事实登记特征词 | 守卫的金丝雀词(3.3.5) |
| `artifacts[].supports` | 新增 | 裁判 A 级证据的校验要知道哪份资料支持哪个对照项 |
| `traps` | 新增 `after`、`sets`、`discover`、`reveal`、`stance`;TR3 改为 `after: [TR1]` | 原来写在 beat 括号里的副作用("同时置 auth_ops")改成可执行字段 |
| TR2 | "刘敏" 改为 "刘姐" | 和角色名一致,否则会被当成编造的人名 |
| `rubric.caps[].if` | 改成 `only_talked_to(zhou)` 这类代码可判定的条件,原文挪到 `label` | 原来是自然语言 |
| P5@chen:L3 的 ask | "小抄" 改为 "自己整理的对照资料" | 触发器描述不应含事实的特征词(4.3) |
| S2@zhou:L2 的 ask | 写明"为什么偏偏现在、什么具体的事促使",并排除"只问错了多少、损失多少、问题出在哪" | 第一次真模型回归:泛泛问问题、问损失也命中 S2,关键事实被白送(EV_jailbreak 的 D1 超标) |
| TR2 的 when | 加上 "或问操作上的事该找谁" | 第一次真模型回归(2026-10-09):"操作上的细节谁最清楚?"闸门不认作问操作细节,刘姐出不来,后面去现场被拒 |

写不成表达式的压力时刻条件(TR2、TR3)由闸门识别,校验器会列出来。

## 上线前还要做的

工程上能做的都做了,下面这些需要人来做:

- **模型 Key 与标定**:填 `DEEPSEEK_API_KEY`,先跑 `pnpm models:check`,再跑 `pnpm evals --live --runs 3` 和 `pnpm evals:adversarial --live` 过质量门槛(第一次真跑后校准三个【待验证】阈值);DeepSeek 没有带日期的快照名,上游一换版本或价格就重跑回归(`pnpm models:check` 会提示)。按 [`docs/calibration.md`](./docs/calibration.md) 人工标注 20 份对话(试玩和内测的对局用 `pnpm session:export` 导出),跑 `pnpm calibrate --live` 过两道门槛。
- **第一关**:按 [`docs/gate1/`](./docs/gate1/) 改写并发首条内容,约 5 人试玩(见 [`docs/playtest.md`](./docs/playtest.md)),对照方案 6.3 第一关下结论。
- **备案与公示**:ICP 备案号、公安备案号、模型公示文字(`SITE_ICP_NUMBER`、`SITE_PUBLIC_SECURITY_NUMBER`、`SITE_MODEL_DISCLOSURE`),逐项对照 [`docs/compliance-checklist.md`](./docs/compliance-checklist.md)。
- **协议文本**:`apps/web/content/legal/` 下三份是草稿,不构成法律意见,须法务审阅后替换。
- **发信**:配置 `SMTP_URL`、`MAIL_FROM`(阿里云邮件推送)。没配 SMTP 时线上发不出验证码,用户无法登录;不要用开发模式的验证码回显代替(生产环境默认也不会生效)。
- **短信**:提交短信签名和模板;通过后按 `docs/sms.md` 开通手机号登录。开放前请法务看一下隐私政策里手机号那一行。
- **商品与指标**:在 `config/products.yaml` 定价、写购买方式和真人复盘的预约方式,再把要卖的商品设成 `available: true`;按方案 6.3 的说明在 W0 末校准一次 `config/gates.yaml` 的门槛。
- **场景内容**:`narratives/real_world.md` 仍是占位,需要作者按方案 4.2 的流程写;虚构名称查重、LT2609-0446「电子配件」的 HS 编码、方案 3.5.4 的损失量级已经做了一轮公开资料核对,结论和待你拍板的事项见 [`docs/author-review/2026-10-07-场景事实核对.md`](./docs/author-review/2026-10-07-场景事实核对.md)(企查查、天眼查、商标库在境外网络打不开,要在国内网络下补查)。
- **变体 B、C**:引擎已按 `variant` 读取场景并支持 `overlay`,数据还没写。
