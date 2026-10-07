// pnpm playtest 的启动前检查:缺 Key、没有管理员、FDE_ENGINE_MODE=offline 时不启动;验证码回显、存储位置只提醒。
// 命令行只跑 --help、参数错误和 --dry-run,不会真的起网页。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelsConfig } from "@fde/llm";
import { missingModelKeys, parseAdminEmails, parseDailyLimit, preflight } from "../src/playtest/preflight.ts";

const root = resolve(import.meta.dirname, "../../..");
const cli = join(root, "tools/evals/src/playtest.ts");
const tsx = join(root, "node_modules/.bin/tsx");
const KEYS = { DASHSCOPE_API_KEY: "sk-test-bailian", DEEPSEEK_API_KEY: "sk-test-deepseek" };

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "fde-playtest-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const check = (env: Record<string, string>, offline = false) => preflight({ env, repoRoot: root, offline });
const infoOf = (p: ReturnType<typeof preflight>, label: string) => p.info.find(([k]) => k === label)?.[1];

describe("启动前检查", () => {
  it("Key 和管理员都齐:能启动,引擎写死成 live,内存库路径写成绝对路径,没配发信就打开验证码回显并提醒", () => {
    const p = check({ ...KEYS, ADMIN_EMAILS: " Me@Example.com , ,b@x.com" });
    expect(p.errors).toEqual([]);
    expect(p.env).toEqual({ FDE_ENGINE_MODE: "live", FDE_MEMORY_STORE_FILE: join(root, ".data/dev-store.json"), FDE_DEV_LOGIN_CODES: "1" });
    expect(infoOf(p, "引擎")).toBe("live:闸门 bailian/qwen3.7-flash · 演员 bailian/qwen-plus · 裁判 deepseek/deepseek-v4-pro · 复盘 bailian/qwen3.7-plus");
    expect(infoOf(p, "管理员")).toBe("me@example.com、b@x.com");
    expect(infoOf(p, "存储")).toContain(join(root, ".data/dev-store.json"));
    expect(infoOf(p, "每日局数")).toContain("最多开 3 局");
    expect(p.warnings.join("\n")).toContain("包括 ADMIN_EMAILS 里的管理员邮箱");
  });

  it("没有 Key、没有管理员:两条错误,Key 按变量名合并并写明用在哪个环节", () => {
    const p = check({});
    expect(p.errors).toHaveLength(2);
    expect(p.errors[0]).toContain(
      "缺少模型 Key:DASHSCOPE_API_KEY(闸门 bailian/qwen3.7-flash、演员 bailian/qwen-plus、复盘 bailian/qwen3.7-plus);DEEPSEEK_API_KEY(裁判 deepseek/deepseek-v4-pro)",
    );
    expect(p.errors[1]).toContain("没设 ADMIN_EMAILS");
  });

  it("只有百炼 Key:网页会进 live 模式、收工时裁判却失败——这里直接拦下,只点名 DeepSeek", () => {
    const p = check({ DASHSCOPE_API_KEY: "sk", DEEPSEEK_API_KEY: "  ", ADMIN_EMAILS: "a@x.com" });
    expect(p.errors).toEqual([expect.stringContaining("缺少模型 Key:DEEPSEEK_API_KEY(裁判 deepseek/deepseek-v4-pro)。")]);
    expect(p.errors[0]).not.toContain("DASHSCOPE_API_KEY");
  });

  it("环境里有 FDE_ENGINE_MODE=offline:不启动;--offline 彩排不要 Key,但会提醒这样的对局不算试玩", () => {
    expect(check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_ENGINE_MODE: "offline" }).errors).toEqual([expect.stringContaining("FDE_ENGINE_MODE=offline")]);
    const p = check({ ADMIN_EMAILS: "a@x.com" }, true);
    expect(p.errors).toEqual([]);
    expect(p.env.FDE_ENGINE_MODE).toBe("offline");
    expect(p.warnings[0]).toContain("不算 L1 试玩,也不要拿去标定");
  });

  it("配了发信就不回显验证码;自己设了 FDE_DEV_LOGIN_CODES=1 照样提醒", () => {
    const smtp = check({ ...KEYS, ADMIN_EMAILS: "a@x.com", SMTP_URL: "smtps://u:p@smtp.example.com" });
    expect(smtp.env.FDE_DEV_LOGIN_CODES).toBeUndefined();
    expect(infoOf(smtp, "登录")).toContain("发邮件");
    expect(smtp.warnings).toEqual([]);
    const both = check({ ...KEYS, ADMIN_EMAILS: "a@x.com", SMTP_URL: "smtps://x", FDE_DEV_LOGIN_CODES: "1" });
    expect(both.warnings.join("\n")).toContain("验证码显示在页面上");
  });

  it("存储:和网页同一套约定;空的 FDE_MEMORY_STORE_FILE 会改用默认文件并提醒;有 DATABASE_URL 不改内存库路径", () => {
    const base = { ...KEYS, ADMIN_EMAILS: "a@x.com" };
    expect(check({ ...base, FDE_MEMORY_STORE_FILE: ".data/playtest.json" }).env.FDE_MEMORY_STORE_FILE).toBe(join(root, "apps/web/.data/playtest.json"));
    const empty = check({ ...base, FDE_MEMORY_STORE_FILE: "" });
    expect(empty.env.FDE_MEMORY_STORE_FILE).toBe(join(root, ".data/dev-store.json"));
    expect(empty.warnings.join("\n")).toContain("FDE_MEMORY_STORE_FILE 是空的");
    const pg = check({ ...base, DATABASE_URL: "postgres://fde:secret@127.0.0.1:5432/fde" });
    expect(pg.env.FDE_MEMORY_STORE_FILE).toBeUndefined();
    expect(infoOf(pg, "存储")).toContain("PostgreSQL 127.0.0.1:5432/fde");
    expect(infoOf(pg, "存储")).not.toContain("secret");
  });

  it("模型配置读不进来算错误;各环节换了 Key 变量名也照配置检查", () => {
    expect(check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_MODELS_CONFIG: join(tmp(), "nope.yaml") }).errors[0]).toContain("找不到模型配置");
    const dir = tmp();
    const text = readFileSync(join(root, "config/models.yaml"), "utf8").replace("api_key_env: DEEPSEEK_API_KEY", "api_key_env: FDE_PLAYTEST_TEST_JUDGE_KEY");
    writeFileSync(join(dir, "models.yaml"), text);
    const cfg = loadModelsConfig(join(dir, "models.yaml"));
    expect(missingModelKeys(cfg, KEYS)).toEqual(["FDE_PLAYTEST_TEST_JUDGE_KEY(裁判 deepseek/deepseek-v4-pro)"]);
  });

  it("管理员邮箱和每日局数的解析和网页一致", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails("A@x.com,, b@y.com ")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseDailyLimit(undefined)).toBe(3);
    expect(parseDailyLimit("10")).toBe(10);
    expect(parseDailyLimit("-1")).toBe(3);
    expect(parseDailyLimit("abc")).toBe(3);
  });
});

