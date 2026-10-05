# CI

工作流是 `.github/workflows/ci.yml`。推到 `main`、开 PR 或往 PR 推新提交时都会跑;同一个 PR(或同一个分支)有了新提交,还在跑的旧运行会被取消。工作流只有读代码的权限(`permissions: contents: read`),不需要任何 secret。

三个 job 并行,都跑在 `ubuntu-24.04` 上(和开发镜像是同一个系统版本,原因见「合成单据自检」一节):

| job | 跑什么 |
|---|---|
| 检查 `checks` | 类型检查、单元测试、场景校验、回归评测、标定工具自检、fixtures 是否最新 |
| 合成单据自检 `docgen` | `check_truth.py`、`check_docs.py`(Python) |
| 网页 `web` | 生产构建、前端 mock e2e、真后端 e2e;失败时上传 Playwright 报告 |

Node 22、pnpm 10(版本取根目录 `package.json` 的 `packageManager`),pnpm 的包缓存由 `actions/setup-node` 按 `pnpm-lock.yaml` 缓存;Python 3.11,pip 缓存按 `tools/docgen/requirements.txt`;`web` 另外缓存 Next.js 的构建缓存 `apps/web/.next/cache`。

## 每个 job 在本地怎么跑

下面的命令都在仓库根目录跑。想和 CI 完全一样,命令前加 `CI=1`:Playwright 不复用已经开着的服务,另外输出 HTML 报告。

### 检查

```bash
pnpm install --frozen-lockfile
pnpm ci:local
```

`pnpm ci:local` 依次跑 `pnpm typecheck`、`pnpm test`、`pnpm validate`、`pnpm evals`、`pnpm calibrate --mock`、`pnpm ci:fixtures`,哪一步失败就停在哪一步。`pnpm ci:fixtures` 先 `pnpm fixtures` 重新生成 `packages/contracts/fixtures/`,再检查它和提交的版本一样(`git diff --exit-code`,并且没有新冒出来的未跟踪文件)。所以本地跑之前,fixtures 目录里不要有没提交的改动。

### 合成单据自检

```bash
python3 -m venv tools/docgen/.venv
tools/docgen/.venv/bin/pip install -r tools/docgen/requirements.txt
tools/docgen/.venv/bin/python tools/docgen/check_truth.py
tools/docgen/.venv/bin/python tools/docgen/check_docs.py
```

需要 Python 3.11 及以上(numpy 2.4 的要求)。渲染好的单据、图片、PDF、manifest 都已经提交在仓库里,这两个脚本只读不写,不需要 Chromium。但是 `check_docs.py` 核对图片右下角的「合成样本·训练用」标识牌时,会用文泉驿正黑(`/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc`,见 `tools/docgen/degrade.py` 的 `FONT_PATH`)把标识牌重画一遍,再和图片逐像素比较(PNG 的平均差不能超过 0.5)。没有这个字体文件,脚本会报错。

- Ubuntu / Debian:`sudo apt-get install fonts-wqy-zenhei libfribidi0`,CI 就是这样装的。
- 开发镜像里已经装好了。

因为是逐像素比较,字体文件、Pillow 版本和排版引擎都要和渲染时一样。Pillow 用 Raqm 排版,运行时需要系统里的 libfribidi(`python -c "from PIL import features; print(features.check('raqm'))"` 应该打印 True);缺了会退回基础排版,标识牌的像素对不上,check_docs 报"不是带标识的图片"。Pillow 已经在 `requirements.txt` 里固定了版本,字体用的是 Ubuntu 24.04 的 `fonts-wqy-zenhei`。所以 CI 的 runner 固定为 `ubuntu-24.04`,不用 `ubuntu-latest`。以后要换系统版本,先在新系统上跑一遍 `check_docs.py`。

### 网页

```bash
pnpm install --frozen-lockfile
pnpm build:web
E2E_MOCK_PORT=3355 pnpm test:e2e:mock
E2E_REAL_PORT=3365 E2E_SKIP_BUILD=1 pnpm test:e2e:real
```

- 端口:mock e2e 默认用 3312 端口、真后端 e2e 默认用 3313 端口。同一台机器上有别人(或别的 worktree)也在跑 e2e 时,用 `E2E_MOCK_PORT`、`E2E_REAL_PORT` 换成别的端口。不在 CI 上时,mock e2e 会复用这个端口上已经开着的 `next dev`,端口一样就会测到别人的代码。
- `E2E_SKIP_BUILD=1`:真后端 e2e 默认先 `next build` 一遍(见 `apps/web/e2e/real/serve.mjs`)。设了这个变量就直接用已有的 `.next` 产物,所以只能在刚 `pnpm build:web` 过、之后没改代码的时候设。CI 是同一个 job 里刚构建过,所以设了。验收时不要设。mock e2e 跑的 `next dev` 只写 `.next/dev`,不会动构建产物。
- 浏览器:`/opt/pw-browsers/chromium` 存在时(开发镜像),两个 Playwright 配置都用它。不存在时(GitHub runner、自己的电脑)用 Playwright 自己的浏览器,先装一次:

  ```bash
  pnpm --filter @fde/web exec playwright install --with-deps chromium   # --with-deps 会用 apt 装系统依赖和字体,需要 sudo
  ```

