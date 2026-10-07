// 脚本化玩家的格式。每一步是一句话或一个按钮动作;说话那一步附上"标准答案"闸门标注,
// 离线模式直接把它喂给导演(确定性地测导演、算分),在线模式用来对照真闸门的命中情况。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ACTS, gateOutput, Grade, Verdict, type GateOutput } from "@fde/engine";

const GateShort = z.strictObject({
  t: z.array(z.string()).optional(),
  acts: z.array(z.string()).optional(),
  tags: z.array(z.enum(["open", "quantifying", "follow_up", "leading", "evidence_ask"])).optional(),
  bundled: z.number().int().positive().optional(),
  commit: z
    .array(z.strictObject({ type: z.enum(["time", "price", "accuracy", "scope"]), text: z.string(), firm: z.boolean().default(true) }))
    .optional(),
  retract: z.array(z.enum(["time", "price", "accuracy", "scope"])).optional(),
  trust: z.array(z.string().regex(/^[+-]/)).optional(),
  meta: z.boolean().optional(),
  target: z.string().optional(),
});
export type GateShort = z.infer<typeof GateShort>;

const Check = z.strictObject({
  directive: z.string().optional(),
  beat: z.boolean().optional(),
  trap: z.string().optional(),
  reveals: z.array(z.string()).optional(),
  obtained: z.array(z.string()).optional(),
  discovered: z.array(z.string()).optional(),
  phase: z.string().optional(),
  system_includes: z.string().optional(),
  minutes_used: z.number().optional(),
  /** 这一步之后某个角色的信任至少 / 至多是多少(对抗集里"刘姐信任你之后""信任为 0"这类前提)。 */
  trust_min: z.record(z.string(), z.number()).optional(),
  trust_max: z.record(z.string(), z.number()).optional(),
});
export type Check = z.infer<typeof Check>;

export const Step = z.union([
  z.strictObject({ say: z.string(), gate: GateShort.optional(), check: Check.optional() }),
  z.strictObject({ switch: z.string(), check: Check.optional() }),
  z.strictObject({ open: z.string(), check: Check.optional() }),
  z.strictObject({ action: z.string(), check: Check.optional() }),
  z.strictObject({ experiment: z.string(), check: Check.optional() }),
  z.strictObject({ judgment: z.record(z.string(), z.string()), check: Check.optional() }),
  z.strictObject({ end: z.literal(true) }),
]);
export type Step = z.infer<typeof Step>;

const Refs = z.array(z.string());
const FixtureJudgeSchema = z
  .strictObject({
    claims: z.array(z.strictObject({ text: z.string(), source: z.string() })),
    T: z.array(
      z.strictObject({ id: z.string(), verdict: Verdict, evidence: Refs, grade: Grade.optional(), note: z.string().default("") }),
    ),
    S: z.array(z.strictObject({ id: z.string(), mentioned_in_judgment: z.boolean(), evidence: Refs })),
    W: z.array(z.strictObject({ id: z.string(), met: z.boolean(), evidence: Refs })),
    key_moments: z.array(
      z.strictObject({ turn: z.string(), type: z.enum(["good", "bad"]), what: z.string(), knew: z.string(), did_not_know: z.string() }),
    ),
    npc_inconsistencies: z.array(z.strictObject({ turn: z.string(), issue: z.string() })),
  })
  .partial();

const Player = z.strictObject({
  id: z.string(),
  persona: z.string().optional(),
  steps: z.array(Step).min(1),
  /** 离线模式下裁判的固定输出;在线模式忽略。手写的,所以用严格模式:拼错的键、值都直接报错。 */
  judge: FixtureJudgeSchema.optional(),
  /** 在 scenario.yaml 的 evals[].expect 之外追加的断言。 */
  expect: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
});
export type Player = z.infer<typeof Player>;

export function loadPlayers(dir: string): Player[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const r = Player.safeParse(parse(readFileSync(join(dir, f), "utf8")));
      if (!r.success) {
        throw new Error(`${f}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      return r.data;
    });
}

/** 脚本自身的错误(触发器 id、acts、角色写错)要直接报出来,不能悄悄变成"什么都没命中"。 */
export function lintPlayer(p: Player, known: { triggers: Set<string>; roles: Set<string>; artifacts: Set<string>; experiments: Set<string>; actions: Set<string> }): string[] {
  const errs: string[] = [];
  p.steps.forEach((s, i) => {
    const at = `#${i + 1}`;
    if ("say" in s && s.gate) {
      for (const id of s.gate.t ?? []) if (!known.triggers.has(id)) errs.push(`${at} 未知触发器 ${id}`);
      for (const a of s.gate.acts ?? []) if (!(ACTS as readonly string[]).includes(a)) errs.push(`${at} 未知 act ${a}`);
      if (s.gate.target && !known.roles.has(s.gate.target)) errs.push(`${at} 未知角色 ${s.gate.target}`);
    }
    if ("switch" in s && !known.roles.has(s.switch)) errs.push(`${at} 未知角色 ${s.switch}`);
    if ("open" in s && !known.artifacts.has(s.open)) errs.push(`${at} 未知资料 ${s.open}`);
    if ("experiment" in s && !known.experiments.has(s.experiment)) errs.push(`${at} 未知验证 ${s.experiment}`);
    if ("action" in s && !known.actions.has(s.action)) errs.push(`${at} 未知动作 ${s.action}`);
    if ("check" in s && s.check) {
      for (const r of [...Object.keys(s.check.trust_min ?? {}), ...Object.keys(s.check.trust_max ?? {})]) {
        if (!known.roles.has(r)) errs.push(`${at} 信任断言里的未知角色 ${r}`);
      }
    }
  });
  return errs;
}

export function expandGate(g: GateShort | undefined): GateOutput {
  const tags = new Set(g?.tags ?? []);
  return gateOutput({
    target_role: g?.target ?? null,
    acts: (g?.acts ?? ["ask"]) as GateOutput["acts"],
    matched_triggers: (g?.t ?? []).map((id) => ({ id, confidence: 0.9 })),
    question_tags: {
      open: tags.has("open"),
      quantifying: tags.has("quantifying"),
      follow_up: tags.has("follow_up"),
      leading: tags.has("leading"),
      evidence_ask: tags.has("evidence_ask"),
      bundled_count: g?.bundled ?? 1,
    },
    commitments: (g?.commit ?? []).map((c) => ({ type: c.type, value_text: c.text, firm: c.firm })),
    retracts: g?.retract ?? [],
    trust_moves: (g?.trust ?? []).map((s) => ({ dir: s.startsWith("+") ? "plus" : "minus", what: s.slice(1) })),
    meta_or_injection: g?.meta ?? false,
  });
}
