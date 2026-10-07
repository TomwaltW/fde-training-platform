// 命令行端到端:pnpm evals --live 和 pnpm evals:adversarial --live 接 127.0.0.1 上的假模型服务跑(不联网)。
// 门槛没过 → 退出码 1;全部通过 → 0;配置错误(缺 Key、门槛配置写错、对抗集名字写错)→ 2。
// 临时模型配置里 base_url 指向假服务、Key 变量名独一无二,所以本机以后有了 .env 也不会把真 Key 发出去。
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { loadPlayers } from "../src/players.ts";
import { fakeServer, labelsFrom, type FakeOptions } from "./fake-models.ts";

const root = resolve(import.meta.dirname, "../../..");
const tsx = join(root, "node_modules/.bin/tsx");
const evalsCli = join(root, "tools/evals/src/run.ts");
const advCli = join(root, "tools/evals/src/adversarial.ts");
const KEY = "FDE_EVALS_TEST_FAKE_KEY";
const players = loadPlayers(join(root, "scenarios/freight-docs/evals/players"));
const labels = labelsFrom(players.filter((p) => p.id === "EV_good" || p.id === "EV_rush").flatMap((p) => p.steps));

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "fde-live-cli-"));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** 仓库的模型配置,只把 base_url 换成假服务、Key 变量名换成测试专用的。 */
function modelsConfig(url: string, keyEnv = KEY): string {
  const cfg = parse(readFileSync(join(root, "config/models.yaml"), "utf8")) as { providers: Record<string, { base_url: string; api_key_env: string }> };
  for (const p of Object.values(cfg.providers)) {
    p.base_url = url;
    p.api_key_env = keyEnv;
  }
  const file = join(tmp(), "models.yaml");
  writeFileSync(file, stringify(cfg));
  return file;
}

async function run(cli: string, args: string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await promisify(execFile)(tsx, [cli, ...args], { cwd: root, env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, out: `${err.stdout}${err.stderr}` };
  }
}

async function withServer(opts: FakeOptions, fn: (env: Record<string, string>) => Promise<void>) {
  const srv = await fakeServer(opts);
  try {
    await fn({ FDE_MODELS_CONFIG: modelsConfig(srv.url), [KEY]: "test" });
    expect(srv.requests).toBeGreaterThan(0);
  } finally {
    await srv.close();
  }
}

const row = (out: string, name: string) => out.split("\n").find((l) => l.trimStart().startsWith(name)) ?? "";

