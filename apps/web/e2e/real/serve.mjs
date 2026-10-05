// 真后端 e2e 的服务端:按 infra/Dockerfile 的方式跑 Next.js standalone 产物(node apps/web/server.js),
// 离线引擎 + MemoryStore(每次启动一个新的落盘文件),不连数据库、不调模型、不发信。
//
//   E2E_SKIP_BUILD=1  复用已有的 .next 产物(本地反复跑时省一分钟;CI 和验收不要设)
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
const repo = resolve(web, "../..");
const port = process.env.E2E_REAL_PORT ?? "3313";

// next 探测到 AI 代理环境时会往 apps/web 写 AGENTS.md / CLAUDE.md,置空避免留下多余文件
const quiet = { AI_AGENT: "", CLAUDECODE: "", CLAUDE_CODE: "", NEXT_TELEMETRY_DISABLED: "1" };

if (process.env.E2E_SKIP_BUILD !== "1" || !existsSync(join(web, ".next/standalone/apps/web/server.js"))) {
  const r = spawnSync("pnpm", ["exec", "next", "build"], { cwd: web, stdio: "inherit", env: { ...process.env, ...quiet } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// standalone 只带服务端代码;静态资源、public、协议文件要自己拷(与 Dockerfile 运行阶段一致)
const app = join(web, ".next/standalone/apps/web");
cpSync(join(web, ".next/static"), join(app, ".next/static"), { recursive: true });
cpSync(join(web, "public"), join(app, "public"), { recursive: true });
cpSync(join(web, "content"), join(app, "content"), { recursive: true });

const dataDir = join(web, "test-results/real-data");
mkdirSync(dataDir, { recursive: true });
const storeFile = join(dataDir, `store-${process.pid}.json`);
rmSync(storeFile, { force: true });

/** 场景、模型配置、建表脚本从仓库根目录读(容器里是 /app,这里直接指向仓库)。 */
const env = {
  ...process.env,
  ...quiet,
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: port,
  FDE_ROOT: repo,
  FDE_ENGINE_MODE: "offline",
  FDE_MEMORY_STORE_FILE: storeFile,
  FDE_AUTH_SECRET: "e2e-real-secret",
  FDE_DEV_LOGIN_CODES: "1",
  // 这里跑的是生产构建(NODE_ENV=production),开发模式验证码要再加这个开关才生效
  FDE_DEV_LOGIN_CODES_IN_PRODUCTION: "1",
  FDE_COOKIE_SECURE: "0",
  FDE_DAILY_SESSION_LIMIT: "20",
  ADMIN_EMAILS: "admin-desktop@e2e.test,admin-mobile@e2e.test",
  SITE_MODEL_DISCLOSURE: "通义千问 qwen-plus(e2e)",
  SITE_ICP_NUMBER: "",
  // 这些一旦从外部环境漏进来,测试就不再是"离线 + 内存库"了
  DATABASE_URL: "",
  DASHSCOPE_API_KEY: "",
  DEEPSEEK_API_KEY: "",
  SMTP_URL: "",
};

const child = spawn(process.execPath, ["server.js"], { cwd: app, stdio: "inherit", env });
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => {
  rmSync(storeFile, { force: true });
  process.exit(code ?? 0);
});
