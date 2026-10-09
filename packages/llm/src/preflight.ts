// 模型预检(pnpm models:check,方案 2.3「固定模型快照」):Key 填进 .env 之后第一个要跑的命令。
//   静态检查(--no-network 也跑):每个模型都在 prices 里登记了价格;百炼的模型名是带日期的快照名(不是就警告);
//     DeepSeek 没有快照、旧名字会被转给新模型,给一条提示(不算警告,--strict 也不因它失败):上游一变就重跑回归。
//   在线检查:每个环节经网关发一次最小请求。参数用该环节自己的配置(extra、json 模式照带),只把 max_tokens 压小;
//     JSON 环节要求回复能解析成 JSON 对象;报告耗时和网关记下的 token、花费(即 llm_calls 的一行)。
// 本文件不读 process.env(infra 测试会扫这个目录里读到的变量),环境变量由调用方传进来。
import { costYuan, STAGES, type ModelsConfig, type Stage, type StageConfig } from "./config.ts";
import { createGateway, DEFAULT_TIMEOUT_MS, LlmError, type ChatMessage, type LlmCallLog } from "./gateway.ts";

export interface PreflightFinding {
  /** fail 失败;warn 警告,--strict 下也算失败;note 提示,只是提醒,不影响结论(--strict 也不算) */
  level: "fail" | "warn" | "note";
  /** 用到这个模型的环节(同一个模型被几个环节共用时只报一次) */
  stages: Stage[];
  message: string;
}

export interface StageProbe {
  stage: Stage;
  provider: string;
  model: string;
  keyEnv: string;
  keyPresent: boolean;
  json: boolean;
  /** 这次请求用的 max_tokens */
  maxTokens: number;
  /** 发了请求才有:true 通过,false 没过;--no-network 或没跑到时为 undefined */
  ok?: boolean;
  error?: string;
  /** 模型回复的开头(已脱敏) */
  reply?: string;
  /** 网关 onCall 记下的那一行(已脱敏) */
  log?: LlmCallLog;
}

export interface PreflightReport {
  stages: Stage[];
  network: boolean;
  findings: PreflightFinding[];
  probes: StageProbe[];
}

export interface PreflightOptions {
  /** 只查这些环节;不给或为空时查全部 */
  stages?: readonly Stage[];
  env: Record<string, string | undefined>;
  /** false 时不发请求(--no-network),Key 只列出有没有,不计入结论 */
  network: boolean;
  fetch?: typeof fetch;
}

// ---------- 静态检查

export type Vendor = "bailian" | "deepseek" | "other";

/** 按 provider 名或 base_url 的域名认供应商:快照规则只对百炼、DeepSeek 有意义。 */
export function vendorOf(cfg: ModelsConfig, provider: string): Vendor {
  let host = "";
  try {
    host = new URL(cfg.providers[provider]?.base_url ?? "").hostname;
  } catch {
    // base_url 已经过 schema 校验;这里只是防御
  }
  if (provider === "bailian" || host.includes("dashscope")) return "bailian";
  if (provider === "deepseek" || host === "deepseek.com" || host.endsWith(".deepseek.com")) return "deepseek";
  return "other";
}

/**
 * 百炼的快照名带日期后缀:-YYYY-MM-DD;更早的快照用 -MMDD(月日要像个日期)。
 * 不带日期的名字(稳定版、-latest)会跟着上游升级。
 */
