// 测试用的假模型:不联网。闸门按"用户原话 → 脚本里的标准标注"查表回答;演员默认照着提示词里
// "这一轮你可以新说出的事"和指路提示说话(和离线模板演员同一个意思),也可以注入泄露、编造、慢回复。
// 同一套逻辑既能当 ChatFn 直接塞给 LlmGate / LlmActor,也能挂在 127.0.0.1 的假 HTTP 服务上给命令行用。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatFn, ChatMessage, ChatRequest, GateOutput } from "@fde/engine";
import type { LlmCallLog } from "@fde/llm";
import { expandGate, type Step } from "../src/players.ts";

/** 从脚本步骤里收集"用户原话 → 标准闸门标注"。同一句话标注不同时以后出现的为准。 */
export function labelsFrom(steps: Step[]): Map<string, GateOutput> {
  const m = new Map<string, GateOutput>();
  for (const s of steps) if ("say" in s) m.set(s.say, expandGate(s.gate));
  return m;
}

/** 闸门提示词的最后一段是【用户最新一句】。 */
export function latestUserText(messages: ChatMessage[]): string {
  const last = messages.at(-1)?.content ?? "";
  const i = last.lastIndexOf("【用户最新一句】\n");
  return i >= 0 ? last.slice(i + "【用户最新一句】\n".length).trim() : last.trim();
}

/** 照着演员提示词说话:本轮可以新说的事 + 指路。和 TemplateActor 一样只说允许说的。 */
export function templateLike(system: string): string {
  const parts: string[] = [];
  const block = system.match(/【这一轮你可以新说出的事】\n([\s\S]*?)\n\n【这一轮你的态度】/)?.[1] ?? "无";
  if (block.trim() !== "无") {
    for (const line of block.split("\n")) {
      const t = line.replace(/^- /, "").replace(/(L\d:[^)]*)$/, "").trim();
      if (t) parts.push(t);
    }
  }
  for (const m of system.matchAll(/指给对方去找(\S+?)。/g)) parts.push(`这个你得问${m[1]}。`);
  return parts.join("") || "嗯。";
}

export interface FakeOptions {
  /** 闸门查表;查不到时按普通提问处理(什么都不命中)。 */
  labels?: Map<string, GateOutput>;
  /** 闸门固定返回这个(优先于查表)。 */
  gate?: (userText: string) => unknown;
  /** 演员说什么;默认 templateLike。call 从 0 开始计。 */
  actor?: (ctx: { system: string; userText: string; template: string; call: number }) => string;
  delayMs?: { gate?: number; actor?: number };
  /** 记调用日志(和网关的 onCall 一样),用来测花费。 */
  calls?: LlmCallLog[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 按环节回答一次;返回文本。 */
export async function answer(req: Pick<ChatRequest, "stage" | "messages">, opts: FakeOptions, counter: { actor: number }): Promise<string> {
  if (req.stage === "gate") {
    if (opts.delayMs?.gate) await sleep(opts.delayMs.gate);
    const said = latestUserText(req.messages);
    const out = opts.gate ? opts.gate(said) : (opts.labels?.get(said) ?? { acts: ["ask"], summary: said.slice(0, 20) });
    return JSON.stringify(out);
  }
  if (req.stage === "actor") {
    if (opts.delayMs?.actor) await sleep(opts.delayMs.actor);
    const system = req.messages[0]?.content ?? "";
    const userText = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const template = templateLike(system);
    return opts.actor ? opts.actor({ system, userText, template, call: counter.actor++ }) : template;
  }
  throw new Error(`假模型不回答 ${req.stage}`);
}

export function fakeChat(opts: FakeOptions = {}): ChatFn {
  const counter = { actor: 0 };
  return async (req) => {
    const t0 = Date.now();
    const text = await answer(req, opts, counter);
    opts.calls?.push({
      at: new Date().toISOString(),
      ...(req.sessionId && { sessionId: req.sessionId }),
      stage: req.stage,
      provider: "fake",
      model: req.stage === "gate" ? "fake-gate" : "fake-actor",
      tokensIn: 2000,
      tokensOut: 100,
      cachedTokens: 0,
      costYuan: req.stage === "gate" ? 0.0005 : 0.002,
      latencyMs: Date.now() - t0,
      attempts: 1,
      ok: true,
    });
    return { text };
  };
}

/** 127.0.0.1 上的 OpenAI 兼容假服务(/chat/completions),给命令行子进程用。 */
export async function fakeServer(opts: FakeOptions): Promise<{ url: string; close: () => Promise<void>; requests: number }> {
  const counter = { actor: 0 };
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      state.requests++;
      try {
        const j = JSON.parse(body) as { messages: ChatMessage[]; response_format?: unknown };
        const isGate = Boolean(j.response_format) || (j.messages[0]?.content ?? "").startsWith("你是一个对话标注器");
        const text = await answer({ stage: isGate ? "gate" : "actor", messages: j.messages }, opts, counter);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 2000, completion_tokens: 100 } }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    get requests() {
      return state.requests;
    },
  };
}
