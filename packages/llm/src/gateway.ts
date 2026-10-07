// 模型网关:OpenAI 兼容的 /chat/completions,按环节选模型;统一重试、超时、计费日志。
// 只依赖 fetch,不引第三方 SDK;百炼、DeepSeek、火山方舟都走同一协议。
import { costYuan, type ModelsConfig, type Stage } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  stage: Stage;
  messages: ChatMessage[];
  json?: boolean;
  sessionId?: string;
}

export interface ChatResponse {
  text: string;
}

/** 对应数据表 llm_calls(方案 2.2)。 */
export interface LlmCallLog {
  at: string;
  sessionId?: string;
  stage: Stage;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costYuan: number | null;
  latencyMs: number;
  attempts: number;
  ok: boolean;
  error?: string;
}

export interface GatewayOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  onCall?: (log: LlmCallLog) => void;
  /** 网络错误、429、5xx 的重试次数。 */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 环节没配 timeout_ms 时的单次请求超时。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export function createGateway(cfg: ModelsConfig, opts: GatewayOptions = {}) {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? defaultSleep;

  return async function chat(req: ChatRequest): Promise<ChatResponse> {
    const sc = cfg.stages[req.stage];
    const provider = cfg.providers[sc.provider]!;
    const key = env[provider.api_key_env];
    if (!key) throw new LlmError(`缺少环境变量 ${provider.api_key_env}(${req.stage} 环节用 ${sc.provider})`);

    const body: Record<string, unknown> = {
      model: sc.model,
      messages: req.messages,
      temperature: sc.temperature,
      max_tokens: sc.max_tokens,
      stream: false,
      ...sc.extra,
    };
    if (req.json ?? sc.json) body.response_format = { type: "json_object" };

    const started = Date.now();
    let attempts = 0;
    let lastErr: LlmError | undefined;
    while (attempts <= retries) {
      attempts++;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), sc.timeout_ms ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await doFetch(`${provider.base_url.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          throw new LlmError(`${sc.provider} ${res.status}: ${detail}`, res.status, res.status === 429 || res.status >= 500);
        }
        const json = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            prompt_cache_hit_tokens?: number;
          };
        };
        const text = json.choices?.[0]?.message?.content;
        if (typeof text !== "string") throw new LlmError(`${sc.provider} 返回里没有内容`, res.status, true);
        const tokensIn = json.usage?.prompt_tokens ?? 0;
        const tokensOut = json.usage?.completion_tokens ?? 0;
        const cost = costYuan(cfg, sc.model, tokensIn, tokensOut);
        opts.onCall?.({
          at: new Date().toISOString(),
          sessionId: req.sessionId,
          stage: req.stage,
          provider: sc.provider,
          model: sc.model,
          tokensIn,
          tokensOut,
          cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? json.usage?.prompt_cache_hit_tokens ?? 0,
          costYuan: cost ?? null,
          latencyMs: Date.now() - started,
          attempts,
          ok: true,
        });
        return { text };
      } catch (e) {
        const err =
          e instanceof LlmError
            ? e
            : new LlmError((e as Error).name === "AbortError" ? `${sc.provider} 超时` : `${sc.provider} 网络错误:${(e as Error).message}`, undefined, true);
        lastErr = err;
        if (!err.retryable || attempts > retries) break;
        await sleep(500 * 2 ** (attempts - 1));
      } finally {
        clearTimeout(timer);
      }
    }
    opts.onCall?.({
      at: new Date().toISOString(),
      sessionId: req.sessionId,
      stage: req.stage,
      provider: sc.provider,
      model: sc.model,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costYuan: 0,
      latencyMs: Date.now() - started,
      attempts,
      ok: false,
      error: lastErr?.message,
    });
    throw lastErr ?? new LlmError("未知错误");
  };
}

export type ChatFn = ReturnType<typeof createGateway>;

/** 测试用:按环节返回预置内容。 */
export function mockChat(handler: (req: ChatRequest) => string | Promise<string>): ChatFn {
  return async (req) => ({ text: await handler(req) });
}
