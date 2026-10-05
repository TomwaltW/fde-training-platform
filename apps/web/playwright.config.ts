// 前端 mock e2e:起 next dev(默认 3312 端口),测试里用 page.route 拦截 /api/** 返回 contracts 的 fixtures。
// 两个视口:手机 390×844(isMobile、hasTouch)和电脑 1280×800。
// 浏览器:镜像里预装了 /opt/pw-browsers/chromium 就用它;没有(比如 GitHub Actions)就用 Playwright 自己装的
// (`pnpm --filter @fde/web exec playwright install --with-deps chromium`)。
// CI(环境变量 CI 非空)上:不重试(不掩盖不稳定的测试)、另出一份 HTML 报告到 test-results/mock-report、不复用已有的服务。
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// 多个 worktree 同时跑时用 E2E_MOCK_PORT 错开端口(否则会复用到别人的 next dev)
const PORT = Number(process.env.E2E_MOCK_PORT ?? 3312);
const CI = !!process.env.CI;
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "e2e/mock",
  outputDir: "test-results/mock",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  // HTML 报告不能放进 outputDir(每次运行开头会清空 outputDir);test-results/ 整个被 .gitignore 忽略
  reporter: CI ? [["list"], ["html", { outputFolder: "test-results/mock-report", open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    launchOptions: existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {},
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    cwd: import.meta.dirname,
    url: `http://localhost:${PORT}`,
    // 本地可以复用自己开着的 next dev;CI 上每次都起新的
    reuseExistingServer: !CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    // next dev 探测到 AI 代理环境时会往 apps/web 写 AGENTS.md / CLAUDE.md(不属于本任务的文件),
    // 把探测用的环境变量置空,避免测试跑完留下多余文件。
    env: { AI_AGENT: "", CLAUDECODE: "", CLAUDE_CODE: "", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