export function isSnapshotName(model: string): boolean {
  return /-\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(model) || /-(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(model);
}

export function staticFindings(cfg: ModelsConfig, stages: readonly Stage[] = STAGES): PreflightFinding[] {
  const byModel = new Map<string, { provider: string; model: string; stages: Stage[] }>();
  for (const s of stages) {
    const sc = cfg.stages[s];
    const k = `${sc.provider}/${sc.model}`;
    const e = byModel.get(k) ?? { provider: sc.provider, model: sc.model, stages: [] };
    e.stages.push(s);
    byModel.set(k, e);
  }
  const out: PreflightFinding[] = [];
  for (const { provider, model, stages: ss } of byModel.values()) {
    const who = `${ss.join("、")} 用的 ${provider}/${model}`;
    // 和网关算花费走同一个函数:它返回 undefined,网关日志就记 null
    if (costYuan(cfg, model, 0, 0) === undefined) {
      out.push({
        level: "fail",
        stages: ss,
        message:
          `${who} 在 prices 里没有登记价格:网关会把花费记成 null,pnpm evals / calibrate 汇总时当 ¥0 算,花费悄悄消失。` +
          `在 config/models.yaml 的 prices 里补一行 ${model}: [输入, 输出](元/百万 token,照官网标价)`,
      });
    }
    const vendor = vendorOf(cfg, provider);
    if (vendor === "bailian" && !isSnapshotName(model)) {
      out.push({
        level: "warn",
        stages: ss,
        message:
          `${who} 不是带日期的快照名(形如 ${model}-YYYY-MM-DD):这类名字会跟着上游升级,模型行为可能悄悄变。` +
          `到百炼的模型列表里找它的快照版换上,补上同名价格,再跑 pnpm evals --live(见 docs/models.md)`,
      });
    }
    // 提示而不是警告:DeepSeek 没有快照可钉,配置里没有能改的地方,对策只有上游一变就重跑回归;
    // 想消掉它只能把裁判换到别家,又和方案「演员、裁判用不同厂商」的建议相悖。所以 --strict 不因它失败
    if (vendor === "deepseek") {
      out.push({
        level: "note",
        stages: ss,
        message:
          `${who}:DeepSeek 没有带日期的快照,旧模型名的请求会被转给新模型。` +
          `DeepSeek 一有模型或价格变动,就要重跑 pnpm evals --live${ss.includes("judge") ? " 和 pnpm calibrate --live" : ""}`,
      });
    }
  }
  return out;
}

// ---------- 在线检查

/** 关了思考的环节回一句话 64 个 token 足够;没关思考的(裁判)思考过程也可能算进 max_tokens,给 1024。都不超过环节自己的上限。 */
export const PROBE_MAX_TOKENS = 64;
export const PROBE_MAX_TOKENS_THINKING = 1024;

/** 这个环节关了思考没有:百炼写 enable_thinking: false,DeepSeek 写 thinking: {type: disabled}(DeepSeek 默认开思考)。 */
export function thinkingOff(sc: StageConfig): boolean {
  if (sc.extra?.enable_thinking === false) return true;
  const t = sc.extra?.thinking;
  return typeof t === "object" && t !== null && (t as { type?: unknown }).type === "disabled";
}

export function probeMaxTokens(sc: StageConfig): number {
  return Math.min(sc.max_tokens, thinkingOff(sc) ? PROBE_MAX_TOKENS : PROBE_MAX_TOKENS_THINKING);
}

/** 引擎的 LlmGate、LlmJudge 调用时固定带 json: true(packages/engine/src/llm-ports.ts),其余环节看配置。 */
export function isJsonStage(stage: Stage, sc: StageConfig): boolean {
  return stage === "gate" || stage === "judge" || sc.json === true;
}

// json 模式要求消息里出现 "JSON" 字样,否则百炼、OpenAI 兼容接口会直接 400
const PROBE_JSON: ChatMessage[] = [
  { role: "system", content: '这是接口连通性自检。只输出一个 JSON 对象 {"ok": true},不要输出任何别的内容。' },
  { role: "user", content: "按要求输出 JSON。" },
];
const PROBE_TEXT: ChatMessage[] = [
  { role: "system", content: "这是接口连通性自检。只回复两个字:收到。" },
  { role: "user", content: "收到请回复。" },
];

/** 截断处残留的 Key 片段至少这么长才抹:更短的拼不回 Key,和普通文字撞上的概率也大 */
export const KEY_FRAGMENT_MIN = 8;

/**
 * 把配置里各供应商 Key 的原文从要打印的文字里抹掉(供应商的 401 报错有时会回显 Key)。
 * 先抹完整的 Key,再抹截断处残留的片段:结尾是某个 Key 的前缀、开头是某个 Key 的后缀(至少 KEY_FRAGMENT_MIN 个字符)。
 * 结尾、开头的截断处有三种:回复预览截到 80 字(preview)、网关把报错正文截到 300 字(在报错末尾)、模型回复被 max_tokens 截断。
 * 要截断的文字得先整段抹、截完再抹一次:先截后抹的话,跨在截断处的 Key 只剩前半截,整段匹配认不出来。
 * 还有一处截断不在两头,片段匹配管不到:响应体不是 JSON 时,V8 的解析报错里带着响应体的一小段(见 dropBodySnippet),
 * 那一段在抹 Key 之前就整段去掉(probeStage 里的 redactErr)。
 */
function redactor(cfg: ModelsConfig, env: Record<string, string | undefined>): (s: string) => string {
  const secrets = [
    ...new Set(
      Object.values(cfg.providers)
        .map((p) => env[p.api_key_env]?.trim())
        .filter((v): v is string => !!v && v.length >= 4),
    ),
  ];
  const fragments = (s: string): string => {
    for (const k of secrets) {
      // 从长到短找:抹掉能对上的最长一段
      for (let n = k.length - 1; n >= KEY_FRAGMENT_MIN; n--) {
        if (s.endsWith(k.slice(0, n))) {
          s = `${s.slice(0, -n)}***`;
          break;
        }
      }
      for (let n = k.length - 1; n >= KEY_FRAGMENT_MIN; n--) {
        if (s.startsWith(k.slice(-n))) {
          s = `***${s.slice(n)}`;
          break;
        }
      }
    }
    return s;
  };
  return (s) => fragments(secrets.reduce((t, k) => t.split(k).join("***"), s));
}

/**
 * 回复预览:整段抹 Key(压空白之前:Key 里混了换行的也认得出)→ 压空白 → 再抹一次结尾(片段后面跟着空白的)
 * → 截到 80 字 → 截完再抹一次截断处,最后才加省略号(加了省略号结尾就对不上 Key 的前缀了)。
 */
function preview(s: string, redact: (s: string) => string): string {
  const one = redact(redact(s).replace(/\s+/g, " ").trim());
  return one.length > 80 ? `${redact(one.slice(0, 80))}…` : one;
}

/**
 * 响应体不是 JSON 时,V8 的报错形如 Unexpected token 'X', "Xsk-abcdef"... is not valid JSON:引号里是响应体的一小段
 * (约 10~20 个字符,可能从中间开窗,前面带 ...),两头都可能切在 Key 中间,残片后面还跟着 "...,结尾、开头的片段匹配认不出来。
 * 这一段对排查没多大用(说明里已经讲了返回的不是 JSON),整段去掉;其余报错原样返回。
 */
function dropBodySnippet(msg: string): string {
  return msg.replace(/(Unexpected token '.+?'), (?:\.\.\.)?".*"(?:\.\.\.)? (is not valid JSON)/su, "$1, (响应体片段已略去) $2");
}

/** 返回的文字已脱敏:报错原文(网关截到 300 字的报错正文在它末尾)先抹 Key,再接说明 —— 接上说明之后,截断处就不在结尾了。 */
function explain(e: unknown, sc: StageConfig, keyEnv: string, baseUrl: string, redact: (s: string) => string): string {
  const msg = redact(e instanceof Error ? e.message : String(e));
  if (e instanceof LlmError && e.status !== undefined) {
    const s = e.status;
    const hint =
      s === 401 || s === 403
        ? `Key 无效、过期,或没有这个模型的权限(检查 ${keyEnv})`
        : s === 404
          ? "模型名或 base_url 不对"
          : s === 400
            ? "请求被拒:检查模型名,以及 extra 里的参数这个模型认不认"
            : s === 429
              ? "限流或额度用完"
              : s >= 500
                ? "供应商服务端出错,稍后再试(预检不重试)"
                : "";
    return hint ? `${msg} —— ${hint}` : msg;
  }
  if (msg.endsWith("超时")) return `${msg}:${sc.timeout_ms ?? DEFAULT_TIMEOUT_MS} ms 内没有返回(预检不重试)`;
  if (msg.includes("网络错误")) {
    // 网关把 fetch 和解析响应体时抛的所有异常都叫「网络错误」,这里按原始报错再分一次。
    // 先认 JSON 解析错误:它的报错里带着响应体开头,里面写什么都有可能
    if (/is not valid JSON|Unexpected end of JSON input|Unexpected token/.test(msg)) {
      return `${msg} —— 连上了,但返回的不是 JSON:${baseUrl} 可能指向了网页、登录页或代理`;
    }
    if (/ByteString|invalid header value/i.test(msg)) return `${msg} —— Key 里有非法字符(检查 ${keyEnv} 是否混入全角字符、换行)`;
    if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(msg)) return `${msg} —— 连不上 ${baseUrl},检查网络和 base_url`;
  }
  return msg;
}

