// 真后端 e2e:不拦截任何接口,浏览器打到 standalone 产物上(离线引擎 + MemoryStore,见 serve.mjs)。
// full-flow 两个视口各走一遍完整流程;resume(存档续玩)只在手机视口跑。所有测试共用一个服务、一个内存库,
// 各自用不同的邮箱(验证码请求按邮箱 60 秒限一次),互不影响。
// 浏览器:镜像里预装了 /opt/pw-browsers/chromium 就用它;没有(比如 GitHub Actions)就用 Playwright 自己装的
// (`pnpm --filter @fde/web exec playwright install --with-deps chromium`)。
// CI(环境变量 CI 非空)上:不重试、另出一份 HTML 报告到 apps/web/test-results/real-report。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_REAL_PORT ?? 3313);
const CI = !!process.env.CI;
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/real",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // HTML 报告不能放进 outputDir(每次运行开头会清空 outputDir);test-results/ 整个被 .gitignore 忽略
  reporter: CI ? [["list"], ["html", { outputFolder: "../../test-results/real-report", open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    launchOptions: existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {},
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
      // 存档续玩是手机上的验收项,电脑视口不跑
      testIgnore: "resume.spec.ts",
    },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
      // 候补名单到注册、兑换的运营流程主要在电脑上的管理页里走,只跑一遍
      testIgnore: "growth.spec.ts",
    },
  ],
  webServer: {
    command: "node e2e/real/serve.mjs",
    cwd: join(import.meta.dirname, "../.."),
    url: `http://127.0.0.1:${PORT}/api/site`,
    // 每次都起新的服务(新的内存库),本地和 CI 都不复用别人开着的
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { E2E_REAL_PORT: String(PORT) },
  },
});
