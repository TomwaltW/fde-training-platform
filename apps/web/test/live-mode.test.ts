// live 模式的接线测试:不连真模型(fetch 被替换成假的),只验证引擎用的是模型端口、
// 每次模型调用都写进 llm_calls(带 sessionId 和花费),管理页能看到。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminSessionDetail, AdminStats, CreateSessionResponse, FinishResponse, TurnResponse } from "@fde/contracts";
import * as adminSession from "../app/api/admin/sessions/[id]/route.ts";
import * as adminStats from "../app/api/admin/stats/route.ts";
import * as consent from "../app/api/me/consent/route.ts";
import * as finish from "../app/api/sessions/[id]/finish/route.ts";
import * as turns from "../app/api/sessions/[id]/turns/route.ts";
import * as sessions from "../app/api/sessions/route.ts";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import { resetForTests } from "../lib/server/runtime.ts";
import { Client } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const ENV_KEYS = ["FDE_ROOT", "FDE_ENGINE_MODE", "FDE_DEV_LOGIN_CODES", "FDE_MEMORY_STORE_FILE", "ADMIN_EMAILS", "DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY", "DATABASE_URL", "FDE_MODELS_CONFIG"] as const;
const saved: Record<string, string | undefined> = {};

/**
 * 测试自带一份两家供应商、每个环节模型名都不同的配置(FDE_MODELS_CONFIG),不随仓库的 config/models.yaml 变:
 * 这里测的是接线(按环节选供应商、带 Key、写调用日志),不是线上选了哪家。
 */
const MODELS_YAML = `
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

/** 按模型返回固定内容,模拟 OpenAI 兼容的 /chat/completions。 */
const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { model: string };
  const content: Record<string, string> = {
    "qwen3.7-flash": JSON.stringify({ acts: ["ask"], summary: "问好" }),
    "qwen-plus": "你先说说,你是来干嘛的?",
    "deepseek-v4-pro": "{}",
    "qwen3.7-plus": "## 结论\n这是测试用的复盘。",
  };
  return Response.json({
    choices: [{ message: { content: content[body.model] ?? "嗯。" } }],
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
  });
});

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "fde-web-live-"));
  writeFileSync(join(dir, "models.yaml"), MODELS_YAML);
  Object.assign(process.env, {
    FDE_ROOT: ROOT,
    FDE_MODELS_CONFIG: join(dir, "models.yaml"),
    FDE_ENGINE_MODE: "live",
    FDE_DEV_LOGIN_CODES: "1",
    FDE_MEMORY_STORE_FILE: join(dir, "store.json"),
    ADMIN_EMAILS: "admin@example.com",
    DASHSCOPE_API_KEY: "test-dashscope-key",
    DEEPSEEK_API_KEY: "test-deepseek-key",
  });
  vi.stubGlobal("fetch", fakeFetch);
  await resetForTests();
});

afterAll(async () => {
  await resetForTests();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("live 模式(假模型)", () => {
  it("对局走模型端口,调用记录写进 llm_calls 并计入花费", async () => {
    const c = new Client();
    const code = await c.post<{ devCode: string }>(requestCode.POST, { body: { email: "admin@example.com" } });
    await c.post(verify.POST, { body: { email: "admin@example.com", code: code.body.devCode } });
    await c.post(consent.POST);
    const created = await c.post<CreateSessionResponse>(sessions.POST, { body: { scenarioId: "freight-docs" } });
    expect(created.status).toBe(201);
    const id = created.body.sessionId;

    const t = await c.post<TurnResponse>(turns.POST, { params: { id }, body: { text: "周总您好,最近出过什么事吗?" } });
    expect(t.status).toBe(200);
    expect(t.body.result.reply?.text).toBeTruthy();
    const f = await c.post<FinishResponse>(finish.POST, { params: { id } });
    expect(f.status).toBe(200);

    // 请求发到了配置里的供应商,带上了 Key
    const urls = fakeFetch.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.startsWith("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"))).toBe(true);
    const auth = fakeFetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"));
    expect(auth).toContain("Bearer test-dashscope-key");

    // 日志是异步写的,等它落库
    await vi.waitFor(async () => {
      const d = await c.get<AdminSessionDetail>(adminSession.GET, { params: { id } });
      expect(d.body.llmCalls.length).toBe(fakeFetch.mock.calls.length);
    });
    const detail = await c.get<AdminSessionDetail>(adminSession.GET, { params: { id } });
    const stages = new Set(detail.body.llmCalls.map((x) => x.stage));
    expect(stages.has("gate")).toBe(true);
    expect(stages.has("actor")).toBe(true);
    expect(detail.body.llmCalls.every((x) => x.ok && x.tokensIn === 1000 && (x.costYuan ?? 0) > 0)).toBe(true);

    const stats = await c.get<AdminStats>(adminStats.GET);
    expect(stats.body.costYuanTotal).toBeGreaterThan(0);
    expect(stats.body.costYuanPerSession).toBeCloseTo(stats.body.costYuanTotal, 6);
  });
});
