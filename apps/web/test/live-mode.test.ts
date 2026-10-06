// live 模式的接线测试:不连真模型(fetch 被替换成假的),只验证引擎用的是模型端口、
// 每次模型调用都写进 llm_calls(带 sessionId 和花费),管理页能看到。
import { mkdtempSync } from "node:fs";
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
  Object.assign(process.env, {
    FDE_ROOT: ROOT,
    FDE_ENGINE_MODE: "live",
    FDE_DEV_LOGIN_CODES: "1",
    FDE_MEMORY_STORE_FILE: join(mkdtempSync(join(tmpdir(), "fde-web-live-")), "store.json"),
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
