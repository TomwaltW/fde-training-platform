// 模型预检(pnpm models:check):本地起一个 OpenAI 兼容的假服务(只绑 127.0.0.1,不出网),
// 覆盖成功、JSON 环节回了非 JSON(含 ```json 围栏)、401、超时、连不上 / 回网页 / Key 有非法字符、缺 Key、缺价格、
// 回显的 Key 跨在截断处(回复预览 80 字、网关报错正文 300 字)也抹干净、百炼快照没固定的警告和 --strict、
// DeepSeek 那条只是提示(--strict 也不算);
// 退出码 0 / 1 / 2 用子进程跑命令行验证。
// 测试配置里的 Key 变量名故意不用 DASHSCOPE_API_KEY / DEEPSEEK_API_KEY:作者机器上有真 .env 时也碰不到真 Key。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { z } from "zod";
import {
  isSnapshotName,
  KEY_FRAGMENT_MIN,
  loadModelsConfig,
  ModelsConfigSchema,
  preflightExitCode,
  renderPreflight,
  runPreflight,
  STAGES,
  staticFindings,
  type ModelsConfig,
  type PreflightReport,
} from "../src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
const cli = join(root, "apps/cli/src/models-check.ts");
const tsx = join(root, "node_modules/.bin/tsx");

const B_ENV = "FDE_TEST_PREFLIGHT_BAILIAN_KEY";
const D_ENV = "FDE_TEST_PREFLIGHT_DEEPSEEK_KEY";
const B_KEY = "sk-test-bailian-0123456789abcdef";
const D_KEY = "sk-test-deepseek-fedcba9876543210";
const keys = { [B_ENV]: B_KEY, [D_ENV]: D_KEY };

// ---------- 假的 OpenAI 兼容服务:按请求体里的 model 决定怎么回

