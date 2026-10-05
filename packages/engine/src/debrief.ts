// 复盘(方案 3.4.3)。第 2–3 项来自规则和裁判证据;第 5–6 项是预先写好的文稿;
// 只有文字润色交给模型(附录 C)。没有模型时用 renderDebriefMarkdown 直接出稿。
import type { JudgeOutput } from "./judge.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import type { ChatMessage } from "./ports.ts";
import type { ScoreReport } from "./scoring.ts";
import { rolesTalkedTo } from "./state.ts";
import type { LedgerEntry, SessionState } from "./types.ts";

export const AI_NOTICE = "本复盘由 AI 生成,仅供训练参考。";

export interface DebriefData {
  title: string;
  total: number;
  band: string;
  badges: string[];
  dimensions: { id: string; name: string; score: number; max: number; details: string[] }[];
  caps: string[];
  keyMoments: JudgeOutput["key_moments"];
  /** 裁判抽出的主张与逐项判定(附带对照项原文),给复盘撰写用。 */
  claims: JudgeOutput["claims"];
  verdicts: {
    T: (JudgeOutput["T"][number] & { statement: string })[];
    S: (JudgeOutput["S"][number] & { statement: string })[];
    W: (JudgeOutput["W"][number] & { item: string })[];
  };
  ledger: (LedgerEntry & { recalled: boolean })[];
  unmetRoles: string[];
  undiscoveredRoles: string[];
  missedArtifacts: string[];
  unopenedArtifacts: string[];
  truthByCount: { name: string; count: number; share: number }[];
  truthByLoss: { name: string; loss: number; share: number }[];
  successDefinition: string[];
  expertPath?: string;
  realWorld?: string;
  actions: string[];
  shareCard: { total: number; badges: string[]; line: string };
  npcInconsistencies: JudgeOutput["npc_inconsistencies"];
  judgeIssues: string[];
}

function nextActions(scn: LoadedScenario, st: SessionState, score: ScoreReport): string[] {
  const out: string[] = [];
  const dim = (id: string) => score.dimensions.find((d) => d.id === id);
  if (st.ledger.some((e) => e.premature)) out.push("没看数据之前,工期和报价只给区间和前提。");
  const opened = Object.values(st.artifacts).filter((a) => a.openedTurn !== undefined).length;
  if (opened < 2) out.push("第一个小时内就开口要记录和台账,不要只听说法。");
  const talked = rolesTalkedTo(st);
  if (talked.length <= 2) out.push("老板之外,至少见一位一线和一位管钱的人。");
  if ((dim("D4")?.score ?? 0) < (dim("D4")?.max ?? 0) * 0.6) out.push("同时按件数和按金额排一次问题,再下结论。");
  if ((dim("D5")?.score ?? 0) < (dim("D5")?.max ?? 0) * 0.6) out.push("问清老板为什么是现在、做成对他意味着什么。");
  if ((dim("D7")?.score ?? 0) < (dim("D7")?.max ?? 0) * 0.6) out.push("下一步写成一到两周的小验证,带验收指标。");
  if (!Object.keys(st.experiments).length) out.push("拿到数据后挑一个验证做,用结果说话。");
  out.push("问一句:之前试过什么,为什么没用下去。");
  return [...new Set(out)].slice(0, 3);
}

