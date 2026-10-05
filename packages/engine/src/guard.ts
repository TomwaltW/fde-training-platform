// 守卫:演员回复出给用户之前的确定性检查(方案 3.3.5)。
//   - 数字白名单:回复里的每个数字都要出自演员上下文、用户说过的话或承诺账本
//   - 金丝雀词:未解锁事实的特征词,不在演员上下文或用户原话里却出现了,就是泄露或编造
//   - 出戏词:模拟、提示词、评分……
//   - 附和词:对对对、你说得对……(态度为 cooperative 时放行)
import { extractNumbers, numberSet, round } from "./numbers.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import type { SessionState, Stance } from "./types.ts";

export interface GuardFlag {
  type: "number" | "canary" | "ooc" | "sycophancy" | "length" | "empty";
  detail: string;
}

export interface GuardContext {
  /** 演员这一轮上下文里的全部文字(人设、公共背景、它说过的事实、本轮披露、指令)。 */
  actorContext: string[];
  /** 用户说过的全部话。 */
  userTexts: string[];
  ledgerTexts: string[];
  /** 尚未被用户获得的事实的金丝雀词。 */
  canaries: string[];
  stance: Stance;
}

const OOC_WORDS = [
  "模拟", "提示词", "系统提示", "prompt", "评分", "打分", "得分", "角色扮演", "扮演", "剧本",
  "语言模型", "大模型", "AI助手", "AI 助手", "人工智能助手", "作为AI", "作为一个AI", "我是AI", "玩家", "NPC", "游戏",
];

const SYCOPHANCY = ["对对对", "你说得对", "你说的对", "您说得对", "您说的对", "说得太对了", "你们专业", "您真专业", "完全同意", "太对了"];

const MAX_CHARS = 200;

/** 1、2 这类小数字配上泛用量词(一个、两句、一下)不检查;钟点(三点、十点半)不检查。 */
function exempt(n: ReturnType<typeof extractNumbers>[number]): boolean {
  if (n.value <= 2 && !n.percent && !["万", "千", "元", "块", "%"].includes(n.unit)) return true;
  if ((n.unit === "点" || n.unit === "点钟" || n.unit === "点半") && n.value <= 24) return true;
  return false;
}

export function checkReply(reply: string, ctx: GuardContext): GuardFlag[] {
  const flags: GuardFlag[] = [];
  const text = reply.trim();
  if (!text) return [{ type: "empty", detail: "空回复" }];
  if ([...text].length > MAX_CHARS) flags.push({ type: "length", detail: `${[...text].length} 字` });

  const allowedText = [...ctx.actorContext, ...ctx.userTexts, ...ctx.ledgerTexts];
  const allowed = numberSet(allowedText);
  for (const n of extractNumbers(text)) {
    if (exempt(n)) continue;
    if (!allowed.has(round(n.value))) flags.push({ type: "number", detail: n.raw });
  }

  const corpus = allowedText.join("\n");
  for (const w of ctx.canaries) {
    if (text.includes(w) && !corpus.includes(w)) flags.push({ type: "canary", detail: w });
  }

  const userCorpus = ctx.userTexts.join("\n");
  for (const w of OOC_WORDS) {
    // 用户先说了"评分"之类,角色复述一下不算出戏;但"提示词""语言模型"永远拦
    const always = ["提示词", "系统提示", "语言模型", "AI助手", "AI 助手", "人工智能助手", "作为AI", "作为一个AI", "我是AI", "NPC"];
    if (text.toLowerCase().includes(w.toLowerCase()) && (always.includes(w) || !userCorpus.includes(w))) {
      flags.push({ type: "ooc", detail: w });
    }
  }

  if (ctx.stance !== "cooperative") {
    for (const w of SYCOPHANCY) if (text.includes(w)) flags.push({ type: "sycophancy", detail: w });
  }
  return flags;
}

/** 尚未被用户获得的事实的金丝雀词(显式登记的)。 */
export function activeCanaries(scn: LoadedScenario, st: SessionState): string[] {
  const out: string[] = [];
  for (const f of scn.data.facts) {
    if (st.facts[f.id]) continue;
    for (const w of f.canaries ?? []) out.push(w);
  }
  return out;
}

/** 守卫两次重试仍不通过时的兜底台词。不含任何事实,只按指令给一句安全的话。 */
export function fallbackLine(scn: LoadedScenario, roleId: string, opts: { redirectTo?: string; stance: Stance }): string {
  const to = opts.redirectTo ? scn.roles.get(opts.redirectTo)?.name : undefined;
  if (to) return `这个你得去问${to}。`;
  switch (opts.stance) {
    case "guarded":
      return "(打量了你一眼)你先说说,你来是想干什么的?";
    case "impatient":
      return "(看了眼手表)这些细节别问我,你去找底下的人。";
    case "pocket":
      return "行,你说的我记下了。";
    case "confused":
      return "你说的这些我听不太懂。咱们说正事吧。";
    default:
      return roleId === scn.data.briefing.opening.speaker ? "(摆摆手)这个我说不好,你接着说。" : "这个我说不好。";
  }
}