describe("命令行", () => {
  // 用一份 Key 变量名独一无二的模型配置,并把相关变量都显式给出(.env 不会覆盖已经设了的变量),
  // 本机 .env 里写了什么都不影响结果
  const run = (args: string[], env: Record<string, string>) => {
    const dir = tmp();
    const text = readFileSync(join(root, "config/models.yaml"), "utf8")
      .replace("api_key_env: DASHSCOPE_API_KEY", "api_key_env: FDE_PLAYTEST_TEST_BAILIAN_KEY")
      .replace("api_key_env: DEEPSEEK_API_KEY", "api_key_env: FDE_PLAYTEST_TEST_DEEPSEEK_KEY");
    writeFileSync(join(dir, "models.yaml"), text);
    const r = spawnSync(tsx, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        FDE_MODELS_CONFIG: join(dir, "models.yaml"),
        FDE_ENGINE_MODE: "",
        DATABASE_URL: "",
        FDE_MEMORY_STORE_FILE: join(dir, "store.json"),
        FDE_PLAYTEST_TEST_BAILIAN_KEY: "",
        FDE_PLAYTEST_TEST_DEEPSEEK_KEY: "",
        ADMIN_EMAILS: "",
        ...env,
      },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, store: join(dir, "store.json") };
  };

  it("--help、参数错误", () => {
    expect(run(["--help"], {}).code).toBe(0);
    const bad = run(["--port", "3001"], {});
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("参数错误");
  }, 60_000);

  it("--dry-run:检查没过退出码 2 且不启动;检查通过退出码 0,打印管理页地址和导出命令", () => {
    const fail = run(["--dry-run"], {});
    expect(fail.code).toBe(2);
    expect(fail.out).toContain("缺少模型 Key:FDE_PLAYTEST_TEST_BAILIAN_KEY");
    expect(fail.out).toContain("检查没过,没有启动");

    const ok = run(["--dry-run"], { FDE_PLAYTEST_TEST_BAILIAN_KEY: "sk-a", FDE_PLAYTEST_TEST_DEEPSEEK_KEY: "sk-b", ADMIN_EMAILS: "me@example.com" });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("http://localhost:3000/admin");
    expect(ok.out).toContain("生成邀请码");
    expect(ok.out).toContain("pnpm session:export --list");
    expect(ok.out).toContain(`内存库 ${ok.store}`);
    expect(ok.out).toContain("--dry-run:检查通过,没有启动网页");
  }, 60_000);
});
