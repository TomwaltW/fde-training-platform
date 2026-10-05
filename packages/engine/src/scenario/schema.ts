// 场景 YAML 的结构定义。
// 所有对象都用 strictObject:出现未定义的键直接报错。
// 这是为了拦住 YAML 花括号写法里"值含逗号被悄悄截成两段"的问题(方案 3.5.1)。
import { z } from "zod";

const Id = z.string().min(1);
const IdList = z.array(Id);

export const LEVELS = ["L1", "L2", "L3"] as const;
export const Level = z.enum(LEVELS);
export type Level = z.infer<typeof Level>;

export const levelRank = (l: Level): number => LEVELS.indexOf(l) + 1;

// 前提条件:字符串表达式,或 {any: [...]} / {all: [...]},或它们组成的数组(数组 = 全部满足)。
export type Requirement = string | { any: Requirement[] } | { all: Requirement[] } | Requirement[];
export const Requirement: z.ZodType<Requirement> = z.lazy(() =>
  z.union([
    z.string().min(1),
    z.strictObject({ any: z.array(Requirement) }),
    z.strictObject({ all: z.array(Requirement) }),
    z.array(Requirement),
  ]),
);

export const DIRECTIVES = [
  "pocket",
  "push_back",
  "impatient",
  "guarded",
  "deflect",
  "cooperative",
  "test_user",
  "beat",
  "neutral",
  "confused",
] as const;
export const Stance = z.enum(DIRECTIVES);
export type Stance = z.infer<typeof Stance>;

const Meta = z.strictObject({
  id: Id,
  title: z.string(),
  skill_focus: z.array(z.string()),
  difficulty: z.number().int().min(1).max(5),
  est_minutes: z.number().int().positive(),
  variant: Id,
  disclaimer: z.string(),
});

const Briefing = z.strictObject({
  you_are: z.string(),
  company: z.string(),
  opening: z.strictObject({ speaker: Id, text: z.string() }),
  goal: z.string(),
  rules_shown: z.array(z.string()),
});

const ErrorCategory = z.strictObject({
  id: Id,
  name: z.string(),
  count: z.number().int().nonnegative(),
  loss: z.number().nonnegative(),
});

const DiagnosisItem = z.strictObject({
  id: Id,
  weight: z.number().positive(),
  statement: z.string(),
});

// truth 里除 diagnosis_items 外都是场景特有的数据;这里把场景一用到的字段列全,
// 新场景要加字段时先在这里登记(仍然保持 strict)。
const Truth = z.strictObject({
  period: z.string().optional(),
  error_log_total: z.number().int().optional(),
  error_categories: z.array(ErrorCategory).optional(),
  loss_total: z.number().optional(),
  intake_formats: z.record(z.string(), z.number().int()).optional(),
  key_customer: z
    .strictObject({
      name: z.string(),
      revenue_share: z.number(),
      hs_cases: z.number().int(),
      hs_loss: z.number(),
    })
    .optional(),
  success_definition: z.array(z.string()),
  diagnosis_items: z.array(DiagnosisItem).min(1),
});

const Discovered = z.union([
  z.literal("start"),
  z.strictObject({
    by_role: IdList.optional(),
    by_action: IdList.optional(),
    by_ask: z.string().optional(),
  }),
]);

const Role = z.strictObject({
  id: Id,
  name: z.string(),
  title: z.string(),
  discovered: Discovered,
  persona: z.string(),
  goals: z.array(z.string()),
  blind_spot: z.string().optional(),
  agenda: z.array(z.string()),
  on_commitment: Stance.optional(),
  redirects: z.record(z.string(), Id),
  time_cost_min: z.number().int().positive(),
  caps: z
    .strictObject({
      kickoff_exchanges: z.number().int().positive().optional(),
      report_exchanges: z.number().int().positive().optional(),
    })
    .optional(),
  trust: z.strictObject({ initial: z.number().int(), max: z.number().int() }).optional(),
});
export type Role = z.infer<typeof Role>;

const Flag = z.strictObject({ desc: z.string(), granted_by: Id.optional() });

const RoleUnlock = z.strictObject({
  role: Id,
  level: Level,
  ask: z.string().optional(),
  say: z.string().optional(),
  requires: Requirement.optional(),
  gives: Id.optional(),
  volunteered: z.boolean().optional(),
});
const ViaUnlock = z.strictObject({
  via: Id,
  level: Level,
  gives: Id.optional(),
});
export const UnlockRule = z.union([RoleUnlock, ViaUnlock]);
export type RoleUnlock = z.infer<typeof RoleUnlock>;
export type ViaUnlock = z.infer<typeof ViaUnlock>;
export type UnlockRule = z.infer<typeof UnlockRule>;
export const isViaUnlock = (u: UnlockRule): u is ViaUnlock => "via" in u;

