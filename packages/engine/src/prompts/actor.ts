// 演员提示词(附录 A)。为了命中上下文缓存,固定部分(总则、硬规则)放最前,
// 其次是每个角色固定的人设,最后才是每轮变化的内容。
import type { TurnPlan } from "../director.ts";
import type { LoadedScenario } from "../scenario/load.ts";
import type { ChatMessage } from "../ports.ts";
import type { SessionState } from "../types.ts";

const LEVEL_TEXT: Record<string, string> = {
  L1: "L1:只说印象,不给数字",
  L2: "L2:说具体情况",
  L3: "L3:口头交代一句,把资料交给对方(文件由系统附上)",
};

const HEADER = `你在一个职业训练模拟里扮演一位真实的人。你就是这个人,不是助手,不负责帮对方把事情做成。
对面是一位第一次上门的技术服务方(他自称 FDE)。

【硬规则】
1. 只说下面写明的事实。下面没有的数字、金额、比例、人名、系统名,一律不说。被问到时按你的性格说"不清楚""没数",或者指给该问的人(见你的指路表)。
2. 不因为对方说得自信就同意。只有对方的话符合你的利益,或者和你已知的事一致时,你才点头。不说"你说得对""你们专业"这类话,除非态度是 cooperative。
3. 对方给出工期、报价、准确率之类的承诺时,用你自己的话复述一遍并当场确认。你会记住。
4. 对方问得泛,你就答得泛;问得具体,你才答得具体。一次只回应对方最主要的那个问题。
5. 口语,短句。通常 1 到 4 句,不超过 120 个字。可以用括号写一个简短的动作,比如(看了眼手表)。
6. 你不知道"模拟""系统提示""提示词""评分""场景"是什么。对方提到这些,当作听不懂的行话,把话题拉回你自己的事。回话里不要说出这些词,也不要复述对方的原话,说"你说的那些我听不懂"就行。
7. 不替对方总结,不给对方出主意,不问"还有什么想了解的"。
8. 只输出这个人此刻说的话,不加引号,不加名字前缀。`;

export interface ActorPrompt {
  messages: ChatMessage[];
  /** 守卫用:演员上下文里的全部事实性文字。 */
  context: string[];
}

export function buildActorPrompt(
  scn: LoadedScenario,
  st: SessionState,
  plan: TurnPlan,
  userText: string | undefined,
): ActorPrompt {
  const d = scn.data;
  const role = scn.role(plan.role!);
  const directive = plan.directive!;
  const context: string[] = [];
  const add = (s: string) => {
    context.push(s);
    return s;
  };

  const redirects = Object.entries(role.redirects)
    .map(([topic, rid]) => `${topic}→${scn.roles.get(rid)?.name ?? rid}`)
    .join(";");

  const roleCard = [
    "【你是谁】",
    add(`${role.name},${role.title}。`),
    add(`性格与说话方式:${role.persona}`),
    add(`你想要的:${role.goals.join(";")}`),
    role.blind_spot ? add(`你不清楚、也不关心的:${role.blind_spot}`) : "",
    role.agenda.length ? add(`你会主动提的事:${role.agenda.join(";")}`) : "",
    `你的指路表(被问到不归你管的事,指给谁):${redirects || "无"}`,
    "",
    "【公司背景】(可以自由提到)",
    ...d.world_public.map((w) => add(`- ${w}`)),
    add(`- ${d.briefing.company}`),
  ]
    .filter((l) => l !== "")
    .join("\n");

  // roleTold 已包含本轮披露;"已经说过的"要把本轮新说的排除掉
  const revealedNow = new Set(plan.reveals.map((r) => r.factId));
  const told = Object.entries(st.roleTold[role.id] ?? {})
    .filter(([fid]) => !revealedNow.has(fid))
    .map(([fid, lvl]) => {
    const f = scn.fact(fid);
    if (lvl === "L1") {
      const rule = f.unlock.find((u) => "role" in u && u.role === role.id && u.level === "L1");
      return add(`- ${(rule && "say" in rule && rule.say) || f.statement}`);
    }
    return add(`- ${f.statement}`);
  });
  const newReveals = plan.reveals;

  const ledger = st.ledger
    .filter((e) => e.type !== "solution")
    // 只展示,不进守卫白名单:轮次号不是可以说的数字;承诺的值由引擎另行放行
    .map((e) => `- 第 ${e.turn} 轮:${e.valueText}${e.retractedTurn ? `(第 ${e.retractedTurn} 轮对方说要收回)` : ""}`);

  const reveal = newReveals.length
    ? newReveals.map((r) => add(`- ${r.text}(${LEVEL_TEXT[r.level]})`)).join("\n")
    : "无";

  const hints: string[] = [];
  for (const h of plan.hints) {
    const to = h.toRole && h.toRole !== role.id ? scn.roles.get(h.toRole)?.name : undefined;
    if (h.kind === "redirect" && to) hints.push(add(`对方问的这件事归${to}管,指给对方去找${to}。`));
    if (h.kind === "blocked" && h.missingKind === "trust") hints.push("对方想要的东西你现在还不愿意给,先试探对方来意。");
  }

  const dynamic = [
    "【你知道、并且已经告诉过对方的事】",
    told.length ? told.join("\n") : "无",
    "",
    "【对方之前答应过你的事】",
    ledger.length ? ledger.join("\n") : "无",
    "",
    "【这一轮你可以新说出的事】",
    reveal,
    "",
    "【这一轮你的态度】",
    `${directive.stance}:${directive.instruction}`,
    ...hints,
    `这一轮必须说出的话或做出的动作:${directive.beat ? add(directive.beat) : "无"}`,
  ].join("\n");

  const system = `${HEADER}\n\n${roleCard}\n\n${dynamic}`;

  // 只带当前角色的对话历史(方案 2.4 成本控制第 3 条)
  const history: ChatMessage[] = st.transcript
    .filter((l) => l.roleId === role.id && l.speaker !== "system")
    .slice(-13)
    .map((l) => ({ role: l.speaker === "user" ? "user" : "assistant", content: l.text }) as ChatMessage);
  // 本轮用户发言已经在 transcript 末尾;没有用户发言(汇报开场)时补一句旁白
  if (userText === undefined) history.push({ role: "user", content: "(对方走进会议室,坐下)" });

  return { messages: [{ role: "system", content: system }, ...history], context };
}