- CI 上(环境变量 `CI` 非空)不重试:不稳定的测试要修,不能靠重试掩盖。CI 上也不复用已有的服务,并且 HTML 报告写到 `apps/web/test-results/mock-report/` 和 `apps/web/test-results/real-report/`。整个 `test-results/` 都被 `.gitignore` 忽略。

真后端 e2e 有两个文件,共用一个服务、一个内存库:

- `full-flow.spec.ts`:电脑、手机两个视口各走一遍,从登录走到复盘。
- `resume.spec.ts`:只在手机视口跑(电脑项目用 `testIgnore` 排除了)。流程是:管理员用接口生成邀请码;新玩家从落地页登录、开局、说 3 句话;刷新页面后 3 句话和剩余时间都还在;去「我的对局」点「接着玩」,回到同一局再说 1 句。这个文件还给「打开落地页 → 第一句话得到回复」计时,超过 60 秒就失败(W4 验收的冒烟检查),用时打在日志里,也写在报告的 annotation 里。

再加真后端 e2e 时注意三点:

- 每个文件用自己的邮箱:验证码请求按邮箱 60 秒限一次,而且所有文件共用同一个内存库。
- 要管理员的话,先把邮箱加进 `serve.mjs` 的 `ADMIN_EMAILS`。
- 所有请求都来自 127.0.0.1,登录接口还按 IP 限频,所以每个文件的验证码请求要尽量少。现在一次完整运行一共发 10 次:full-flow 每个视口 4 次,resume 2 次。服务每次运行都重新启动,计数也跟着清零。

## CI 失败了怎么看

- 检查、合成单据自检这两个 job:日志里直接有失败的命令和输出,在本地跑同一条命令就能复现。
- 网页 job:失败时会上传名为 `playwright-report` 的 artifact(保留 14 天),在运行页面的 Summary 底部下载。解压后执行 `pnpm --filter @fde/web exec playwright show-report <解压目录的绝对路径>/mock-report`(或 `real-report`;这条命令在 `apps/web` 下执行,所以要写绝对路径),在报告里能看到失败的步骤、截图和 trace。mock e2e 失败时,真后端 e2e 照样会跑(只要构建成功),两份报告一起上传。

## 更新截图

`apps/web/e2e/mock/screenshots.spec.ts` 给对局页和复盘页在两个视口各截一张图。

- 平常跑 mock e2e,截图写进本次运行的输出目录(`apps/web/test-results/mock/…`),同时挂到报告上。仓库里的截图不会被改,跑完工作区是干净的。
- 界面改了、需要更新仓库里的截图(`apps/web/e2e/mock/__screenshots__/`)时:

  ```bash
  cd apps/web
  UPDATE_SCREENSHOTS=1 E2E_MOCK_PORT=3355 pnpm exec playwright test e2e/mock/screenshots.spec.ts
  git status --short e2e/mock/__screenshots__   # 逐张看一眼再提交
  ```

  只有 `UPDATE_SCREENSHOTS=1` 才会写进仓库,设成空或别的值都不写。同一个界面每次截出来的 PNG 字节可能有细微差别,所以没改界面时不要更新截图,免得提交一堆没有意义的二进制改动。

## 更新 fixtures

`packages/contracts/fixtures/*.json` 是用离线引擎跑出来的接口响应样例。mock e2e 用它们作接口响应,截图也是用它们截的。契约(`packages/contracts/src/`)、引擎、场景改了以后,要重新生成:

```bash
pnpm fixtures
git diff packages/contracts/fixtures      # 看改动是不是预期的
E2E_MOCK_PORT=3355 pnpm test:e2e:mock     # mock e2e 用的就是这些数据
```

确认没问题后,把 fixtures 和引起变化的改动放在同一个提交里。

## fixtures 检查失败了怎么办

CI 报「fixtures 不是最新的」,意思是:用当前代码重新生成出来的 fixtures,和提交的版本不一样。

1. 本地跑 `pnpm ci:fixtures`,能看到同样的 diff;新生成、但还没提交的文件会以 `??` 开头列出来。
2. 看 diff 是不是你的改动应该带来的:
   - 是预期的(比如改了契约字段、场景文字):提交 `packages/contracts/fixtures/` 的改动,再跑一遍 mock e2e。改动影响了截图里的界面的话,按上一节更新截图。
   - 不是预期的(比如只改了页面,引擎的输出却变了):说明引擎或场景的行为被意外改了,先修代码,不要直接提交 fixtures。
3. 生成器本身是确定的:离线引擎、固定的输入和时间戳,和时区无关(`TZ=Asia/Shanghai pnpm fixtures` 也没有 diff)。所以在干净的工作区里 `pnpm fixtures` 跑出 diff,就是代码真的变了。