/**
 * 线上更宽松:引擎的 extractJson(packages/engine/src/prompts/gate.ts)先去掉 ```json 围栏,
 * 再取第一个 { 到最后一个 } 之间解析。预检故意更严(要求整段回复就是 JSON),这里只用来把报错说清楚。
 */
function lenientObject(text: string): boolean {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end < start) return false;
  try {
    const v: unknown = JSON.parse(t.slice(start, end + 1));
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** 查一个环节:Key 在不在;network 为 true 时再经网关发一次最小请求。 */
export async function probeStage(cfg: ModelsConfig, stage: Stage, opts: PreflightOptions): Promise<StageProbe> {
  const sc = cfg.stages[stage];
  const provider = cfg.providers[sc.provider]!;
  const keyEnv = provider.api_key_env;
  const json = isJsonStage(stage, sc);
  const maxTokens = probeMaxTokens(sc);
  const probe: StageProbe = {
    stage,
    provider: sc.provider,
    model: sc.model,
    keyEnv,
    keyPresent: !!opts.env[keyEnv]?.trim(),
    json,
    maxTokens,
  };
  if (!opts.network) return probe;
  if (!probe.keyPresent) {
    return {
      ...probe,
      ok: false,
      error: `缺少环境变量 ${keyEnv}(${stage} 环节用 ${sc.provider} 的 ${sc.model}):在仓库根目录的 .env 里填上(没有就 cp .env.example .env)`,
    };
  }

  const redact = redactor(cfg, opts.env);
  // 报错(返回值里的 error、日志里的 error)先去掉 V8 带出来的响应体片段,再抹 Key;回复预览不走这一步
  const redactErr = (s: string): string => redact(dropBodySnippet(s));
  // 只换 max_tokens,其余参数(温度、extra、json、timeout_ms)和线上一致
  const probeCfg: ModelsConfig = { ...cfg, stages: { ...cfg.stages, [stage]: { ...sc, max_tokens: maxTokens } } };
  let log: LlmCallLog | undefined;
  const chat = createGateway(probeCfg, {
    env: opts.env,
    fetch: opts.fetch,
    // 预检要看第一次请求的真实结果:不重试,也免得裁判 120 秒的超时叠三遍
    retries: 0,
    onCall: (l) => {
      log = l.error === undefined ? l : { ...l, error: redactErr(l.error) };
    },
  });
  const done = (r: Partial<StageProbe>): StageProbe => ({ ...probe, ...r, ...(log && { log }) });

  let text: string;
  try {
    ({ text } = await chat({ stage, messages: json ? PROBE_JSON : PROBE_TEXT, json, sessionId: "models-check" }));
  } catch (e) {
    return done({ ok: false, error: explain(e, sc, keyEnv, provider.base_url, redactErr) });
  }
  const reply = preview(text, redact);
  if (!text.trim()) {
    const why = thinkingOff(sc) ? "" : `;这个环节没关思考,思考过程可能把 max_tokens(${maxTokens})用完了`;
    return done({ ok: false, reply, error: `回复为空${why}` });
  }
  if (json) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      if (lenientObject(text)) {
        return done({
          ok: false,
          reply,
          error: `回复不是纯 JSON(包了 \`\`\`json 围栏或夹了别的文字;线上的解析能容忍,但说明 json 模式没生效):${reply}`,
        });
      }
      return done({ ok: false, reply, error: `回复不是合法 JSON(json 模式可能没生效):${reply}` });
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      return done({ ok: false, reply, error: `回复是 JSON,但不是对象:${reply}` });
    }
  }
  return done({ ok: true, reply });
}

