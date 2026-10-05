// 守卫:演员回复出给用户之前的确定性检查(方案 3.3.5)。
//   - 数字白名单:回复里的每个数字都要出自演员上下文、用户说过的话或承诺账本
//   - 金丝雀词:未解锁事实的特征词,不在演员上下文或用户原话里却出现了,就是泄露或编造
//   - 出戏词:模拟、提示词、评分……
//   - 附和词:对对对、你说得对……(态度为 cooperative 时放行)
import { extractNumbers, foldWidth, numberSet, round } from "./numbers.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import type { Directive, SessionState, Stance } from "./types.ts";

export interface GuardFlag {
  type: "number" | "canary" | "ooc" | "sycophancy" | "length" | "empty";
  detail: string;
}

export interface GuardContext {
  /** 演员这一轮上下文里的全部文字(人设、公共背景、它说过的事实、本轮披露、指令)。 */
  actorContext: string[];
  /** 用户说过的全部话。 */
  userTexts: string[];
  /** 用户已经看到过的文字(角色台词、旁白、资料标题)。只用于金丝雀词:用户见过的词不算泄露。 */
  seenTexts?: string[];
  ledgerTexts: string[];
  /** 尚未被用户获得的事实的金丝雀词。 */
  canaries: string[];
  stance: Stance;
}

const OOC_WORDS = [
  "模拟", "提示词", "系统提示", "prompt", "评分", "打分", "得分", "角色扮演", "扮演", "剧本",
  "语言模型", "大模型", "AI助手", "AI 助手", "人工智能助手", "作为AI", "作为一个AI", "我是AI", "玩家", "NPC", "游戏",
];

// 附和式开头:分句开头(允许前面有括号动作、引号、"嗯/好好好"之类的语气词、"我/我觉得/我也"),
// "你说得(太)对""对对对""完全同意""太对了""你们专业";后面紧跟"不/吗/么"的不算("你说的对不上""你说的对吗")
const SYCOPHANCY_RE =
  /(?:^|[。!?;…,，\n—])[\s—]*(?:\([^)]*\)\s*)*[“"'「]?\s*(?:[嗯哎哦啊呀是好]+[,，—\s]*)?(?:(?:我也觉得|我觉得|我也|我看|说实话|这点|这个|确实|其实|我)\s*){0,2}(对对对|[你您]说[得的]?太?对|说得太对了|[你您]们?真?专业|完全同意|太对了)(?![不吗么])/gu;

function sycophancyHits(text: string): string[] {
  return [...text.matchAll(SYCOPHANCY_RE)].map((m) => m[1]!);
}

const MAX_CHARS = 200;

/** 1、2 这类小数字配上泛用量词(一个、两句、一下)不检查;钟点(三点、十点半)不检查。 */
function exempt(n: ReturnType<typeof extractNumbers>[number]): boolean {
  if (n.value <= 2 && !n.percent && !["万", "千", "元", "块", "%"].includes(n.unit)) return true;
  if ((n.unit === "点" || n.unit === "点钟" || n.unit === "点半") && n.value <= 24) return true;
  return false;
}

export function checkReply(reply: string, ctx: GuardContext): GuardFlag[] {
  const flags: GuardFlag[] = [];
  const text = foldWidth(reply.trim());
  if (!text) return [{ type: "empty", detail: "空回复" }];
  if ([...text].length > MAX_CHARS) flags.push({ type: "length", detail: `${[...text].length} 字` });

  const allowedText = [...ctx.actorContext, ...ctx.userTexts, ...ctx.ledgerTexts].map(foldWidth);
  const allowed = numberSet(allowedText);
  for (const n of extractNumbers(text)) {
    if (exempt(n)) continue;
    if (allowed.has(round(n.value))) continue;
    // 约数("五六十个人")只要有一端是已知的数字,就是对已知事实的约略说法
    if (n.range && n.range.some((v) => allowed.has(round(v)))) continue;
    flags.push({ type: "number", detail: n.raw });
  }

  const corpus = [...allowedText, ...(ctx.seenTexts ?? []).map(foldWidth)].join("\n");
  for (const w of ctx.canaries) {
    if (text.includes(w) && !corpus.includes(w)) flags.push({ type: "canary", detail: w });
  }

  const userCorpus = ctx.userTexts.map(foldWidth).join("\n");
  for (const w of OOC_WORDS) {
    // 用户先说了"评分"之类,角色复述一下不算出戏;但"提示词""语言模型"永远拦
    const always = ["提示词", "系统提示", "语言模型", "AI助手", "AI 助手", "人工智能助手", "作为AI", "作为一个AI", "我是AI", "NPC"];
    if (text.toLowerCase().includes(w.toLowerCase()) && (always.includes(w) || !userCorpus.includes(w))) {
      flags.push({ type: "ooc", detail: w });
    }
  }

  if (ctx.stance !== "cooperative") {
    for (const w of sycophancyHits(text)) flags.push({ type: "sycophancy", detail: w });
  }
  return flags;
}

/** 用户还没拿到具体情况(L2 及以上)的事实的金丝雀词。L1 只是印象,不含这些词,不能因此解除保护。 */
export function activeCanaries(scn: LoadedScenario, st: SessionState): string[] {
  const out: string[] = [];
  for (const f of scn.data.facts) {
    const lv = st.facts[f.id]?.level;
    if (lv && lv !== "L1") continue;
    for (const w of f.canaries ?? []) out.push(w);
  }
  return out;
}

/** 守卫重试仍不通过(或模型出错)时的兜底台词。不含未披露的事实;必须说出的 beat 不丢。 */
export function fallbackLine(scn: LoadedScenario, roleId: string, d: Pick<Directive, "stance" | "redirectTo" | "fallback">): string {
  // 导演的 beat 是写给演员的指令(可能含"红鲱鱼"之类的作者注),绝不原样给用户看;只用作者写好的台词
  if (d.fallback) return d.fallback;
  const to = d.redirectTo && d.redirectTo !== roleId ? scn.roles.get(d.redirectTo)?.name : undefined;
  if (to) return `这个你得去问${to}。`;
  const stance: Stance = d.stance;
  switch (stance) {
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