describe("pnpm evals --live", () => {
  it("闸门按标准标注、演员只说允许的话:门槛全部通过,退出码 0", async () => {
    await withServer({ labels }, async (env) => {
      const r = await run(evalsCli, ["--live", "--player", "EV_good", "--player", "EV_rush"], env);
      expect(r.out).toContain("质量门槛(config/quality-gates.yaml,在线)");
      expect(row(r.out, "闸门命中率")).toContain("通过");
      expect(row(r.out, "区分度")).toContain("通过");
      expect(row(r.out, "单轮中位耗时")).toContain("通过");
      expect(row(r.out, "交付台词泄露候选")).toContain("通过");
      expect(r.out).toContain("结论:要判的门槛全部通过");
      expect(r.code).toBe(0);
    });
  }, 60_000);

  it("演员说守卫漏掉的口语泄露:泄露门槛未过,退出码 1(玩家断言照样通过)", async () => {
    await withServer({ labels, actor: () => "两成多吧,具体的你去问别人。" }, async (env) => {
      const r = await run(evalsCli, ["--live", "--player", "EV_rush"], env);
      expect(row(r.out, "脚本化玩家断言")).toContain("通过");
      expect(row(r.out, "交付台词泄露候选")).toContain("未过");
      expect(r.out).toMatch(/✗ 交付台词 N\d+\S+泄露候选「两成多」/);
      // 最后一行:玩家全过,但门槛没过,要写出来
      expect(r.out.trimEnd().split("\n").at(-1)).toMatch(/^1\/1 通过;门槛 1 项未过 · 明细:/);
      expect(r.code).toBe(1);
    });
  }, 60_000);

  it("演员慢、门槛配置用 --gates 换成 5 ms:耗时门槛未过,退出码 1", async () => {
    const gates = join(tmp(), "gates.yaml");
    writeFileSync(gates, readFileSync(join(root, "config/quality-gates.yaml"), "utf8").replace("turn_latency_p50_max_ms: 4000", "turn_latency_p50_max_ms: 5"));
    await withServer({ labels, delayMs: { actor: 30 } }, async (env) => {
      const r = await run(evalsCli, ["--live", "--player", "EV_rush", "--gates", gates], env);
      expect(row(r.out, "单轮中位耗时")).toContain("未过");
      expect(r.code).toBe(1);
    });
  }, 60_000);

  it("缺 Key、模型配置读不了、门槛配置写错:退出码 2,说清楚原因", async () => {
    const noKey = await run(evalsCli, ["--live", "--player", "EV_rush"], { FDE_MODELS_CONFIG: modelsConfig("http://127.0.0.1:9/v1", "FDE_EVALS_TEST_NO_SUCH_KEY") });
    expect(noKey.code).toBe(2);
    expect(noKey.out).toContain("缺少环境变量 FDE_EVALS_TEST_NO_SUCH_KEY");

    const noModels = await run(evalsCli, ["--live", "--player", "EV_rush"], { FDE_MODELS_CONFIG: join(tmp(), "no-such-models.yaml") });
    expect(noModels.code).toBe(2);
    expect(noModels.out).toContain("无法用 --live:找不到模型配置");

    const bad = join(tmp(), "gates.yaml");
    writeFileSync(bad, readFileSync(join(root, "config/quality-gates.yaml"), "utf8").replace("gate_recall_min: 0.85", "gate_recall_min: 85"));
    const badGates = await run(evalsCli, ["--player", "EV_rush", "--gates", bad], {});
    expect(badGates.code).toBe(2);
    expect(badGates.out).toContain("0.85 而不是 85");
  }, 60_000);
});

describe("pnpm evals:adversarial", () => {
  it("--live,演员只说允许的话:退出码 0;演员泄露:退出码 1", async () => {
    await withServer({}, async (env) => {
      const r = await run(advCli, ["--live", "--suite", "leak"], env);
      expect(row(r.out, "探测轮数(leak)")).toContain("通过");
      expect(row(r.out, "守卫拦截率")).toContain("参考");
      expect(r.code).toBe(0);
    });
    await withServer({ actor: () => "上千条总有的,别的我不清楚。" }, async (env) => {
      const r = await run(advCli, ["--live", "--suite", "numbers"], env);
      expect(row(r.out, "交付台词泄露候选(numbers)")).toContain("未过");
      expect(r.code).toBe(1);
    });
  }, 60_000);

  it("离线默认通过;对抗集名字写错、缺 Key:退出码 2", async () => {
    const offline = await run(advCli, ["--suite", "leak"], {});
    expect(offline.code).toBe(0);
    expect(offline.out).toContain("质量门槛 · 对抗集(config/quality-gates.yaml,离线)");

    const nope = await run(advCli, ["--suite", "nope"], {});
    expect(nope.code).toBe(2);
    expect(nope.out).toContain("没有对抗集 nope(现有:leak、numbers)");

    const noKey = await run(advCli, ["--live"], { FDE_MODELS_CONFIG: modelsConfig("http://127.0.0.1:9/v1", "FDE_EVALS_TEST_NO_SUCH_KEY") });
    expect(noKey.code).toBe(2);
    expect(noKey.out).toContain("缺少环境变量 FDE_EVALS_TEST_NO_SUCH_KEY");
  }, 60_000);
});
