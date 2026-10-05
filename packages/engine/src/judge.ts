// 裁判(附录 B):只抽证据,不打分。程序拿到 JSON 后先校验再算分。
import { z } from "zod";
import type { LoadedScenario } from "./scenario/load.ts";
import type { ChatMessage } from "./ports.ts";
import type { SessionState } from "./types.ts";

export const Verdict = z.enum(["hit", "partial", "miss", "contradict"]);
export const Grade = z.enum(["A", "B", "C", "D"]);

const Refs = z.array(z.string()).catch([]);

export const JudgeOutputSchema = z.object({
  claims: z.array(z.object({ text: z.string(), source: z.string().catch("") })).catch([]),
  T: z
    .array(
      z.object({
        id: z.string(),
        verdict: Verdict.catch("miss"),
        evidence: Refs,
        grade: Grade.optional().catch(undefined),
        note: z.string().catch(""),
      }),
    )
    .catch([]),
  S: z.array(z.object({ id: z.string(), mentioned_in_judgment: z.boolean().catch(false), evidence: Refs })).catch([]),
  W: z.array(z.object({ id: z.string(), met: z.boolean().catch(false), evidence: Refs })).catch([]),
  key_moments: z
    .array(
      z.object({
        turn: z.string(),
        type: z.enum(["good", "bad"]).catch("bad"),
        what: z.string().catch(""),
        knew: z.string().catch(""),
        did_not_know: z.string().catch(""),
      }),
    )
    .catch([]),
  npc_inconsistencies: z.array(z.object({ turn: z.string(), issue: z.string().catch("") })).catch([]),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

/** D5 用到的成功定义类事实(d5_points 里点名的,以及 any_of_X_Y_each 里的)。 */
export function successFactIds(scn: LoadedScenario): string[] {
  const ids: string[] = [];
  for (const k of Object.keys(scn.data.rubric.d5_points)) {
    const m = k.match(/^any_of_(.+)_each$/);
    if (m) ids.push(...m[1]!.split("_"));
    else ids.push(k);
  }
  return ids.filter((id) => scn.facts.has(id));
}

export function transcriptForJudge(scn: LoadedScenario, st: SessionState): string {
  return st.transcript
    .map((l) => {
      const who =
        l.speaker === "user"
          ? `用户→${scn.roles.get(l.roleId ?? "")?.name ?? "?"}`
          : l.speaker === "npc"
            ? (scn.roles.get(l.roleId ?? "")?.name ?? "角色")
            : "旁白";
      return `${l.ref} [第${l.turn}轮·${l.phase}] ${who}:${l.text}`;
    })
    .join("\n");
}

export function eventLogForJudge(scn: LoadedScenario, st: SessionState): string {
  const lines: string[] = [];
  for (const e of st.events) {
    const p = e.payload;
    switch (e.type) {
      case "unlock":
        lines.push(`第${e.turn}轮 解锁事实 ${p.fact}@${p.level}(来源 ${p.source})`);
        break;
      case "artifact_obtain":
        lines.push(`第${e.turn}轮 拿到资料 ${p.artifact} ${scn.artifacts.get(String(p.artifact))?.title ?? ""}`);
        break;
      case "artifact_open":
        lines.push(`第${e.turn}轮 打开资料 ${p.artifact} ${scn.artifacts.get(String(p.artifact))?.title ?? ""}`);
        break;
      case "experiment":
        lines.push(`第${e.turn}轮 做了验证 ${p.experiment}:${scn.experiments.get(String(p.experiment))?.result ?? ""}`);
        break;
      case "action":
        lines.push(`第${e.turn}轮 动作 ${p.action}`);
        break;
      case "commitment":
        lines.push(`第${e.turn}轮 承诺 ${p.type}:${p.valueText}${p.premature ? "(过早)" : ""}`);
        break;
      case "retraction":
        lines.push(`第${e.turn}轮 收回承诺 ${p.ledger}`);
        break;
      case "trap":
        lines.push(`第${e.turn}轮 压力时刻 ${p.trap}(${p.by})`);
        break;
      case "auth_grant":
        lines.push(`第${e.turn}轮 获得授权 ${p.flag}`);
        break;
      case "trust_change":
        lines.push(`第${e.turn}轮 ${p.role} 信任 ${p.from}→${p.to}`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n") || "无";
}

export function judgmentForJudge(scn: LoadedScenario, st: SessionState): string {
  if (!st.judgment) return "(用户没有提交判断)";
  return scn.data.judgment_form.map((f) => `${f.id}(${f.label}):${st.judgment?.[f.id] || "(空)"}`).join("\n");
}

export function buildJudgePrompt(scn: LoadedScenario, st: SessionState): ChatMessage[] {
  const d = scn.data;
  const fixed = `你是训练模拟的记录核对员。你的任务是从对话记录里找证据。你不打分,不鼓励,不安慰。
分数由程序根据你的输出计算。

【你会收到】
1. 带编号的完整对话(U1、U2…是用户,N1、N2…是角色,S1、S2…是旁白)
2. 事件日志:解锁了哪些事实、打开了哪些资料、做了哪些验证、承诺账本
3. 用户提交的判断(J1 到 J5)
4. 对照项:T 项(诊断)、S 项(成功定义)、W 项(方案检查)

【规则】
1. 每个判定都要引用编号(如 U17、J1)作为证据。找不到证据就判 miss。不要替用户补全他没说出口的意思。
2. 用户只是复述了老板的原话(例如"问题是单据识别"),不算命中任何 T 项。
3. 对每个命中或部分命中的 T 项给证据等级:
   A = 事件日志里有对应的资料或验证结果,且用户在判断里引用了它
   B = 至少两个角色的说法一致
   C = 只有一个角色这样说
   D = 用户自己的推测,没有任何来源
4. 用户的结论与对照项相反,判 contradict。
5. W 项逐条回答是或否,并引用 J4 中的原文。含糊的表述(如"会定一些指标")判否。
6. 关键时刻选 3 到 6 个,好的和坏的都要有。每个都要根据事件日志写明:那一刻用户已经知道什么、还不知道什么。
7. 如果某个角色说了对照表里没有的数字或事实,或者与对照表矛盾,记入 npc_inconsistencies。这不影响用户。
8. 不要输出任何分数、等级或总体评价。

【输出】只输出 JSON:
{
  "claims": [{"text": "用户的一条主张", "source": "J1"}],
  "T": [{"id": "T1", "verdict": "hit|partial|miss|contradict", "evidence": ["J1", "U23"], "grade": "A|B|C|D", "note": "一句话理由"}],
  "S": [{"id": "S1", "mentioned_in_judgment": true, "evidence": ["J3"]}],
  "W": [{"id": "W1", "met": true, "evidence": ["J4"]}],
  "key_moments": [{"turn": "U3", "type": "good|bad", "what": "发生了什么", "knew": "当时已知", "did_not_know": "当时未知"}],
  "npc_inconsistencies": [{"turn": "N12", "issue": "说明"}]
}

【对照项】
${d.truth.diagnosis_items.map((t) => `${t.id}(权重 ${t.weight}):${t.statement}`).join("\n")}
${successFactIds(scn)
  .map((id) => `${id}:${scn.fact(id).statement}`)
  .join("\n")}
${d.rubric.d7_checklist.map((w) => `${w.id}:${w.item}`).join("\n")}`;

  const dynamic = `【事件日志】
${eventLogForJudge(scn, st)}

【对话】
${transcriptForJudge(scn, st)}

【用户的判断】
${judgmentForJudge(scn, st)}`;
  return [
    { role: "system", content: fixed },
    { role: "user", content: dynamic },
  ];
}

// ---------------- 校验:编号存在、内容出自用户、A 级证据有记录;不过的按 miss ----------------

export interface CheckedJudge {
  output: JudgeOutput;
  issues: string[];
}

export function checkJudgeOutput(scn: LoadedScenario, st: SessionState, raw: unknown): CheckedJudge {
  const issues: string[] = [];
  const parsed = JudgeOutputSchema.safeParse(raw);
  if (!parsed.success) issues.push(`裁判输出结构不对:${parsed.error.issues[0]?.message ?? ""}`);
  const out: JudgeOutput = parsed.success
    ? parsed.data
    : { claims: [], T: [], S: [], W: [], key_moments: [], npc_inconsistencies: [] };

  const refs = new Set(st.transcript.map((l) => l.ref));
  const jRefs = new Set(Object.entries(st.judgment ?? {}).filter(([, v]) => v).map(([k]) => k));
  const isUserRef = (r: string) => (r.startsWith("U") && refs.has(r)) || jRefs.has(r);
  const validRef = (r: string) => refs.has(r) || jRefs.has(r);

  const supported = new Set<string>();
  for (const [aid, a] of Object.entries(st.artifacts)) {
    if (a.openedTurn === undefined) continue;
    for (const t of scn.artifacts.get(aid)?.supports ?? []) supported.add(t);
  }
  for (const xid of Object.keys(st.experiments)) for (const t of scn.experiments.get(xid)?.supports ?? []) supported.add(t);

  const T: JudgeOutput["T"] = [];
  for (const item of scn.data.truth.diagnosis_items) {
    const got = out.T.find((t) => t.id === item.id);
    if (!got) {
      T.push({ id: item.id, verdict: "miss", evidence: [], note: "裁判未给出" });
      continue;
    }
    const evidence = got.evidence.filter(validRef);
    if (got.verdict !== "miss") {
      if (!evidence.some(isUserRef)) {
        issues.push(`${item.id}:没有出自用户的有效引用,按 miss`);
        T.push({ ...got, verdict: "miss", evidence });
        continue;
      }
      if (got.grade === "A" && !supported.has(item.id)) {
        issues.push(`${item.id}:标了 A 级,但事件日志里没有支持它的资料或验证,按 miss`);
        T.push({ ...got, verdict: "miss", evidence });
        continue;
      }
      if (got.verdict !== "contradict" && !got.grade) {
        issues.push(`${item.id}:命中但没给证据等级,按 D`);
        T.push({ ...got, grade: "D", evidence });
        continue;
      }
    }
    T.push({ ...got, evidence });
  }

  const S = successFactIds(scn).map((id) => {
    const got = out.S.find((s) => s.id === id);
    const evidence = (got?.evidence ?? []).filter((r) => jRefs.has(r));
    const ok = Boolean(got?.mentioned_in_judgment) && evidence.length > 0;
    if (got?.mentioned_in_judgment && !ok) issues.push(`${id}:说写进了判断,但没有有效的 J 引用`);
    return { id, mentioned_in_judgment: ok, evidence };
  });

  const W = scn.data.rubric.d7_checklist.map((w) => {
    const got = out.W.find((x) => x.id === w.id);
    const evidence = (got?.evidence ?? []).filter((r) => jRefs.has(r));
    const ok = Boolean(got?.met) && evidence.length > 0;
    if (got?.met && !ok) issues.push(`${w.id}:判为满足,但没有有效的 J 引用`);
    return { id: w.id, met: ok, evidence };
  });

  const key_moments = out.key_moments.filter((k) => {
    const ok = validRef(k.turn);
    if (!ok) issues.push(`关键时刻引用了不存在的编号 ${k.turn}`);
    return ok;
  });

  return { output: { ...out, T, S, W, key_moments }, issues };
}

/** 没有裁判时(用户没交判断就收工)的空结果。 */
export function emptyJudge(scn: LoadedScenario): JudgeOutput {
  return {
    claims: [],
    T: scn.data.truth.diagnosis_items.map((t) => ({ id: t.id, verdict: "miss", evidence: [], note: "" })),
    S: successFactIds(scn).map((id) => ({ id, mentioned_in_judgment: false, evidence: [] })),
    W: scn.data.rubric.d7_checklist.map((w) => ({ id: w.id, met: false, evidence: [] })),
    key_moments: [],
    npc_inconsistencies: [],
  };
}
