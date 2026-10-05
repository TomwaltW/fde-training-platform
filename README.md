# FDE 训练平台

给想做 FDE 的人一个可以翻车的客户现场:AI 扮演的老板、主管、一线和财务各说各的,你去问、去要数据、去做判断,最后拿到一份逐轮指出问题的复盘。

产品与开发方案见 [`FDE训练平台-产品与开发方案-v1.md`](./FDE训练平台-产品与开发方案-v1.md)。本仓库按方案第 5.2 节的里程碑推进,当前完成的是 **W0 的数据部分 + W1 引擎核心 + W2 的裁判与算分**(命令行可玩,回归评测可跑);网页、登录、部署(W4)还没开始。

## 快速开始

```bash
pnpm install
pnpm validate          # 场景校验(方案 4.3 的检查项)
pnpm test              # 单元测试
pnpm evals             # 回归评测:10 个脚本化玩家,离线、确定性
pnpm play --offline    # 命令行试玩(关键词闸门 + 模板台词,只用来调规则)
pnpm check             # 以上全部
```

接真模型(需要百炼和 DeepSeek 的 API Key):

```bash
cp .env.example .env   # 填 DASHSCOPE_API_KEY、DEEPSEEK_API_KEY
pnpm play              # 闸门、演员、裁判、复盘都走 config/models.yaml
pnpm evals --live      # 闸门和演员用真模型跑回归,报告闸门命中率和花费
```

合成数据(Python,离线工具,不进线上):

```bash
python3 -m venv tools/docgen/.venv && tools/docgen/.venv/bin/pip install -r tools/docgen/requirements.txt
tools/docgen/.venv/bin/python tools/docgen/gen_truth.py
tools/docgen/.venv/bin/python tools/docgen/render_xlsx.py
tools/docgen/.venv/bin/python tools/docgen/check_truth.py   # 113 项自洽检查
```

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
packages/llm/         模型网关:OpenAI 兼容协议、按环节选模型、重试、计费日志
apps/cli/             命令行:play(试玩)、validate(场景校验)
tools/evals/          回归评测运行器
tools/docgen/         合成数据:先造账(真值表、异常表、费用表),再出 Excel
scenarios/freight-docs/
  scenario.yaml       场景一:货代公司的「单据识别」
  truth/              真值表(只给导演、裁判和数据脚本用)
  artifacts/          资料文件(经鉴权接口下发,不打包进前端)
  narratives/         现场观察、参考路径、现实对照(预先写好,不由模型生成)
  evals/players/      10 个脚本化玩家
config/models.yaml    线上模型配置
infra/db/             数据表(W4 启用)
```

## 引擎的几条硬约束

这些是方案第 3 章的核心,代码和测试都围绕它们:

1. **演员不知道答案。** 演员的上下文里只有它自己的人设、公共背景、它已经说过的事实、本轮导演允许它说的内容。未解锁的事实物理上不在上下文里(`packages/engine/test` 里有一条跑遍所有脚本化玩家的检查)。
2. **闸门只做标注。** 闸门只看到触发器描述("什么样的提问算命中"),看不到事实内容。
3. **导演是代码。** 解锁、时间、信任、授权、承诺账本、压力时刻、态度指令全部由规则决定,同样的输入永远得到同样的结果,可以回归。
4. **模型不出分。** 裁判只抽证据(引用回合号或判断表单字段),程序先校验引用再算分;D1、D2、D6 纯规则,D3 由闸门标签汇总。
5. **一切可回归。** 改提示词、换模型之后先跑 `pnpm evals --live`。

## 回归评测

`scenarios/freight-docs/evals/players/` 下每个文件是一个脚本化玩家,对应 `scenario.yaml` 里 `evals` 的一条。每一步说话都附带一份"标准答案"闸门标注:

- **离线模式(默认)**:直接把标注喂给导演,演员用模板、裁判用玩家文件里的固定输出。完全确定,测的是导演、算分和场景设计。`EV_good` 按方案 3.5.3 的参考路径走,每个检查点的累计用时与方案一致(40 / 80 / 120 / 185 / 235 / 275 / 320 分钟)。
- **在线模式(`--live`)**:闸门和演员用真模型,标注用来对照闸门命中率;泄露、编造、出戏、附和这几类断言只有在线模式才有意义。

当前离线结果(总分):EV_good 99 · EV_boss_only 45(封顶前 48.2)· EV_leading 27 · EV_rude 20 · EV_numbers 17 · EV_offtopic 17 · EV_sycophancy 16 · EV_jailbreak 14 · EV_lazy 14 · EV_rush 4。

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

写不成表达式的压力时刻条件(TR2、TR3)由闸门识别,校验器会列出来。

## 还没做的(按方案里程碑)

- **W3** 合成单据的渲染与劣化(A1 样本包、A3/A5/A6/A7/A8 的图片);目前只有 A2、A4、A5 的 Excel。`real_world.md` 是占位,需要作者按 4.2 的流程写。
- **W2 剩余** 用真模型做标定:20 份对话的人工标注、裁判三次运行波动 ≤ ±3(3.4.4)。
- **W4** 网页(Next.js)、邀请码与验证码登录、管理页、部署、合规标识与模型公示。
- 变体 B、C:引擎已按 `variant` 读取场景并支持 `overlay`,数据还没写。
