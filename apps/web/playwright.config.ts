// 前端 mock e2e:起 next dev(3312 端口),测试里用 page.route 拦截 /api/** 返回 contracts 的 fixtures。
// 两个视口:手机 390×844(isMobile、hasTouch)和电脑 1280×800。浏览器用镜像里预装的 chromium。
import { defineConfig } from "@playwright/test";

// 多个 worktree 同时跑时用 E2E_MOCK_PORT 错开端口(否则会复用到别人的 next dev)
const PORT = Number(process.env.E2E_MOCK_PORT ?? 3312);

export default defineConfig({
  testDir: "e2e/mock",
  outputDir: "test-results/mock",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    launchOptions: { executablePath: "/opt/pw-browsers/chromium" },
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
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    // next dev 探测到 AI 代理环境时会往 apps/web 写 AGENTS.md / CLAUDE.md(不属于本任务的文件),
    // 把探测用的环境变量置空,避免测试跑完留下多余文件。
    env: { AI_AGENT: "", CLAUDECODE: "", CLAUDE_CODE: "", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
