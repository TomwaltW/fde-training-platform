import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createGateway, loadModelsConfig, type LlmCallLog } from "../src/index.ts";

const cfg = loadModelsConfig(resolve(import.meta.dirname, "../../../config/models.yaml"));
const env = { DASHSCOPE_API_KEY: "k1", DEEPSEEK_API_KEY: "k2" };
const ok = (text: string, usage = { prompt_tokens: 1000, completion_tokens: 100 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage }), { status: 200 });

describe("llm gateway", () => {
  it("按环节选供应商和模型,JSON 环节带 response_format,记录花费", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const logs: LlmCallLog[] = [];
    const chat = createGateway(cfg, {
      env,
      onCall: (l) => logs.push(l),
      fetch: async (url, init) => {
        seen.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") ?? "" });
        return ok("{}");
      },
    });
    await chat({ stage: "gate", messages: [{ role: "user", content: "hi" }] });
    await chat({ stage: "judge", messages: [{ role: "user", content: "hi" }] });
    expect(seen[0]!.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(seen[0]!.body.model).toBe("qwen3.7-flash");
    expect(seen[0]!.body.response_format).toEqual({ type: "json_object" });
    expect(seen[0]!.body.enable_thinking).toBe(false);
    expect(seen[0]!.auth).toBe("Bearer k1");
    expect(seen[1]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(seen[1]!.auth).toBe("Bearer k2");
    // qwen3.7-flash: 0.2/0.8 元每百万 token
    expect(logs[0]!.costYuan).toBeCloseTo((1000 * 0.2 + 100 * 0.8) / 1e6);
  });

  it("429 和 5xx 重试,4xx 不重试", async () => {
    let n = 0;
    const chat = createGateway(cfg, {
      env,
      sleep: async () => {},
      fetch: async () => (++n < 3 ? new Response("busy", { status: 503 }) : ok("hello")),
    });
    expect((await chat({ stage: "actor", messages: [] })).text).toBe("hello");
    expect(n).toBe(3);

    let m = 0;
    const bad = createGateway(cfg, { env, sleep: async () => {}, fetch: async () => (m++, new Response("nope", { status: 400 })) });
    await expect(bad({ stage: "actor", messages: [] })).rejects.toThrow(/400/);
    expect(m).toBe(1);
  });

  it("缺少 API Key 时给出明确的错误", async () => {
    const chat = createGateway(cfg, { env: {}, fetch: async () => ok("x") });
    await expect(chat({ stage: "actor", messages: [] })).rejects.toThrow(/DASHSCOPE_API_KEY/);
  });
});