export const FACT_CATS = ["success", "problem", "cost", "constraint", "red_herring"] as const;
const Fact = z.strictObject({
  id: Id,
  cat: z.enum(FACT_CATS),
  weight: z.number().nonnegative(),
  key: z.boolean().optional(),
  statement: z.string(),
  canaries: z.array(z.string()).optional(),
  unlock: z.array(UnlockRule).min(1),
});
export type Fact = z.infer<typeof Fact>;

const Artifact = z.strictObject({
  id: Id,
  title: z.string(),
  holder: Id,
  files: z.string(),
  unlock: z.strictObject({ ask: z.string(), requires: Requirement.optional() }).optional(),
  review_cost_min: z.number().int().nonnegative(),
  supports: IdList.optional(),
  clues: z.array(z.string()).optional(),
  columns: z.array(z.string()).optional(),
});
export type Artifact = z.infer<typeof Artifact>;

const Action = z.strictObject({
  title: z.string(),
  cost_min: z.number().int().nonnegative(),
  requires: Requirement.optional(),
  narrative: z.string().optional(),
  effects: z.array(z.string()),
});
export type Action = z.infer<typeof Action>;

const Experiment = z.strictObject({
  id: Id,
  title: z.string(),
  requires: Requirement.optional(),
  result: z.string(),
  supports: IdList,
});
export type Experiment = z.infer<typeof Experiment>;

const Trap = z.strictObject({
  id: Id,
  by: Id,
  when: z.string(),
  beat: z.string(),
  good: z.string().optional(),
  bad: z.string().optional(),
  after: IdList.optional(),
  sets: IdList.optional(),
  discover: IdList.optional(),
  reveal: Id.optional(),
  /** 触发时角色的态度(不填则由导演按常规规则决定)。 */
  stance: Stance.optional(),
});
export type Trap = z.infer<typeof Trap>;

const Budget = z.strictObject({
  discovery_minutes: z.number().int().positive(),
  switch_person_min: z.number().int().nonnegative(),
  experiment_min: z.number().int().nonnegative(),
  on_exhausted: z.string(),
  expert_path_minutes: z.number().int().positive(),
});

export const PHASES = ["kickoff", "discovery", "judgment", "report", "debrief"] as const;
export const Phase = z.enum(PHASES);
export type Phase = z.infer<typeof Phase>;

const JudgmentField = z.strictObject({ id: Id, label: z.string() });

const Dimension = z.strictObject({
  id: Id,
  name: z.string(),
  max: z.number().positive(),
  method: z.string(),
});

const Points = z.record(z.string(), z.number());

const Cap = z.strictObject({
  if: z.string(),
  label: z.string(),
  total_max: z.number().optional(),
  set: z.record(z.string(), z.number()).optional(),
  badge: z.string().optional(),
});

const Rubric = z.strictObject({
  full_credit_ratio: z.number().positive().max(1),
  d1_min_level: Level,
  dimensions: z.array(Dimension),
  d2_points: Points,
  d3_points: Points,
  d4_rules: z.strictObject({
    hit: z.number(),
    partial: z.number(),
    miss: z.number(),
    contradict: z.number(),
    grade_D_multiplier: z.number(),
  }),
  d5_points: Points,
  d6_penalties: z.strictObject({
    premature_time: z.number(),
    premature_price: z.number(),
    accuracy_guarantee: z.number(),
    premature_solution: z.number(),
  }),
  d6_recover_per_retraction: z.number(),
  d7_checklist: z.array(z.strictObject({ id: Id, points: z.number(), item: z.string() })),
  premature_until: z.array(Requirement),
  caps: z.array(Cap),
});
export type Rubric = z.infer<typeof Rubric>;

const Debrief = z.strictObject({
  reveal: z.array(z.string()),
  expert_path: z.string(),
  real_world_note: z.string().optional(),
});

const Variant = z.strictObject({
  summary: z.string(),
  overlay: z.record(z.string(), z.unknown()).optional(),
});

const EvalSpec = z.strictObject({
  id: Id,
  persona: z.string(),
  expect: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
});
export type EvalSpec = z.infer<typeof EvalSpec>;

export const ScenarioSchema = z.strictObject({
  schema_version: z.union([z.number(), z.string()]),
  meta: Meta,
  briefing: Briefing,
  world_public: z.array(z.string()),
  truth: Truth,
  roles: z.array(Role).min(1),
  flags: z.record(z.string(), Flag),
  trust_moves: z.strictObject({ plus: z.array(z.string()), minus: z.array(z.string()) }),
  facts: z.array(Fact).min(1),
  artifacts: z.array(Artifact),
  actions: z.record(z.string(), Action),
  experiments: z.array(Experiment),
  traps: z.array(Trap),
  budget: Budget,
  phases: z.array(Phase),
  judgment_form: z.array(JudgmentField).min(1),
  rubric: Rubric,
  debrief: Debrief,
  variants: z.record(z.string(), Variant).optional(),
  evals: z.array(EvalSpec).optional(),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
