// pnpm playtest 的启动前检查:缺 Key、没有管理员、FDE_ENGINE_MODE=offline、有 DATABASE_URL、验证码登录不了时不启动;
// 验证码回显、存储位置、apps/web 下的 .env* 只提醒。
// 命令行只跑 --help、参数错误和 --dry-run,不会真的起网页。子进程不继承 process.env、用 --dotenv 避开仓库根目录的 .env,
// 本机的 .env、apps/web/.env*、shell 里的变量都不影响结果(最后一个用例拿一份"毒" .env 验证)。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelsConfig } from "@fde/llm";
import { missingModelKeys, parseAdminEmails, parseDailyLimit, preflight } from "../src/playtest/preflight.ts";
import { webEnvFiles } from "../src/sessions/store.ts";
import { cliEnv, emptyEnvFile } from "./helpers.ts";

const root = resolve(import.meta.dirname, "../../..");
const cli = join(root, "tools/evals/src/playtest.ts");
const tsx = join(root, "node_modules/.bin/tsx");
const KEYS = { DASHSCOPE_API_KEY: "sk-test-bailian", DEEPSEEK_API_KEY: "sk-test-deepseek" };

/**
 * 两家供应商的固定配置(2026-10-09 之前仓库用的布局:闸门、演员、复盘走百炼,裁判走 DeepSeek)。
 * "Key 按变量名合并""缺哪家只点名哪家"这几条断言要两家才测得出来,所以不随仓库的 config/models.yaml 变;
 * 仓库当前配置(四个环节都走 DeepSeek)另有一条用例。
 */
const TWO_VENDOR_YAML = `
providers:
  bailian: {base_url: https://dashscope.aliyuncs.com/compatible-mode/v1, api_key_env: DASHSCOPE_API_KEY}
  deepseek: {base_url: https://api.deepseek.com, api_key_env: DEEPSEEK_API_KEY}
stages:
  gate: {provider: bailian, model: qwen3.7-flash, temperature: 0, max_tokens: 600, json: true, extra: {enable_thinking: false}}
  actor: {provider: bailian, model: qwen-plus, temperature: 0.8, max_tokens: 300, extra: {enable_thinking: false}}
  judge: {provider: deepseek, model: deepseek-v4-pro, temperature: 0, max_tokens: 8000, json: true}
  debrief: {provider: bailian, model: qwen3.7-plus, temperature: 0.5, max_tokens: 2000, extra: {enable_thinking: false}}
prices:
  qwen3.7-flash: [0.2, 0.8]
  qwen-plus: [0.8, 2]
  qwen3.7-plus: [2, 8]
  deepseek-v4-pro: [9, 27]
`;

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
/**
 * 断言"没有提醒"时用:repoRoot 换成空的临时目录(模型配置给绝对路径),本机 apps/web 下有 .env* 也不会多出一条提醒。
 * check() 的 repoRoot 是真的仓库根目录,只用在不关心那条提醒的断言上。
 */
const checkIsolated = (env: Record<string, string>, offline = false) =>
  preflight({ env: { FDE_MODELS_CONFIG: join(root, "config/models.yaml"), ...env }, repoRoot: tmp(), offline });
/** 把两家供应商的固定配置写进临时目录,返回路径。 */
const twoVendor = () => {
  const f = join(tmp(), "models.yaml");
  writeFileSync(f, TWO_VENDOR_YAML);
  return f;
};
const infoOf = (p: ReturnType<typeof preflight>, label: string) => p.info.find(([k]) => k === label)?.[1];