export async function runPreflight(cfg: ModelsConfig, opts: PreflightOptions): Promise<PreflightReport> {
  const stages = opts.stages?.length ? STAGES.filter((s) => opts.stages!.includes(s)) : [...STAGES];
  const probes: StageProbe[] = [];
  // 一个一个发:耗时才是单次请求的耗时
  for (const s of stages) probes.push(await probeStage(cfg, s, opts));
  return { stages, network: opts.network, findings: staticFindings(cfg, stages), probes };
}

// ---------- 结论与输出

export function tallyPreflight(r: PreflightReport): { failures: number; warnings: number; notes: number } {
  return {
    failures: r.findings.filter((f) => f.level === "fail").length + r.probes.filter((p) => p.ok === false).length,
    warnings: r.findings.filter((f) => f.level === "warn").length,
    notes: r.findings.filter((f) => f.level === "note").length,
  };
}

/** 0:都通过(可以有警告、提示);1:有检查没过,或 strict 下有警告(提示不算)。参数和配置错误(退出码 2)由命令行自己处理。 */
export function preflightExitCode(r: PreflightReport, strict: boolean): 0 | 1 {
  const t = tallyPreflight(r);
  return t.failures > 0 || (strict && t.warnings > 0) ? 1 : 0;
}

const yuan = (c: number | null) => (c === null ? "未登记价格(网关记为 null)" : `¥${c.toFixed(6)}`);