export function buildDebriefData(
  scn: LoadedScenario,
  st: SessionState,
  score: ScoreReport,
  judge: JudgeOutput,
  judgeIssues: string[] = [],
): DebriefData {
  const d = scn.data;
  const talked = new Set(rolesTalkedTo(st));
  const cats = d.truth.error_categories ?? [];
  const totalCount = cats.reduce((s, c) => s + c.count, 0) || 1;
  const totalLoss = cats.reduce((s, c) => s + c.loss, 0) || 1;
  // 只有汇报开场时被原话拿出来的那几条才算"被记账",之后新给的承诺不算
  const recallEvent = st.events.find((e) => e.type === "trap" && e.payload.trap === "ledger_recall");
  const recalledIds = new Set((recallEvent?.payload.entries as string[] | undefined) ?? []);
  const realWorld = d.debrief.real_world_note ? scn.readText(d.debrief.real_world_note) : undefined;
  return {
    title: d.meta.title,
    total: score.total,
    band: score.band,
    badges: score.badges,
    dimensions: score.dimensions.map((x) => ({ id: x.id, name: x.name, score: x.score, max: x.max, details: x.details })),
    caps: score.caps.map((c) => c.label),
    keyMoments: judge.key_moments,
    claims: judge.claims,
    verdicts: {
      T: judge.T.map((t) => ({ ...t, statement: d.truth.diagnosis_items.find((x) => x.id === t.id)?.statement ?? "" })),
      S: judge.S.map((x) => ({ ...x, statement: scn.facts.get(x.id)?.statement ?? "" })),
      W: judge.W.map((w) => ({ ...w, item: d.rubric.d7_checklist.find((x) => x.id === w.id)?.item ?? "" })),
    },
    ledger: st.ledger.map((e) => ({ ...e, recalled: recalledIds.has(e.id) })),
    unmetRoles: d.roles.filter((r) => st.discovered.includes(r.id) && !talked.has(r.id)).map((r) => r.name),
    undiscoveredRoles: d.roles.filter((r) => !st.discovered.includes(r.id)).map((r) => `${r.name}(${r.title})`),
    missedArtifacts: d.artifacts.filter((a) => !st.artifacts[a.id]).map((a) => a.title),
    unopenedArtifacts: d.artifacts
      .filter((a) => st.artifacts[a.id] && st.artifacts[a.id]!.openedTurn === undefined)
      .map((a) => a.title),
    truthByCount: [...cats]
      .sort((a, b) => b.count - a.count)
      .map((c) => ({ name: c.name, count: c.count, share: c.count / totalCount })),
    truthByLoss: [...cats]
      .sort((a, b) => b.loss - a.loss)
      .map((c) => ({ name: c.name, loss: c.loss, share: c.loss / totalLoss })),
    successDefinition: d.truth.success_definition,
    expertPath: scn.readText(d.debrief.expert_path),
    // 作者还没写的占位稿不给用户看
    realWorld: realWorld && !realWorld.includes("待作者撰写") ? realWorld : undefined,
    actions: nextActions(scn, st, score),
    shareCard: {
      total: score.total,
      badges: score.badges,
      line: `${score.band}${st.ledger.length ? `,被记了 ${st.ledger.length} 笔账` : ""}`,
    },
    npcInconsistencies: judge.npc_inconsistencies,
    judgeIssues,
  };
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
const wan = (v: number) => (v >= 10000 ? `${Math.round(v / 100) / 100} 万` : `${v} 元`);

function quote(st: SessionState, ref: string): string {
  const l = st.transcript.find((x) => x.ref === ref);
  if (!l) return st.judgment?.[ref] ?? "";
  return l.text.length > 30 ? `${l.text.slice(0, 30)}…` : l.text;
}

export function renderDebriefMarkdown(data: DebriefData, st: SessionState): string {
  const lines: string[] = [];
  lines.push(`# 复盘:${data.title}`, "");
  lines.push("## 结论", "");
  lines.push(`**${data.total} 分 · ${data.band}**${data.badges.length ? ` · 标记:${data.badges.join("、")}` : ""}`, "");
  lines.push("| 维度 | 得分 | 说明 |", "|---|---|---|");
  for (const d of data.dimensions) lines.push(`| ${d.id} ${d.name} | ${d.score} / ${d.max} | ${d.details.join(";")} |`);
  if (data.caps.length) lines.push("", `触发封顶规则:${data.caps.join("、")}`);
  lines.push("");

  lines.push("## 关键时刻", "");
  if (!data.keyMoments.length) lines.push("(裁判没有给出关键时刻)");
  for (const k of data.keyMoments) {
    lines.push(`- **${k.turn}** ${k.type === "good" ? "✓" : "✗"} 「${quote(st, k.turn)}」——${k.what}`);
    lines.push(`  - 当时已知:${k.knew || "—"};当时未知:${k.did_not_know || "—"}`);
  }
  lines.push("");

  lines.push("## 承诺账本", "");
  if (!data.ledger.length) lines.push("你没有给出坚决的工期、报价或准确率承诺。");
  for (const e of data.ledger) {
    const known = e.knownAtThatTime.artifactsOpened.length ? `已看资料 ${e.knownAtThatTime.artifactsOpened.join("、")}` : "还没看任何资料";
    lines.push(
      `- 第 ${e.turn} 轮 · ${e.type}:「${e.valueText}」${e.premature ? "(过早)" : ""}${e.retractedTurn ? `,第 ${e.retractedTurn} 轮收回` : ""}。当时${known}。${e.recalled ? "汇报时周总把它原话拿了出来。" : ""}`,
    );
  }
  lines.push("");

  lines.push("## 你没见的人、没拿到的资料", "");
  if (data.unmetRoles.length) lines.push(`- 知道但没去谈的人:${data.unmetRoles.join("、")}`);
  if (data.undiscoveredRoles.length) lines.push(`- 没有发现的人:${data.undiscoveredRoles.join("、")}`);
  if (data.missedArtifacts.length) lines.push(`- 没拿到的资料:${data.missedArtifacts.join("、")}`);
  if (data.unopenedArtifacts.length) lines.push(`- 拿到但没看的资料:${data.unopenedArtifacts.join("、")}`);
  lines.push("");

  lines.push("## 真相", "");
  if (data.truthByCount.length) {
    lines.push("按件数:", "");
    for (const c of data.truthByCount) lines.push(`- ${c.name}:${c.count} 件(${pct(c.share)})`);
    lines.push("", "按金额:", "");
    for (const c of data.truthByLoss) lines.push(`- ${c.name}:${wan(c.loss)}(${pct(c.share)})`);
    lines.push("");
  }
  lines.push("老板真正要的:", "", ...data.successDefinition.map((s) => `- ${s}`), "");

  if (data.expertPath) lines.push("## 参考路径", "", data.expertPath.trim(), "");

  lines.push("## 下次直接照做", "", ...data.actions.map((a, i) => `${i + 1}. ${a}`), "");
  if (data.realWorld) lines.push("## 现实对照", "", data.realWorld.trim(), "");
  lines.push("---", AI_NOTICE);
  return lines.join("\n");
}

/** 附录 C:复盘撰写提示词。模型只润色,不改分数、不新增事实。 */
export function buildDebriefPrompt(data: DebriefData, st: SessionState): ChatMessage[] {
  const fixed = `你是一位带过很多新人的资深 FDE,在给一次模拟写复盘。语气直接、具体,不客套,不贬低。

【你会收到】
- 程序算好的各维度得分、扣分项、触发的封顶规则
- 核对员输出的证据(主张、对照项判定、关键时刻)
- 承诺账本
- 用户没见的人、没拿到的资料
- 真相摘要和参考路径(预先写好的文稿)

【要求】
1. 所有判断必须来自输入。不新增事实,不改分数,不猜测用户的动机。
2. 第一句话就是结论。
3. "关键时刻"逐条写:引用用户原话(不超过 30 个字),说明当时已知和未知,给一句"换成这样说"的改写。
4. "承诺账本"原样列出,标明哪些是过早的,以及周总后来怎么用了它。
5. "没见的人、没拿到的资料"只列事实,不责备。
6. "真相"用数字说话:按件数排一次,按金额排一次,再写老板真正要的是什么。
7. 最后给 3 条下次可以直接照做的动作,每条不超过 25 个字。
8. 不写"总的来说""希望对你有帮助"之类的话。全文 600 到 900 字。
9. 文末单独一行:${AI_NOTICE}

【输出结构】
## 结论
## 关键时刻
## 承诺账本
## 你没见的人、没拿到的资料
## 真相
## 下次直接照做`;
  const input = {
    scores: { total: data.total, band: data.band, dimensions: data.dimensions, caps: data.caps, badges: data.badges },
    evidence: {
      claims: data.claims,
      T: data.verdicts.T,
      S: data.verdicts.S,
      W: data.verdicts.W,
      key_moments: data.keyMoments.map((k) => ({ ...k, quote: quote(st, k.turn) })),
    },
    ledger: data.ledger,
    fog: {
      unmet: data.unmetRoles,
      undiscovered: data.undiscoveredRoles,
      missed: data.missedArtifacts,
      unopened: data.unopenedArtifacts,
    },
    truth_summary: { by_count: data.truthByCount, by_loss: data.truthByLoss, success_definition: data.successDefinition },
    expert_path: data.expertPath ?? "",
    suggested_actions: data.actions,
  };
  return [
    { role: "system", content: fixed },
    { role: "user", content: `【输入】\n${JSON.stringify(input, null, 2)}` },
  ];
}