describe("启动前检查", () => {
  it("Key 和管理员都齐:能启动,引擎写死成 live,内存库路径写成绝对路径,没配发信就打开验证码回显并提醒", () => {
    const p = check({ ...KEYS, ADMIN_EMAILS: " Me@Example.com , ,b@x.com", FDE_MODELS_CONFIG: twoVendor() });
    expect(p.errors).toEqual([]);
    expect(p.env).toEqual({
      FDE_ENGINE_MODE: "live",
      DATABASE_URL: "",
      FDE_MEMORY_STORE_FILE: join(root, ".data/dev-store.json"),
      FDE_DEV_LOGIN_CODES: "1",
    });
    expect(infoOf(p, "引擎")).toBe("live:闸门 bailian/qwen3.7-flash · 演员 bailian/qwen-plus · 裁判 deepseek/deepseek-v4-pro · 复盘 bailian/qwen3.7-plus");
    expect(infoOf(p, "管理员")).toBe("me@example.com、b@x.com");
    expect(infoOf(p, "存储")).toContain(join(root, ".data/dev-store.json"));
    expect(infoOf(p, "每日局数")).toContain("最多开 3 局");
    expect(p.warnings.join("\n")).toContain("包括 ADMIN_EMAILS 里的管理员邮箱");
  });

  it("没有 Key、没有管理员:两条错误,Key 按变量名合并并写明用在哪个环节", () => {
    const p = check({ FDE_MODELS_CONFIG: twoVendor() });
    expect(p.errors).toHaveLength(2);
    expect(p.errors[0]).toContain(
      "缺少模型 Key:DASHSCOPE_API_KEY(闸门 bailian/qwen3.7-flash、演员 bailian/qwen-plus、复盘 bailian/qwen3.7-plus);DEEPSEEK_API_KEY(裁判 deepseek/deepseek-v4-pro)",
    );
    expect(p.errors[1]).toContain("没设 ADMIN_EMAILS");
  });

  it("只有百炼 Key:网页会进 live 模式、收工时裁判却失败——这里直接拦下,只点名 DeepSeek", () => {
    const p = check({ DASHSCOPE_API_KEY: "sk", DEEPSEEK_API_KEY: "  ", ADMIN_EMAILS: "a@x.com", FDE_MODELS_CONFIG: twoVendor() });
    expect(p.errors).toEqual([expect.stringContaining("缺少模型 Key:DEEPSEEK_API_KEY(裁判 deepseek/deepseek-v4-pro)。")]);
    expect(p.errors[0]).not.toContain("DASHSCOPE_API_KEY");
  });

  it("仓库当前的 config/models.yaml:四个环节都走 DeepSeek,只要 DEEPSEEK_API_KEY;只有百炼 Key 时点名 DeepSeek 和全部四个环节", () => {
    expect(check({ DEEPSEEK_API_KEY: "sk", ADMIN_EMAILS: "a@x.com" }).errors).toEqual([]);
    const p = check({ DASHSCOPE_API_KEY: "sk", ADMIN_EMAILS: "a@x.com" });
    expect(p.errors).toEqual([
      expect.stringContaining(
        "缺少模型 Key:DEEPSEEK_API_KEY(闸门 deepseek/deepseek-flash、演员 deepseek/deepseek-flash、裁判 deepseek/deepseek-v4-pro、复盘 deepseek/deepseek-flash)。",
      ),
    ]);
    expect(p.errors[0]).not.toContain("DASHSCOPE_API_KEY");
  });

  it("环境里有 FDE_ENGINE_MODE=offline:不启动;--offline 彩排不要 Key,但会提醒这样的对局不算试玩", () => {
    expect(check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_ENGINE_MODE: "offline" }).errors).toEqual([expect.stringContaining("FDE_ENGINE_MODE=offline")]);
    const p = check({ ADMIN_EMAILS: "a@x.com" }, true);
    expect(p.errors).toEqual([]);
    expect(p.env.FDE_ENGINE_MODE).toBe("offline");
    expect(p.warnings[0]).toContain("不算 L1 试玩,也不要拿去标定");
  });

  it("--offline 彩排默认存进另一个文件,不混进试玩的库(/admin 的完成率、每局成本才是试玩的数字);自己指定了文件就用指定的", () => {
    const p = check({ ADMIN_EMAILS: "a@x.com" }, true);
    expect(p.env.FDE_MEMORY_STORE_FILE).toBe(join(root, ".data/playtest-rehearsal.json"));
    expect(infoOf(p, "存储")).toContain("彩排专用");
    const empty = check({ ADMIN_EMAILS: "a@x.com", FDE_MEMORY_STORE_FILE: " " }, true);
    expect(empty.env.FDE_MEMORY_STORE_FILE).toBe(join(root, ".data/playtest-rehearsal.json"));
    expect(empty.warnings.join("\n")).toContain(`已改用默认文件 ${join(root, ".data/playtest-rehearsal.json")}`);
    const own = check({ ADMIN_EMAILS: "a@x.com", FDE_MEMORY_STORE_FILE: "/tmp/fde-rehearsal.json" }, true);
    expect(own.env.FDE_MEMORY_STORE_FILE).toBe("/tmp/fde-rehearsal.json");
    expect(infoOf(own, "存储")).not.toContain("彩排专用");
  });

  it("配了发信就不回显验证码;自己设了 FDE_DEV_LOGIN_CODES=1 照样提醒", () => {
    const smtp = checkIsolated({ ...KEYS, ADMIN_EMAILS: "a@x.com", SMTP_URL: "smtps://u:p@smtp.example.com" });
    expect(smtp.env.FDE_DEV_LOGIN_CODES).toBeUndefined();
    expect(infoOf(smtp, "登录")).toContain("发邮件");
    expect(smtp.warnings).toEqual([]);
    const both = check({ ...KEYS, ADMIN_EMAILS: "a@x.com", SMTP_URL: "smtps://x", FDE_DEV_LOGIN_CODES: "1" });
    expect(both.warnings.join("\n")).toContain("验证码显示在页面上");
  });

  it("自己设了 FDE_DEV_LOGIN_CODES=0 又没配发信:谁都登录不了,不替人改掉、直接不启动;设成空的才替它打开", () => {
    const off = check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_DEV_LOGIN_CODES: "0" });
    expect(off.errors).toEqual([expect.stringContaining("FDE_DEV_LOGIN_CODES=0,又没配 SMTP_URL")]);
    expect(off.env.FDE_DEV_LOGIN_CODES).toBeUndefined();
    expect(infoOf(off, "登录")).toContain("验证码不显示、也发不出去");
    const withSmtp = check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_DEV_LOGIN_CODES: "0", SMTP_URL: "smtps://x" });
    expect(withSmtp.errors).toEqual([]);
    expect(infoOf(withSmtp, "登录")).toContain("发邮件");
    const empty = check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_DEV_LOGIN_CODES: "" });
    expect(empty.errors).toEqual([]);
    expect(empty.env.FDE_DEV_LOGIN_CODES).toBe("1");
  });

  it("存储:和网页同一套约定;空的 FDE_MEMORY_STORE_FILE 会改用默认文件并提醒;FDE_ROOT 改默认位置", () => {
    const base = { ...KEYS, ADMIN_EMAILS: "a@x.com" };
    expect(check({ ...base, FDE_MEMORY_STORE_FILE: ".data/playtest.json" }).env.FDE_MEMORY_STORE_FILE).toBe(join(root, "apps/web/.data/playtest.json"));
    const empty = check({ ...base, FDE_MEMORY_STORE_FILE: "" });
    expect(empty.env.FDE_MEMORY_STORE_FILE).toBe(join(root, ".data/dev-store.json"));
    expect(empty.warnings.join("\n")).toContain("FDE_MEMORY_STORE_FILE 是空的");
    // FDE_ROOT 指到别处时,模型配置也从那里读(和网页一样),所以这里同时给一份绝对路径的配置
    const other = tmp();
    const moved = check({ ...base, FDE_ROOT: other, FDE_MODELS_CONFIG: join(root, "config/models.yaml") });
    expect(moved.env.FDE_MEMORY_STORE_FILE).toBe(join(other, ".data/dev-store.json"));
  });

  it("有 DATABASE_URL 不启动(试玩只用本机的内存库),不显示用户名和密码;传给网页的 DATABASE_URL 一律是空值", () => {
    const pg = check({ ...KEYS, ADMIN_EMAILS: "a@x.com", DATABASE_URL: "postgres://fde:secret@127.0.0.1:5432/fde" });
    expect(pg.errors).toEqual([expect.stringContaining("环境里有 DATABASE_URL(PostgreSQL 127.0.0.1:5432/fde)")]);
    expect(pg.errors[0]).toContain("DATABASE_URL= pnpm playtest");
    expect(pg.errors[0]).not.toContain("secret");
    expect(pg.env.DATABASE_URL).toBe("");
    // 空值(DATABASE_URL= pnpm playtest)按没设处理
    expect(check({ ...KEYS, ADMIN_EMAILS: "a@x.com", DATABASE_URL: "" }).errors).toEqual([]);
  });

  it("模型配置读不进来算错误;各环节换了 Key 变量名也照配置检查", () => {
    expect(check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_MODELS_CONFIG: join(tmp(), "nope.yaml") }).errors[0]).toContain("找不到模型配置");
    // 设成空的:网页会去读空路径,这里不替它补默认值
    expect(check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_MODELS_CONFIG: "" }).errors).toEqual([expect.stringContaining("FDE_MODELS_CONFIG 是空的")]);
    const dir = tmp();
    const text = TWO_VENDOR_YAML.replace("api_key_env: DEEPSEEK_API_KEY", "api_key_env: FDE_PLAYTEST_TEST_JUDGE_KEY");
    writeFileSync(join(dir, "models.yaml"), text);
    const cfg = loadModelsConfig(join(dir, "models.yaml"));
    expect(missingModelKeys(cfg, KEYS)).toEqual(["FDE_PLAYTEST_TEST_JUDGE_KEY(裁判 deepseek/deepseek-v4-pro)"]);
  });

  it("没设 FDE_MODELS_CONFIG 时和网页一样读 <FDE_ROOT>/config/models.yaml,不是仓库根目录的", () => {
    const other = tmp();
    mkdirSync(join(other, "config"));
    const text = TWO_VENDOR_YAML.replace("api_key_env: DEEPSEEK_API_KEY", "api_key_env: FDE_PLAYTEST_TEST_JUDGE_KEY");
    writeFileSync(join(other, "config/models.yaml"), text);
    const p = check({ ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_ROOT: other });
    expect(p.errors).toEqual([expect.stringContaining("缺少模型 Key:FDE_PLAYTEST_TEST_JUDGE_KEY")]);
  });

  it("apps/web 下有 .env*:next dev 也会读、检查却没看,提醒(只看文件在不在)", () => {
    const fake = tmp();
    mkdirSync(join(fake, "apps/web"), { recursive: true });
    expect(webEnvFiles(fake)).toEqual([]);
    const env = { ...KEYS, ADMIN_EMAILS: "a@x.com", FDE_MODELS_CONFIG: join(root, "config/models.yaml") };
    expect(preflight({ env, repoRoot: fake, offline: false }).warnings.join("\n")).not.toContain("apps/web 下有");
    writeFileSync(join(fake, "apps/web/.env.local"), "");
    writeFileSync(join(fake, "apps/web/.env"), "");
    expect(webEnvFiles(fake)).toEqual(["apps/web/.env.local", "apps/web/.env"]);
    const p = preflight({ env, repoRoot: fake, offline: false });
    expect(p.errors).toEqual([]);
    expect(p.warnings.join("\n")).toContain("apps/web 下有 apps/web/.env.local、apps/web/.env:next dev 也会读");
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
  // 用一份 Key 变量名独一无二的模型配置;preflight 读的变量都显式给出(没有的给空字符串,和没设一样),
  // 文件里的值不会覆盖已经设了的变量(空字符串也算设了)。再用 --dotenv 指一个空文件,仓库根目录的 .env 根本不读
  const SHIELD_KEYS = ["FDE_ENGINE_MODE", "DATABASE_URL", "FDE_PLAYTEST_TEST_BAILIAN_KEY", "FDE_PLAYTEST_TEST_DEEPSEEK_KEY", "ADMIN_EMAILS",
    "FDE_ROOT", "SMTP_URL", "FDE_DEV_LOGIN_CODES", "FDE_DAILY_SESSION_LIMIT"] as const;
  type RunOpts = { envFile?: string; shield?: boolean };
  const run = (args: string[], env: Record<string, string>, { envFile, shield = true }: RunOpts = {}) => {
    const dir = tmp();
    const text = TWO_VENDOR_YAML
      .replace("api_key_env: DASHSCOPE_API_KEY", "api_key_env: FDE_PLAYTEST_TEST_BAILIAN_KEY")
      .replace("api_key_env: DEEPSEEK_API_KEY", "api_key_env: FDE_PLAYTEST_TEST_DEEPSEEK_KEY");
    writeFileSync(join(dir, "models.yaml"), text);
    const pinned: Record<string, string> = {
      ...Object.fromEntries(SHIELD_KEYS.map((k) => [k, ""])),
      FDE_MODELS_CONFIG: join(dir, "models.yaml"),
      FDE_MEMORY_STORE_FILE: join(dir, "store.json"),
    };
    const r = spawnSync(tsx, [cli, ...args, "--dotenv", envFile ?? emptyEnvFile(dir)], {
      cwd: root,
      encoding: "utf8",
      env: cliEnv(shield ? { ...pinned, ...env } : env),
    });
    const out = `${r.stdout}${r.stderr}`;
    // 每次一个新的临时目录;比较两次运行的输出时把它换掉
    return { code: r.status, out, normalized: out.replaceAll(dir, "<tmp>"), store: join(dir, "store.json") };
  };

  it("--help、参数错误", () => {
    expect(run(["--help"], {}).code).toBe(0);
    const bad = run(["--port", "3001"], {});
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("参数错误");
    const noFile = run(["--dry-run"], {}, { envFile: join(tmp(), "nope.txt") });
    expect(noFile.code).toBe(2);
    expect(noFile.out).toContain("找不到 --dotenv 指定的文件");
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
    expect(ok.out).toContain("备注写编号(P1–P5)");
    expect(ok.out).toContain("试玩者在无痕窗口(或另一个浏览器用户)里打开 http://localhost:3000/login?invite=");

    const pg = run(["--dry-run"], {
      FDE_PLAYTEST_TEST_BAILIAN_KEY: "sk-a",
      FDE_PLAYTEST_TEST_DEEPSEEK_KEY: "sk-b",
      ADMIN_EMAILS: "me@example.com",
      DATABASE_URL: "postgres://fde:secret@127.0.0.1:5432/fde",
    });
    expect(pg.code).toBe(2);
    expect(pg.out).toContain("环境里有 DATABASE_URL");
    expect(pg.out).not.toContain("secret");
  }, 60_000);

  it("--dry-run --offline:彩排的库另用一个文件,导出命令带上 --store-file", () => {
    const r = run(["--dry-run", "--offline"], { ADMIN_EMAILS: "me@example.com" });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`内存库 ${r.store}`);
    expect(r.out).toContain(`pnpm session:export --list --store-file ${r.store}`);
    const dflt = run(["--dry-run", "--offline"], { ADMIN_EMAILS: "me@example.com", FDE_MEMORY_STORE_FILE: "" });
    expect(dflt.code).toBe(0);
    expect(dflt.out).toContain(join(root, ".data/playtest-rehearsal.json"));
    expect(dflt.out).toContain("--store-file");
    expect(dflt.out).toContain(".data/playtest-rehearsal.json(彩排的局不建标定用例)");
  }, 60_000);

  it("本机的 .env 改不了结果:拿一份\"毒\" .env 经 --dotenv 读进来,输出和读空文件一模一样;去掉显式给的变量才会被它带偏", () => {
    // 开发者 .env 里最可能有、又会改变结果的几样:Key、管理员、DATABASE_URL、FDE_ENGINE_MODE、FDE_ROOT、发信、验证码开关、局数
    const poison = join(tmp(), "poison-env.txt");
    const elsewhere = tmp();
    writeFileSync(
      poison,
      [
        "FDE_PLAYTEST_TEST_BAILIAN_KEY=sk-poison",
        "FDE_PLAYTEST_TEST_DEEPSEEK_KEY=sk-poison",
        "DASHSCOPE_API_KEY=sk-poison",
        "DEEPSEEK_API_KEY=sk-poison",
        "ADMIN_EMAILS=poison@example.com",
        "DATABASE_URL=postgres://fde:poison@127.0.0.1:5432/fde",
        "FDE_ENGINE_MODE=offline",
        `FDE_ROOT=${elsewhere}`,
        "SMTP_URL=smtps://poison:poison@smtp.example.com:465",
        "FDE_DEV_LOGIN_CODES=0",
        "FDE_DAILY_SESSION_LIMIT=99",
        "",
      ].join("\n"),
    );
    const cases: [string[], Record<string, string>][] = [
      [["--dry-run"], {}],
      [["--dry-run"], { FDE_PLAYTEST_TEST_BAILIAN_KEY: "sk-a", FDE_PLAYTEST_TEST_DEEPSEEK_KEY: "sk-b", ADMIN_EMAILS: "me@example.com" }],
      [["--dry-run", "--offline"], { ADMIN_EMAILS: "me@example.com" }],
    ];
    for (const [args, env] of cases) {
      const clean = run(args, env);
      const poisoned = run(args, env, { envFile: poison });
      expect(poisoned.code, args.join(" ")).toBe(clean.code);
      expect(poisoned.normalized).toBe(clean.normalized);
      expect(poisoned.out).not.toContain("poison");
    }
    // 对照:不显式给这些变量时,同一份文件确实会把结果带偏——上面的"一模一样"不是因为文件没被读
    const unshielded = run(["--dry-run"], {}, { envFile: poison, shield: false });
    expect(unshielded.code).toBe(2);
    expect(unshielded.out).toContain("FDE_ENGINE_MODE=offline");
    expect(unshielded.out).toContain("环境里有 DATABASE_URL");
    expect(unshielded.out).toContain("poison@example.com");
  }, 120_000);
});