type Behavior = { content: string; usage?: Record<string, number> } | { status: number; body: string; type?: string } | "hang";
interface Seen {
  path: string;
  auth: string;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
const behaviors = new Map<string, Behavior>();
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? "", body });
      const b = behaviors.get(String(body.model)) ?? { content: body.response_format ? '{"ok": true}' : "收到" };
      if (b === "hang") return; // 不回,等客户端超时
      // connection: close —— 每次请求用新连接、回完就关:测试进程里 fetch(undici)的连接池不留空闲连接,
      // 下一个用例不会拿到一条已经被关掉的旧连接(那样第一个 POST 会 ECONNRESET,被网关报成「网络错误」)
      if ("status" in b) {
        res.writeHead(b.status, { "content-type": b.type ?? "application/json", connection: "close" }).end(b.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", connection: "close" }).end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: b.content }, finish_reason: "stop" }],
          usage: b.usage ?? { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const tmps: string[] = [];
afterEach(() => {
  seen.length = 0;
  behaviors.clear();
  // 不在这里 closeAllConnections:用例之间关连接正是并发跑时偶发 fetch failed 的来源。
  // 超时用例里挂着的那条请求,客户端超时中止时就断开了;剩下的由 afterAll 收拾(和 apps/web/test 的假服务一样)
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

// ---------- 测试用配置:默认四个百炼模型都钉了快照(假名字),裁判走 DeepSeek

const M = { gate: "qwen-t-flash-2000-01-01", actor: "qwen-t-plus-2000-01-01", judge: "ds-t-pro", debrief: "qwen-t-max-2000-01-01" };

/** 校验前的配置对象(和 config/models.yaml 读进来的形状一样),用例在它上面改 */
type CfgIn = z.input<typeof ModelsConfigSchema>;
type CfgEdit = (c: CfgIn) => void;

function cfgObj(edit: CfgEdit = () => {}): CfgIn {
  const c: CfgIn = {
    providers: {
      bailian: { base_url: `${base}/compatible-mode/v1`, api_key_env: B_ENV },
      deepseek: { base_url: base, api_key_env: D_ENV },
    },
    stages: {
      gate: { provider: "bailian", model: M.gate, temperature: 0, max_tokens: 600, json: true, extra: { enable_thinking: false } },
      actor: { provider: "bailian", model: M.actor, temperature: 0.8, max_tokens: 300, extra: { enable_thinking: false } },
      judge: { provider: "deepseek", model: M.judge, temperature: 0, max_tokens: 8000, json: true, timeout_ms: 120000 },
      debrief: { provider: "bailian", model: M.debrief, temperature: 0.5, max_tokens: 2000, extra: { enable_thinking: false } },
    },
    prices: { [M.gate]: [0.2, 0.8], [M.actor]: [0.8, 2], [M.judge]: [9, 27], [M.debrief]: [2, 8] },
  };
  edit(c);
  return c;
}
const cfg = (edit?: CfgEdit): ModelsConfig => ModelsConfigSchema.parse(cfgObj(edit));
/** 没有任何警告、提示的配置:裁判也换成钉了快照的百炼模型 */
const cleanEdit: CfgEdit = (c) => {
  c.stages.judge = { ...c.stages.judge, provider: "bailian", model: "qwen-t-judge-2000-01-01" };
  c.prices["qwen-t-judge-2000-01-01"] = [2.5, 10];
};
function cfgFile(edit?: CfgEdit): string {
  const d = mkdtempSync(join(tmpdir(), "fde-preflight-"));
  tmps.push(d);
  const f = join(d, "models.yaml");
  writeFileSync(f, stringify(cfgObj(edit)));
  return f;
}

const text = (lines: string[]) => lines.join("\n");

describe("在线检查(假服务)", () => {
  it("成功:每个环节按自己的参数发一次最小请求,JSON 环节解析成对象,报告耗时、token 和花费", async () => {
    const r = await runPreflight(cfg(), { env: keys, network: true });
    expect(r.probes.map((p) => [p.stage, p.ok])).toEqual([
      ["gate", true],
      ["actor", true],
      ["judge", true],
      ["debrief", true],
    ]);
    expect(seen).toHaveLength(4);
    const [gate, actor, judge] = seen;
    // 闸门:百炼路径、带 Key、温度 0、关思考、json 模式;max_tokens 压到 64
    expect(gate!.path).toBe("/compatible-mode/v1/chat/completions");
    expect(gate!.auth).toBe(`Bearer ${B_KEY}`);
    expect(gate!.body).toMatchObject({ model: M.gate, temperature: 0, max_tokens: 64, stream: false, enable_thinking: false, response_format: { type: "json_object" } });
    // json 模式要求消息里出现 JSON 字样
    expect(JSON.stringify(gate!.body.messages)).toContain("JSON");
    // 演员:文本环节不带 response_format
    expect(actor!.body).toMatchObject({ model: M.actor, temperature: 0.8, max_tokens: 64, enable_thinking: false });
    expect(actor!.body.response_format).toBeUndefined();
    // 裁判:DeepSeek 路径和 Key;没关思考,给 1024
    expect(judge!.path).toBe("/chat/completions");
    expect(judge!.auth).toBe(`Bearer ${D_KEY}`);
    expect(judge!.body).toMatchObject({ model: M.judge, max_tokens: 1024, response_format: { type: "json_object" } });
    expect(judge!.body.enable_thinking).toBeUndefined();

    // 网关记的那一行:token、花费、尝试次数
    const g = r.probes[0]!.log!;
    expect(g).toMatchObject({ stage: "gate", model: M.gate, tokensIn: 40, tokensOut: 5, attempts: 1, ok: true, sessionId: "models-check" });
    expect(g.costYuan).toBeCloseTo((40 * 0.2 + 5 * 0.8) / 1e6);

    // 只有 DeepSeek 那条提示:不算警告,加不加 --strict 都通过(没有快照可钉,对策只有上游一变就重跑回归)
    expect(r.findings.map((f) => [f.level, f.stages])).toEqual([["note", ["judge"]]]);
    expect(r.findings[0]!.message).toMatch(/DeepSeek 没有带日期的快照.*pnpm evals --live 和 pnpm calibrate --live/);
    expect(preflightExitCode(r, false)).toBe(0);
    expect(preflightExitCode(r, true)).toBe(0);

    const out = text(renderPreflight(r));
    expect(out).toMatch(/✓ gate\s+bailian\/qwen-t-flash-2000-01-01\s+FDE_TEST_PREFLIGHT_BAILIAN_KEY 已配置\s+JSON 对象回复 ✓/);
    expect(out).toMatch(/耗时 \d+ ms · 输入 40 \/ 输出 5 \/ 缓存 0 token · ¥0\.000012 · 尝试 1 次/);
    expect(out).toContain("本次预检发了 4 次请求");
    expect(out).toMatch(/\n {2}i judge 用的 deepseek\/ds-t-pro:DeepSeek 没有带日期的快照/);
    expect(out).toContain("结论:全部通过(另有 1 条提示,不算警告,--strict 下也通过)");
    expect(text(renderPreflight(r, { strict: true }))).toContain("结论:全部通过(另有 1 条提示");
    expect(out).not.toContain(B_KEY);
    expect(out).not.toContain(D_KEY);
  });

  it("JSON 环节回了非 JSON:该环节失败并给出回复开头;文本环节不受影响", async () => {
    behaviors.set(M.gate, { content: "好的,结果如下:ok" });
    behaviors.set(M.judge, { content: "[1, 2]" });
    behaviors.set(M.actor, { content: "这不是 JSON 也没关系" });
    const r = await runPreflight(cfg(), { env: keys, network: true });
    const [gate, actor, judge] = r.probes;
    expect(gate!.ok).toBe(false);
    expect(gate!.error).toBe("回复不是合法 JSON(json 模式可能没生效):好的,结果如下:ok");
    expect(judge!.ok).toBe(false);
    expect(judge!.error).toMatch(/回复是 JSON,但不是对象/);
    expect(actor!.ok).toBe(true);
    expect(preflightExitCode(r, false)).toBe(1);
    expect(text(renderPreflight(r))).toMatch(/结论:2 项没过 → 不通过/);
  });

  it("JSON 包了 ```json 围栏:预检照样判失败(比线上的 extractJson 严),但点明线上能容忍、是 json 模式没生效", async () => {
    behaviors.set(M.gate, { content: '```json\n{"ok": true}\n```' });
    behaviors.set(M.judge, { content: '结果:{"ok": true}' });
    const r = await runPreflight(cfg(), { env: keys, network: true, stages: ["gate", "judge"] });
    for (const p of r.probes) {
      expect(p.ok).toBe(false);
      expect(p.error).toMatch(/^回复不是纯 JSON\(包了 ```json 围栏或夹了别的文字;线上的解析能容忍,但说明 json 模式没生效\):/);
    }
  });

  it("没关思考的环节回复为空:提示思考可能用完了 max_tokens", async () => {
    behaviors.set(M.judge, { content: "" });
    const r = await runPreflight(cfg(), { env: keys, network: true, stages: ["judge"] });
    expect(r.probes[0]).toMatchObject({ ok: false, error: "回复为空;这个环节没关思考,思考过程可能把 max_tokens(1024)用完了" });
  });

  it("HTTP 401:该环节失败,提示检查哪个 Key,不重试;供应商回显的 Key 原文被抹掉", async () => {
    behaviors.set(M.actor, { status: 401, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${B_KEY}` } }) });
    const r = await runPreflight(cfg(), { env: keys, network: true, stages: ["actor"] });
    expect(seen).toHaveLength(1);
    const p = r.probes[0]!;
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/^bailian 401: .*Incorrect API key provided: \*\*\*.* —— Key 无效、过期,或没有这个模型的权限\(检查 FDE_TEST_PREFLIGHT_BAILIAN_KEY\)$/);
    expect(p.log).toMatchObject({ ok: false, attempts: 1 });
    const out = text(renderPreflight(r, { verbose: true }));
    expect(out).toContain("失败,不计费");
    expect(out).not.toContain(B_KEY);
    expect(JSON.stringify(r)).not.toContain(B_KEY);
  });

  it("回复里回显的 Key 跨在预览的 80 字截断处:先整段抹再截,截断处不留 Key 的前半截", async () => {
    const content = `${"甲".repeat(70)}${B_KEY}${"乙".repeat(30)}`;
    // 前提:先截后抹的话,80 字的截断正好切在 Key 中间
    expect(content.indexOf(B_KEY)).toBeLessThan(80);
    expect(content.indexOf(B_KEY) + B_KEY.length).toBeGreaterThan(80);
    behaviors.set(M.actor, { content });
    const r = await runPreflight(cfg(), { env: keys, network: true, stages: ["actor"] });
    const p = r.probes[0]!;
    expect(p.ok).toBe(true);
    expect(p.reply).toBe(`${"甲".repeat(70)}***${"乙".repeat(7)}…`);
    const frag = B_KEY.slice(0, KEY_FRAGMENT_MIN);
    expect(JSON.stringify(r)).not.toContain(frag);
    const out = text(renderPreflight(r, { verbose: true }));
    expect(out).toContain(`回复:${p.reply}`);
    expect(out).not.toContain(frag);
  });

  it("截断处残留的 Key 片段(≥ 8 个字符)也抹:半截 Key 跨在预览截断处、回复被 max_tokens 截在 Key 中间、开头是 Key 的后半截", async () => {
    const half = B_KEY.slice(0, 20);
    // 回复里只有半截 Key,整段匹配认不出;预览截到 80 字后剩 10 个字符的前缀
    behaviors.set(M.actor, { content: `${"甲".repeat(70)}${half} 后面还有字` });
    // 回复本身就停在 Key 中间(max_tokens 用完),后面跟着换行
    behaviors.set(M.debrief, { content: `Key 是 ${half}\n` });
    const r = await runPreflight(cfg(), { env: keys, network: true, stages: ["actor", "debrief"] });
    expect(r.probes.map((p) => p.reply)).toEqual([`${"甲".repeat(70)}***…`, "Key 是 ***"]);
    expect(JSON.stringify(r)).not.toContain(B_KEY.slice(0, KEY_FRAGMENT_MIN));

    behaviors.set(M.actor, { content: `${B_KEY.slice(-12)} 是后半截` });
    const tail = await runPreflight(cfg(), { env: keys, network: true, stages: ["actor"] });
    expect(tail.probes[0]!.reply).toBe("*** 是后半截");

    // 不到 8 个字符的不抹(拼不回 Key,也免得误伤普通文字)
    behaviors.set(M.actor, { content: `前缀是 ${B_KEY.slice(0, KEY_FRAGMENT_MIN - 1)}` });
    const short = await runPreflight(cfg(), { env: keys, network: true, stages: ["actor"] });
    expect(short.probes[0]!.reply).toBe(`前缀是 ${B_KEY.slice(0, KEY_FRAGMENT_MIN - 1)}`);
  });

  it("401 的报错正文被网关截到 300 字、回显的 Key 跨在截断处:报错原文先抹再接说明,日志里也不留残片", async () => {
    const head = '{"error":{"message":"Incorrect API key provided: ';
    const body = `${head}${"x".repeat(290 - head.length)}${B_KEY}"}}`;
    // 前提:网关的 slice(0, 300)(packages/llm/src/gateway.ts)正好切在 Key 中间
    expect(body.indexOf(B_KEY)).toBe(290);
    expect(body.indexOf(B_KEY) + B_KEY.length).toBeGreaterThan(300);
    behaviors.set(M.actor, { status: 401, body });
    const r = await runPreflight(cfg(), { env: keys, network: true, stages: ["actor"] });
    const p = r.probes[0]!;
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/^bailian 401: .*x\*\*\* —— Key 无效、过期,或没有这个模型的权限\(检查 FDE_TEST_PREFLIGHT_BAILIAN_KEY\)$/);
    expect(p.log!.error).toMatch(/x\*\*\*$/);
    const frag = B_KEY.slice(0, KEY_FRAGMENT_MIN);
    expect(JSON.stringify(r)).not.toContain(frag);
    expect(text(renderPreflight(r, { verbose: true }))).not.toContain(frag);
  });

  it("超时:按环节的 timeout_ms 判失败,不重试", async () => {
    behaviors.set(M.gate, "hang");
    const started = Date.now();
    const r = await runPreflight(
      cfg((c) => (c.stages.gate.timeout_ms = 300)),
      { env: keys, network: true, stages: ["gate"] },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(seen).toHaveLength(1);
    expect(r.probes[0]).toMatchObject({ ok: false, error: "bailian 超时:300 ms 内没有返回(预检不重试)" });
    expect(r.probes[0]!.log).toMatchObject({ ok: false, attempts: 1 });
  });

  it("连不上 base_url:该环节失败,点出连的是哪个地址", async () => {
    // 先占一个端口再关掉,保证这个端口上没人监听
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const dead = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    await new Promise<void>((r) => probe.close(() => r()));
    const r = await runPreflight(
      cfg((c) => (c.providers.bailian!.base_url = dead)),
      { env: keys, network: true, stages: ["actor"] },
    );
    expect(r.probes[0]!.ok).toBe(false);
    expect(r.probes[0]!.error).toMatch(new RegExp(`^bailian 网络错误:.* —— 连不上 ${dead.replace(/\./g, "\\.")},检查网络和 base_url$`));
  });

  it("连上了但回的不是 JSON(网页、登录页、代理):说返回的不是 JSON,不说连不上", async () => {
    behaviors.set(M.actor, { status: 200, type: "text/html", body: "<html>login</html>" });
    const r = await runPreflight(cfg(), { env: keys, network: true, stages: ["actor"] });
    expect(seen).toHaveLength(1);
    const err = r.probes[0]!.error!;
    expect(err).toMatch(/^bailian 网络错误:.*is not valid JSON —— 连上了,但返回的不是 JSON:http:\/\/127\.0\.0\.1:\d+\/compatible-mode\/v1 可能指向了网页、登录页或代理$/);
    expect(err).not.toContain("连不上");
  });

  it("Key 里混了全角字符或换行:请求发不出去,提示检查哪个变量,Key 原文不出现", async () => {
    for (const bad of ["sk-test-全角ｋｅｙ-0123456789", "sk-test-abc\ndef-0123456789"]) {
      const r = await runPreflight(cfg(), { env: { [B_ENV]: bad }, network: true, stages: ["actor"] });
      const p = r.probes[0]!;
      expect(p.ok).toBe(false);
      expect(p.error).toMatch(/ —— Key 里有非法字符\(检查 FDE_TEST_PREFLIGHT_BAILIAN_KEY 是否混入全角字符、换行\)$/);
      expect(p.error).not.toContain("连不上");
      // 换行那种,fetch 的报错会把整个请求头(含 Key)带出来:要被抹掉
      expect(JSON.stringify(r)).not.toContain(JSON.stringify(bad).slice(1, -1));
      expect(text(renderPreflight(r, { verbose: true }))).not.toContain(bad);
    }
    expect(seen).toHaveLength(0);
  });

  it("缺 Key(没有或只有空白):该环节失败并点名环境变量,不发请求", async () => {
    const r = await runPreflight(cfg(), { env: { [B_ENV]: B_KEY, [D_ENV]: "   " }, network: true });
    const judge = r.probes.find((p) => p.stage === "judge")!;
    expect(judge).toMatchObject({ ok: false, keyPresent: false });
    expect(judge.error).toMatch(/^缺少环境变量 FDE_TEST_PREFLIGHT_DEEPSEEK_KEY\(judge 环节用 deepseek 的 ds-t-pro\)/);
    expect(seen.map((s) => s.body.model)).not.toContain(M.judge);
    expect(r.probes.filter((p) => p.ok).map((p) => p.stage)).toEqual(["gate", "actor", "debrief"]);
    expect(preflightExitCode(r, false)).toBe(1);
    expect(text(renderPreflight(r))).toMatch(/✗ judge\s+deepseek\/ds-t-pro\s+FDE_TEST_PREFLIGHT_DEEPSEEK_KEY 缺失/);
  });

  it("--no-network:不发请求,Key 只列出有没有,不计入结论", async () => {
    const r = await runPreflight(cfg(cleanEdit), { env: {}, network: false });
    expect(seen).toHaveLength(0);
    expect(r.probes.every((p) => p.ok === undefined && !p.keyPresent)).toBe(true);
    expect(preflightExitCode(r, true)).toBe(0);
    const out = text(renderPreflight(r));
    expect(out).toContain("在线检查:跳过(--no-network)");
    expect(out).toContain("结论(只做了静态检查):全部通过");
  });
});

describe("静态检查", () => {
  it("缺价格:失败,并说明网关会把花费记成 null;在线检查的花费显示未登记", async () => {
    const r = await runPreflight(
      cfg((c) => delete c.prices[M.actor]),
      { env: keys, network: true },
    );
    const fails = r.findings.filter((f) => f.level === "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]!.stages).toEqual(["actor"]);
    expect(fails[0]!.message).toMatch(/qwen-t-plus-2000-01-01 在 prices 里没有登记价格:网关会把花费记成 null/);
    // 网关的实际行为:花费是 null,不是 0
    expect(r.probes.find((p) => p.stage === "actor")!.log!.costYuan).toBeNull();
    expect(preflightExitCode(r, false)).toBe(1);
    const out = text(renderPreflight(r));
    expect(out).toContain("未登记价格(网关记为 null)");
    expect(out).toContain("另有 1 次的模型没登记价格,没算进去");
  });

  it("快照没固定:百炼模型名不带日期时警告,--strict 下算失败;几个环节共用一个模型只报一次", () => {
    const clean = staticFindings(cfg(cleanEdit));
    expect(clean).toEqual([]);

    const loose = cfg((c) => {
      cleanEdit(c);
      c.stages.actor.model = "qwen-t-plus";
      c.stages.debrief.model = "qwen-t-plus";
      c.stages.gate.model = "qwen-t-flash-latest";
      c.prices["qwen-t-plus"] = [0.8, 2];
      c.prices["qwen-t-flash-latest"] = [0.2, 0.8];
    });
    const f = staticFindings(loose);
    expect(f.map((x) => [x.level, x.stages])).toEqual([
      ["warn", ["gate"]],
      ["warn", ["actor", "debrief"]],
    ]);
    expect(f[1]!.message).toContain("actor、debrief 用的 bailian/qwen-t-plus 不是带日期的快照名(形如 qwen-t-plus-YYYY-MM-DD)");
    const report: PreflightReport = { stages: [...STAGES], network: false, findings: f, probes: [] };
    expect(preflightExitCode(report, false)).toBe(0);
    expect(preflightExitCode(report, true)).toBe(1);
    expect(text(renderPreflight(report, { strict: true }))).toContain("--strict 下警告也算失败 → 不通过");
  });

  it("--stage 只查选中的环节:没选中的环节既不发请求也不做静态检查", async () => {
    const r = await runPreflight(
      cfg((c) => delete c.prices[M.debrief]),
      { env: keys, network: true, stages: ["actor"] },
    );
    expect(r.stages).toEqual(["actor"]);
    expect(seen.map((s) => s.body.model)).toEqual([M.actor]);
    expect(r.findings).toEqual([]);
  });

  it("快照名的认法:-YYYY-MM-DD 或早期的 -MMDD;稳定版、-latest 不算", () => {
    expect(isSnapshotName("qwen-t-2000-01-01")).toBe(true);
    expect(isSnapshotName("qwen-t-0101")).toBe(true);
    expect(isSnapshotName("qwen-t")).toBe(false);
    expect(isSnapshotName("qwen-t-latest")).toBe(false);
    expect(isSnapshotName("qwen3.7-flash")).toBe(false);
    expect(isSnapshotName("qwen-t-1399")).toBe(false);
    expect(isSnapshotName("qwen-t-2000-13-01")).toBe(false);
  });

  it("仓库里的 config/models.yaml:每个模型都登记了价格(换成快照名时忘了补价格会在这里失败)", () => {
    const real = loadModelsConfig(join(root, "config/models.yaml"));
    expect(staticFindings(real).filter((f) => f.level === "fail")).toEqual([]);
  });
});

describe("命令行 pnpm models:check(子进程)", () => {
  // 假服务和测试在同一个进程里:子进程必须异步跑,不能用 execFileSync 把事件循环卡住
  function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
    return new Promise((res, rej) => {
      const child = spawn(tsx, [cli, ...args], { cwd: root, env: { ...process.env, ...env } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", rej);
      child.on("close", (code) => res({ code: code ?? -1, out }));
    });
  }

  it("全部通过:退出码 0,--strict 也是 0", async () => {
    const f = cfgFile(cleanEdit);
    const a = await runCli([], { FDE_MODELS_CONFIG: f, ...keys });
    expect(a.out).toContain("结论:全部通过");
    expect(a.code).toBe(0);
    expect(seen).toHaveLength(4);
    expect((await runCli(["--strict"], { FDE_MODELS_CONFIG: f, ...keys })).code).toBe(0);
    expect(a.out).not.toContain(B_KEY);
  });

  it("只有警告(快照没固定):退出码 0;--strict 下 1", async () => {
    const f = cfgFile((c) => {
      cleanEdit(c);
      c.stages.actor.model = "qwen-t-plus";
      c.prices["qwen-t-plus"] = [0.8, 2];
    });
    const a = await runCli(["--stage", "actor"], { FDE_MODELS_CONFIG: f, ...keys });
    expect(a.out).toMatch(/! actor 用的 bailian\/qwen-t-plus 不是带日期的快照名/);
    expect(a.code).toBe(0);
    expect(seen.map((s) => s.body.model)).toEqual(["qwen-t-plus"]);
    const s = await runCli(["--stage", "actor", "--strict"], { FDE_MODELS_CONFIG: f, ...keys });
    expect(s.code).toBe(1);
  });

  it("裁判在 DeepSeek 上:那条只是提示,--strict 也是 0;同时有百炼快照没固定时,--strict 只按警告算、照样 1", async () => {
    const a = await runCli(["--strict"], { FDE_MODELS_CONFIG: cfgFile(), ...keys });
    expect(a.out).toMatch(/ {2}i judge 用的 deepseek\/ds-t-pro:DeepSeek 没有带日期的快照/);
    expect(a.out).toContain("结论:全部通过(另有 1 条提示,不算警告,--strict 下也通过)");
    expect(a.code).toBe(0);
    expect(seen).toHaveLength(4);

    const f = cfgFile((c) => {
      c.stages.actor.model = "qwen-t-plus";
      c.prices["qwen-t-plus"] = [0.8, 2];
    });
    const s = await runCli(["--stage", "actor", "--stage", "judge", "--strict"], { FDE_MODELS_CONFIG: f, ...keys });
    expect(s.out).toContain("检查都过了,但有 1 条警告;--strict 下警告也算失败 → 不通过");
    expect(s.code).toBe(1);
  });

  it("检查没过(缺 Key):退出码 1,点名环境变量", async () => {
    const f = cfgFile(cleanEdit);
    const a = await runCli(["--stage", "gate"], { FDE_MODELS_CONFIG: f, [B_ENV]: "" });
    expect(a.code).toBe(1);
    expect(a.out).toContain(`缺少环境变量 ${B_ENV}`);
    expect(seen).toHaveLength(0);
  });

  it("参数或配置错误:退出码 2(未知环节、未知参数、配置文件不存在、配置不合法)", async () => {
    const f = cfgFile(cleanEdit);
    const unknownStage = await runCli(["--stage", "boss"], { FDE_MODELS_CONFIG: f, ...keys });
    expect(unknownStage.code).toBe(2);
    expect(unknownStage.out).toContain("未知环节 boss");
    const unknownFlag = await runCli(["--bogus"], { FDE_MODELS_CONFIG: f, ...keys });
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.out).toContain("参数错误");
    const missing = await runCli([], { FDE_MODELS_CONFIG: join(tmpdir(), "fde-preflight-no-such-file.yaml"), ...keys });
    expect(missing.code).toBe(2);
    expect(missing.out).toContain("找不到模型配置");
    const bad = cfgFile((c) => delete (c.stages as Partial<CfgIn["stages"]>).judge);
    const invalid = await runCli([], { FDE_MODELS_CONFIG: bad, ...keys });
    expect(invalid.code).toBe(2);
    expect(invalid.out).toContain("模型配置有误");
    expect(seen).toHaveLength(0);
  });

  it("仓库里的配置 --no-network:不发请求,退出码 0", async () => {
    // 只断言不随配置变化的部分:作者按 docs/models.md 钉了快照之后这条也不该变红(警告文字由上面的临时配置覆盖)
    const a = await runCli(["--no-network"], { FDE_MODELS_CONFIG: join(root, "config/models.yaml") });
    expect(a.code).toBe(0);
    expect(a.out).toContain("在线检查:跳过(--no-network)");
    expect(a.out).toContain("结论(只做了静态检查)");
    // 跑测试的 shell 里 export 了真 Key 时,Key 的值也不能出现在输出里。只写在 .env 里的 Key 是子进程自己读的,
    // 这里查不到(测试不读 .env);那种情况靠渲染只打印「已配置 / 缺失」来保证
    for (const v of [process.env.DASHSCOPE_API_KEY, process.env.DEEPSEEK_API_KEY]) if (v?.trim()) expect(a.out).not.toContain(v.trim());
  });
});
