import type { LoadedScenario } from "./scenario/load.ts";
import { levelRank, type Level, type Phase } from "./scenario/schema.ts";
import type { Resolver, Value } from "./expr.ts";
import type { EventType, SessionState, TranscriptLine } from "./types.ts";

export function createSession(scn: LoadedScenario, opts: { sessionId: string }): SessionState {
  const d = scn.data;
  const trust: Record<string, number> = {};
  for (const r of d.roles) if (r.trust) trust[r.id] = r.trust.initial;
  const flags: Record<string, boolean> = {};
  for (const f of Object.keys(d.flags)) flags[f] = false;

  const st: SessionState = {
    version: 1,
    sessionId: opts.sessionId,
    scenarioId: d.meta.id,
    variant: scn.variant,
    phase: d.phases[0] ?? "kickoff",
    turn: 0,
    minutesUsed: 0,
    currentRole: d.briefing.opening.speaker,
    discovered: d.roles.filter((r) => r.discovered === "start").map((r) => r.id),
    exchanges: {},
    phaseExchanges: {},
    trust,
    trustPlusUsed: {},
    flags,
    facts: {},
    roleTold: {},
    artifacts: {},
    experiments: {},
    actionsDone: {},
    traps: {},
    ledger: [],
    transcript: [],
    turns: [],
    events: [],
    ledgerRecalled: false,
  };
  addLine(st, "npc", d.briefing.opening.text, d.briefing.opening.speaker);
  return st;
}

export function minutesLeft(st: SessionState, scn: LoadedScenario): number {
  return scn.data.budget.discovery_minutes - st.minutesUsed;
}

export function addEvent(st: SessionState, type: EventType, payload: Record<string, unknown> = {}) {
  st.events.push({ turn: st.turn, type, payload });
}

export function addLine(st: SessionState, speaker: TranscriptLine["speaker"], text: string, roleId?: string): TranscriptLine {
  const prefix = speaker === "user" ? "U" : speaker === "npc" ? "N" : "S";
  const n = st.transcript.filter((l) => l.speaker === speaker).length + 1;
  const line: TranscriptLine = { ref: `${prefix}${n}`, turn: st.turn, speaker, text, phase: st.phase };
  if (roleId) line.roleId = roleId;
  st.transcript.push(line);
  return line;
}

export function setPhase(st: SessionState, phase: Phase) {
  if (st.phase === phase) return;
  addEvent(st, "phase_change", { from: st.phase, to: phase });
  st.phase = phase;
  st.phaseExchanges = {};
}

export function factLevel(st: SessionState, factId: string): Level | undefined {
  return st.facts[factId]?.level;
}

export function hasFactAtLeast(st: SessionState, factId: string, level: Level): boolean {
  const l = factLevel(st, factId);
  return l !== undefined && levelRank(l) >= levelRank(level);
}

export function knownSnapshot(st: SessionState) {
  return {
    facts: Object.entries(st.facts).map(([id, f]) => `${id}@${f.level}`),
    artifactsOpened: Object.entries(st.artifacts)
      .filter(([, a]) => a.openedTurn !== undefined)
      .map(([id]) => id),
  };
}

export function rolesTalkedTo(st: SessionState): string[] {
  return Object.entries(st.exchanges)
    .filter(([, n]) => n > 0)
    .map(([r]) => r);
}

/** 表达式求值时的标识符解析(requires、traps.when、premature_until、caps.if)。 */
export function stateResolver(st: SessionState, scn: LoadedScenario): Resolver {
  return {
    get(name: string): Value {
      if (name === "phase") return st.phase;
      const dot = name.indexOf(".");
      if (dot > 0) {
        const ns = name.slice(0, dot);
        const key = name.slice(dot + 1);
        if (ns === "exchanges") return st.exchanges[key] ?? 0;
        if (ns === "trust") return st.trust[key] ?? 0;
        if (ns === "discovered") return st.discovered.includes(key);
        if (ns === "opened") return st.artifacts[key]?.openedTurn !== undefined;
        return undefined;
      }
      if (name in st.flags) return st.flags[name];
      if (scn.facts.has(name)) return st.facts[name] !== undefined;
      if (scn.artifacts.has(name)) return st.artifacts[name] !== undefined;
      if (scn.experiments.has(name)) return st.experiments[name] !== undefined;
      if (name in scn.data.actions) return st.actionsDone[name] !== undefined;
      if (scn.traps.has(name)) return st.traps[name] !== undefined;
      // 评分用的派生量
      if (name === "no_artifact_opened") return knownSnapshot(st).artifactsOpened.length === 0;
      if (name === "committed_before_any_artifact")
        return st.ledger.some(
          (e) => (e.type === "time" || e.type === "price") && e.knownAtThatTime.artifactsOpened.length === 0,
        );
      return undefined;
    },
    call(fn: string, args: string[]) {
      if (fn === "only_talked_to") {
        const talked = rolesTalkedTo(st);
        return talked.length > 0 && talked.every((r) => args.includes(r));
      }
      return undefined;
    },
  };
}

/** 校验器用的标识符清单:哪些名字是合法的。 */
export function knownIdentifiers(scn: LoadedScenario): Set<string> {
  const s = new Set<string>(["phase", "no_artifact_opened", "committed_before_any_artifact"]);
  for (const r of scn.data.roles) {
    s.add(`exchanges.${r.id}`);
    s.add(`trust.${r.id}`);
    s.add(`discovered.${r.id}`);
  }
  for (const a of scn.data.artifacts) s.add(`opened.${a.id}`);
  for (const k of Object.keys(scn.data.flags)) s.add(k);
  for (const k of scn.facts.keys()) s.add(k);
  for (const k of scn.artifacts.keys()) s.add(k);
  for (const k of scn.experiments.keys()) s.add(k);
  for (const k of scn.traps.keys()) s.add(k);
  for (const k of Object.keys(scn.data.actions)) s.add(k);
  return s;
}