function formatLog(l: LlmCallLog): string {
  if (!l.ok) return `耗时 ${l.latencyMs} ms · 失败,不计费 · 尝试 ${l.attempts} 次`;
  return `耗时 ${l.latencyMs} ms · 输入 ${l.tokensIn} / 输出 ${l.tokensOut} / 缓存 ${l.cachedTokens} token · ${yuan(l.costYuan)} · 尝试 ${l.attempts} 次`;
}

export function renderPreflight(r: PreflightReport, opts: { strict?: boolean; verbose?: boolean } = {}): string[] {
  const lines: string[] = [];
  lines.push("静态检查(价格、快照)");
  if (!r.findings.some((f) => f.level === "fail")) {
    const models = [...new Set(r.stages.map((s) => r.probes.find((p) => p.stage === s)?.model ?? s))];
    lines.push(`  ✓ 价格:${models.join("、")} 都在 prices 里`);
  }
  for (const f of r.findings) lines.push(`  ${f.level === "fail" ? "✗" : f.level === "warn" ? "!" : "i"} ${f.message}`);

  lines.push("");
  lines.push(
    r.network
      ? `在线检查(每个环节一次最小请求,不重试;max_tokens 压到 ${PROBE_MAX_TOKENS},没关思考的环节 ${PROBE_MAX_TOKENS_THINKING})`
      : "在线检查:跳过(--no-network);下面只列 Key 有没有配,不计入结论",
  );
  const width = Math.max(0, ...r.probes.map((p) => `${p.provider}/${p.model}`.length));
  for (const p of r.probes) {
    const mark = p.ok === undefined ? "·" : p.ok ? "✓" : "✗";
    const kind = p.ok ? `  ${p.json ? "JSON 对象" : "文本"}回复 ✓` : "";
    lines.push(`  ${mark} ${p.stage.padEnd(7)} ${`${p.provider}/${p.model}`.padEnd(width)}  ${p.keyEnv} ${p.keyPresent ? "已配置" : "缺失"}${kind}`);
    if (p.log) lines.push(`      ${formatLog(p.log)}`);
    if (p.ok && opts.verbose && p.reply !== undefined) lines.push(`      回复:${p.reply}`);
    if (p.error) lines.push(`      ${p.error}`);
    if (opts.verbose && p.log) lines.push(`      ${JSON.stringify(p.log)}`);
  }

  const logs = r.probes.flatMap((p) => (p.log ? [p.log] : []));
  if (logs.length) {
    const cost = logs.reduce((s, l) => s + (l.costYuan ?? 0), 0);
    const unpriced = logs.filter((l) => l.costYuan === null).length;
    lines.push("");
    lines.push(`本次预检发了 ${logs.length} 次请求,约 ¥${cost.toFixed(6)}${unpriced ? `(另有 ${unpriced} 次的模型没登记价格,没算进去)` : ""}`);
  }

  const { failures, warnings, notes } = tallyPreflight(r);
  const scope = r.network ? "" : "(只做了静态检查)";
  lines.push("");
  if (failures) lines.push(`结论:${failures} 项没过${warnings ? `、${warnings} 条警告` : ""} → 不通过`);
  else if (warnings && opts.strict) lines.push(`结论${scope}:检查都过了,但有 ${warnings} 条警告;--strict 下警告也算失败 → 不通过`);
  else if (warnings) lines.push(`结论${scope}:检查都过了,有 ${warnings} 条警告 → 通过(--strict 下不通过)`);
  else lines.push(`结论${scope}:全部通过${notes ? `(另有 ${notes} 条提示,不算警告,--strict 下也通过)` : ""}`);
  return lines;
}
