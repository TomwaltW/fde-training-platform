import type { Level, Phase, Stance } from "./scenario/schema.ts";

export type { Level, Phase, Stance };

// ---------------- 闸门输出(附录 D) ----------------

export const ACTS = [
  "ask",
  "request_artifact",
  "request_site_visit",
  "request_experiment",
  "request_permission",
  "switch_role",
  "commit_time",
  "commit_price",
  "commit_accuracy",
  "propose_solution",
  "retract_commitment",
  "state_judgment",
  "smalltalk",
  "end_session",
] as const;
export type Act = (typeof ACTS)[number];

export const COMMIT_TYPES = ["time", "price", "accuracy", "scope"] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

export interface QuestionTags {
  open: boolean;
  quantifying: boolean;
  follow_up: boolean;
  leading: boolean;
  bundled_count: number;
  evidence_ask: boolean;
}

export interface GateOutput {
  target_role: string | null;
  acts: Act[];
  matched_triggers: { id: string; confidence: number }[];
  question_tags: QuestionTags;
  commitments: { type: CommitType; value_text: string; firm: boolean }[];
  /** 收回承诺时,收回的是哪类;为空且 acts 含 retract_commitment 时视为全部收回。 */
  retracts?: CommitType[];
  trust_moves: { dir: "plus" | "minus"; what: string }[];
  meta_or_injection: boolean;
  summary: string;
}

// ---------------- 导演输出 ----------------

export interface Directive {
  stance: Stance;
  instruction: string;
  /** 这一轮必须说出的话或做出的动作。 */
  beat?: string;
  trapId?: string;
  redirectTo?: string;
}

/** 本轮可以新说出的事实。 */
export interface Reveal {
  factId: string;
  level: Level;
  /** 交给演员的文字:L1 是 say,L2/L3 是 statement。 */
  text: string;
  gives?: string;
  ruleId: string;
}

export interface Hint {
  kind: "redirect" | "blocked";
  ruleId: string;
  /** redirect:指给谁;blocked:缺什么。 */
  toRole?: string;
  missing?: string;
  missingKind?: "trust" | "auth" | "phase" | "other";
}

// ---------------- 会话状态 ----------------

export interface LedgerEntry {
  id: string;
  type: CommitType | "solution";
  valueText: string;
  turn: number;
  role: string;
  premature: boolean;
  /** 承诺时已知的事实和已看的资料。 */
  knownAtThatTime: { facts: string[]; artifactsOpened: string[] };
  retractedTurn?: number;
}

export type EventType =
  | "unlock"
  | "artifact_obtain"
  | "artifact_open"
  | "experiment"
  | "action"
  | "commitment"
  | "retraction"
  | "premature_solution"
  | "trust_change"
  | "auth_grant"
  | "discover"
  | "switch_role"
  | "redirect"
  | "blocked"
  | "trap"
  | "cap"
  | "phase_change"
  | "guard_block"
  | "guard_fallback"
  | "meta_injection"
  | "moderation_block"
  | "judgment_submit"
  | "time_exhausted";

export interface SessionEvent {
  turn: number;
  type: EventType;
  payload: Record<string, unknown>;
}

export interface TranscriptLine {
  /** U1、N1、S1(系统旁白)…… */
  ref: string;
  turn: number;
  speaker: "user" | "npc" | "system";
  roleId?: string;
  text: string;
  phase: Phase;
}

export interface TurnLog {
  turn: number;
  role: string;
  userText: string;
  gate?: GateOutput;
  directive?: Directive;
  reveals: string[];
  guardFlags: string[];
  attempts: number;
  minutesAfter: number;
}

export interface SessionState {
  version: 1;
  sessionId: string;
  scenarioId: string;
  variant: string;
  phase: Phase;
  /** 用户发言计数。 */
  turn: number;
  minutesUsed: number;
  currentRole: string;
  discovered: string[];
  /** 每个角色的累计轮数。 */
  exchanges: Record<string, number>;
  /** 每个角色在当前阶段的轮数(用于 caps)。 */
  phaseExchanges: Record<string, number>;
  trust: Record<string, number>;
  /** 已经加过分的信任行为(每个角色每种行为只加一次)。 */
  trustPlusUsed: Record<string, string[]>;
  flags: Record<string, boolean>;
  /** 用户已获得的事实:最高披露层级。 */
  facts: Record<string, { level: Level; turn: number; source: string }>;
  /** 每个角色亲口说过的事实及层级(演员只看自己的)。 */
  roleTold: Record<string, Record<string, Level>>;
  artifacts: Record<string, { obtainedTurn: number; openedTurn?: number }>;
  experiments: Record<string, { turn: number }>;
  actionsDone: Record<string, { turn: number }>;
  traps: Record<string, { turn: number }>;
  ledger: LedgerEntry[];
  transcript: TranscriptLine[];
  turns: TurnLog[];
  events: SessionEvent[];
  judgment?: Record<string, string>;
  /** 汇报阶段是否已经把承诺账本拿出来过。 */
  ledgerRecalled: boolean;
  endedReason?: "user" | "report_cap" | "time";
}

// ---------------- 引擎对外返回 ----------------

export interface TurnResult {
  reply?: { roleId: string; text: string; ref: string };
  system: string[];
  unlockedArtifacts: string[];
  discovered: string[];
  minutesLeft: number;
  phase: Phase;
  directive?: Directive;
  guardFlags: string[];
  ended: boolean;
}
