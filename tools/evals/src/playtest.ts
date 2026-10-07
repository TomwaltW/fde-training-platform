// 本地试玩(方案 6.1 L1、附录 E 第 4–5 天):在本机用真引擎起网页,给试玩者玩。备案下来之前不能公开部署,见 docs/playtest.md。
//   pnpm playtest              读仓库根目录的 .env → 启动前检查 → 起网页(live 模式,只监听本机)
//   pnpm playtest --dry-run    只做检查、打印,不启动
//   pnpm playtest --offline    不调模型,只彩排流程(登录、发邀请码、导出);这样的对局不算试玩、不拿去标定
// 只是 pnpm dev:web 外面的一层:补上根目录 .env(Next.js 只读 apps/web 下的 .env),把引擎写死成 live、
// 缺 Key 或没有管理员时不启动,把内存库路径写成绝对路径(pnpm session:export 读的是同一个文件)。不加任何产品功能。
// 和 pnpm dev:web 唯一的不同:只监听 127.0.0.1。没配发信时验证码显示在页面上,监听所有网卡的话,
// 同一个 Wi-Fi 里的任何人都能用管理员邮箱登录;本机试玩和腾讯会议远程控制都只需要本机地址。
// 退出码:0 正常结束(含 --dry-run);1 网页进程异常退出;2 参数错误或检查没过。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { displayWidth } from "./calibration/report.ts";
import { preflight } from "./playtest/preflight.ts";

const root = resolve(import.meta.dirname, "../../..");
const PORT = "3000"; // 和 apps/web 的 dev 脚本一样
const URL_BASE = `http://localhost:${PORT}`;

const USAGE = `用法:
  pnpm playtest [--dry-run] [--offline]
说明见 docs/playtest.md`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "dry-run": { type: "boolean", default: false },
        offline: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    console.error(`参数错误:${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  // 已经设了的环境变量不会被 .env 覆盖(命令行上临时给的优先)
  if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
  const pf = preflight({ env: process.env, repoRoot: root, offline: values.offline! });

  const labelWidth = Math.max(...pf.info.map(([k]) => displayWidth(k)));
  console.log(`FDE 训练平台 · 本地试玩${values.offline ? "(彩排,离线)" : ""}\n`);
  for (const [k, v] of pf.info) console.log(`  ${k}${" ".repeat(labelWidth - displayWidth(k))}  ${v}`);
  if (pf.warnings.length) console.log("");
  for (const w of pf.warnings) console.log(`! ${w}`);
  if (pf.errors.length) {
    console.error("");
    for (const e of pf.errors) console.error(`✗ ${e}`);
    console.error("\n检查没过,没有启动。");
    return 2;
  }

  console.log(
    [
      "",
      "启动后:",
      `  1. 打开 ${URL_BASE}/login,用管理员邮箱登录(管理员不需要邀请码)`,
      `  2. 打开 ${URL_BASE}/admin,在「生成邀请码」里给每位试玩者生成一个,备注写是谁`,
      `     试玩者打开 ${URL_BASE}/login?invite=<邀请码>,填自己的邮箱登录`,
      "  3. 每局收工后只问三个问题:哪里最像真的?哪里想放弃?完整版你愿意付多少钱?",
      "  4. 导出对局做标定:pnpm session:export --list,再 pnpm session:export --id <对局 id> --calibrate <用例 id>",
      "  每局的模型花费估算见 docs/playtest.md;实际花费看 /admin 或 session:export --list 的「模型调用」一列。Ctrl-C 结束。",
    ].join("\n"),
  );
  if (values["dry-run"]) {
    console.log("\n(--dry-run:检查通过,没有启动网页)");
    return 0;
  }
  console.log("");

  // Ctrl-C 会同时发给网页进程;这里等它自己退出。人为停下的算正常结束,网页自己挂掉的算 1
  const child = spawn("pnpm", ["--filter", "@fde/web", "exec", "next", "dev", "-p", PORT, "-H", "127.0.0.1"], {
    cwd: root,
    env: { ...process.env, ...pf.env },
    stdio: "inherit",
  });
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
    child.kill("SIGTERM");
  });
  return new Promise<number>((done) => {
    child.on("error", (e) => {
      console.error(`启动网页失败:${e.message}`);
      done(1);
    });
    child.on("exit", (code) => done(code === 0 || stopped ? 0 : 1));
  });
}

process.exit(await main());
