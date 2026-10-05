// 真后端 e2e:不拦截任何接口,浏览器打到 standalone 产物上(离线引擎 + MemoryStore,见 serve.mjs)。
// 两个视口各走一遍完整流程;两个项目用不同的邮箱,互不影响。浏览器用镜像里预装的 chromium。
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_REAL_PORT ?? 3313);

export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/real",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    launchOptions: { executablePath: "/opt/pw-browsers/chromium" },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    command: "node e2e/real/serve.mjs",
    cwd: join(import.meta.dirname, "../.."),
    url: `http://127.0.0.1:${PORT}/api/site`,
    // 每次都起新的服务(新的内存库),不复用别人开着的
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { E2E_REAL_PORT: String(PORT) },
  },
});
