// 导演:纯代码。管时间、承诺账本、信任与授权、解锁、压力时刻和态度指令(方案 3.3.3、3.3.4)。
// 不调用任何模型;给定闸门输出,结果完全确定,可以回归测试。
import { evalExpr, evalRequirement, isExpression, requirementLeaves } from "./expr.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import { isViaUnlock, levelRank, type Level, type Role, type Trap } from "./scenario/schema.ts";
import {
  addEvent,
  hasFactAtLeast,
  knownSnapshot,
  minutesLeft,
  setPhase,
  stateResolver,
} from "./state.ts";
import { triggers, type Trigger } from "./triggers.ts";
import type { Directive, GateOutput, Hint, LedgerEntry, Reveal, SessionState } from "./types.ts";

export const CONFIDENCE_MIN = 0.6;

export interface TurnPlan {
  /** 本轮由谁来回话;为空表示本轮不需要演员(换人失败、动作、结束等)。 */
  role?: string;
  reveals: Reveal[];
  hints: Hint[];
  directive?: Directive;
  system: string[];
  obtained: string[];
  discovered: string[];
  ended: boolean;
}

const emptyPlan = (): TurnPlan => ({ reveals: [], hints: [], system: [], obtained: [], discovered: [], ended: false });

export const bossRole = (scn: LoadedScenario) => scn.data.briefing.opening.speaker;

// ------------------------------------------------------------------
// 小工具
// ------------------------------------------------------------------

function discover(scn: LoadedScenario, st: SessionState, roleId: string, why: string, plan?: TurnPlan) {
  if (st.discovered.includes(roleId) || !scn.roles.has(roleId)) return;
  st.discovered.push(roleId);
  addEvent(st, "discover", { role: roleId, why });
  plan?.discovered.push(roleId);
}

function obtainArtifact(st: SessionState, artifactId: string, from: string, plan?: TurnPlan) {
  if (st.artifacts[artifactId]) return;
  st.artifacts[artifactId] = { obtainedTurn: st.turn };
  addEvent(st, "artifact_obtain", { artifact: artifactId, from });
  plan?.obtained.push(artifactId);
}

function spend(scn: LoadedScenario, st: SessionState, minutes: number, plan: TurnPlan) {
  if (st.phase === "report" || minutes <= 0) return;
  st.minutesUsed += minutes;
  if (minutesLeft(st, scn) <= 0 && (st.phase === "kickoff" || st.phase === "discovery")) {
    addEvent(st, "time_exhausted", { minutesUsed: st.minutesUsed });
    setPhase(st, "judgment");
    plan.system.push(`时间到了。${scn.data.budget.on_exhausted}。请先提交你的判断。`);
  }
}

function leaveKickoff(st: SessionState) {
  if (st.phase === "kickoff") setPhase(st, "discovery");
}

/** 记一次披露:用户获得事实;若由角色说出,记入该角色"说过的话"。 */
function recordReveal(st: SessionState, factId: string, level: Level, source: string, role?: string) {
  const cur = st.facts[factId];
  if (!cur || levelRank(level) > levelRank(cur.level)) {
    st.facts[factId] = { level, turn: st.turn, source };
    addEvent(st, "unlock", { fact: factId, level, source });
  }
  if (role) {
    const told = (st.roleTold[role] ??= {});
    const prev = told[factId];
    if (!prev || levelRank(level) > levelRank(prev)) told[factId] = level;
  }
}

/** 不经对话的解锁(看资料、现场、验证):应用所有 via == source 的规则。 */
function applyVia(scn: LoadedScenario, st: SessionState, source: string, plan: TurnPlan) {
  for (const f of scn.data.facts) {
    for (const u of f.unlock) {
      if (!isViaUnlock(u) || u.via !== source) continue;
      recordReveal(st, f.id, u.level, `via:${source}`);
      if (u.gives) obtainArtifact(st, u.gives, source, plan);
    }
  }
}

/** 被问到的事归别人管时,该指给谁:先看自己的指路表,再看指路表里的人能否转介,最后看已认识的人。 */
export function redirectTarget(scn: LoadedScenario, st: SessionState, from: string, to: string): string | undefined {
  if (from === to) return undefined;
  const mine = new Set(Object.values(scn.role(from).redirects));
  if (mine.has(to)) return to;
  for (const m of mine) {
    if (m !== from && scn.roles.has(m) && Object.values(scn.role(m).redirects).includes(to)) return m;
  }
  return st.discovered.includes(to) ? to : undefined;
}

/** 前提没满足时,缺的是什么:信任、老板授权、阶段,还是别的。 */
function missingOf(scn: LoadedScenario, st: SessionState, req: Parameters<typeof evalRequirement>[0]): Pick<Hint, "missing" | "missingKind"> {
  const r = stateResolver(st, scn);
  const leaves = requirementLeaves(req).filter((l) => {
    try {
      return !evalExpr(l, r);
    } catch {
      return true;
    }
  });
  const kindOf = (l: string): NonNullable<Hint["missingKind"]> => {
    if (l.startsWith("trust.")) return "trust";
    if (scn.data.flags[l]?.granted_by) return "auth";
    if (l.startsWith("phase")) return "phase";
    return "other";
  };
  const kinds = new Set(leaves.map(kindOf));
  const missingKind = kinds.has("trust") ? "trust" : kinds.size === 1 ? [...kinds][0]! : "other";
  return { missing: leaves.join(" / ") || "前提未满足", missingKind };
}

function trapDue(scn: LoadedScenario, st: SessionState, t: Trap, role: string, semanticHit: Set<string>): boolean {
  if (t.by !== role || st.traps[t.id]) return false;
  if (t.after?.some((a) => !st.traps[a])) return false;
  if (isExpression(t.when)) return evalExpr(t.when, stateResolver(st, scn));
  return semanticHit.has(t.id);
}

function fireTrap(scn: LoadedScenario, st: SessionState, t: Trap, plan: TurnPlan): Directive["beat"] {
  st.traps[t.id] = { turn: st.turn };
  addEvent(st, "trap", { trap: t.id, by: t.by });
  for (const f of t.sets ?? []) setFlag(st, f, `trap:${t.id}`);
  for (const r of t.discover ?? []) discover(scn, st, r, `trap:${t.id}`, plan);
  if (t.reveal) {
    const fact = scn.fact(t.reveal);
    const rule = fact.unlock.find((u) => !isViaUnlock(u) && u.role === t.by);
    if (rule && !isViaUnlock(rule)) {
      const text = rule.level === "L1" ? (rule.say ?? fact.statement) : fact.statement;
      plan.reveals.push({ factId: fact.id, level: rule.level, text, ruleId: `${fact.id}@${t.by}:${rule.level}` });
      recordReveal(st, fact.id, rule.level, t.by, t.by);
    }
  }
  return t.beat;
}

function setFlag(st: SessionState, flag: string, by: string) {
  if (st.flags[flag]) return;
  st.flags[flag] = true;
  addEvent(st, "auth_grant", { flag, by });
}

const STANCE_TEXT: Record<Directive["stance"], string> = {
  pocket: "把对方刚给的工期、报价或准确率用你自己的话复述一遍并当场确认,再追问一句让它更具体。不夸对方。",
  push_back: "质疑对方的方案或要求,压价、压时间,问凭什么。",
  impatient: "你没多少耐心了。回答变短,指路让对方去找别人。",
  guarded: "你还不信任对方。只给模糊印象,不给数字和资料,反过来试探对方来意。",
  deflect: "这事你说不清楚。直说不清楚,并指给该问的人。",
  cooperative: "你愿意配合。具体回答,可以把资料交给对方。",
  test_user: "第一次见面,先反问一句考验对方,比如问对方懂不懂这行、来干什么的。",
  beat: "按下面要求说出指定的话或做出指定的动作。",
  neutral: "正常回应。只说你的看法和印象,不给对方没问到的具体数字。",
  confused: "对方说的话你听不懂,当作外行话,按你的性格把话题拉回今天的事。",
};

export function makeDirective(stance: Directive["stance"], extra: Partial<Directive> = {}): Directive {
  return { stance, instruction: STANCE_TEXT[stance], ...extra };
}

// ------------------------------------------------------------------
// 用户说一句话
// ------------------------------------------------------------------

export function planUserTurn(scn: LoadedScenario, st: SessionState, gate: GateOutput): TurnPlan {
  const plan = emptyPlan();
  const d = scn.data;

  if (st.phase === "judgment") {
    plan.system.push("现在需要先提交你的判断(J1–J5),然后去会议室向周总汇报。");
    return plan;
  }
  if (st.phase === "debrief") {
    plan.system.push("这一局已经结束。");
    plan.ended = true;
    return plan;
  }

  const trig = triggers(scn);
  const matched = gate.matched_triggers
    .filter((m) => m.confidence >= CONFIDENCE_MIN)
    .map((m) => trig.get(m.id))
    .filter((t): t is Trigger => t !== undefined);

  // 0. 找人:问"谁管钱"之类,当前角色会说出这个人
  for (const t of matched) {
    if (t.kind !== "find") continue;
    const via = redirectTarget(scn, st, st.currentRole, t.findRole) ?? t.findRole;
    plan.hints.push({ kind: "redirect", ruleId: t.id, toRole: via });
    discover(scn, st, via, `ask:${t.id}`, plan);
  }

  // 1. 收工
  if (gate.acts.includes("end_session")) {
    endSession(st, "user");
    plan.system.push("你收工了。正在生成复盘……");
    plan.ended = true;
    return plan;
  }

  // 2. 换人
  if (gate.acts.includes("switch_role") && gate.target_role && gate.target_role !== st.currentRole) {
    const r = switchRole(scn, st, gate.target_role, plan);
    if (!r) return plan;
  }

  // 3. 动作与验证(自然语言等价于按钮)
  if (st.phase !== "report") {
    const act = matched.find((t) => t.kind === "act");
    if (act && act.kind === "act" && gate.acts.includes("request_site_visit")) {
      const r = doAction(scn, st, act.actionId);
      plan.system.push(...r.system);
      plan.obtained.push(...r.obtained);
      plan.discovered.push(...r.discovered);
      return plan;
    }
    const exp = matched.find((t) => t.kind === "exp");
    if (exp && exp.kind === "exp" && gate.acts.includes("request_experiment")) {
      const r = doExperiment(scn, st, exp.experimentId);
      plan.system.push(...r.system);
      return plan;
    }
  }

  const role = st.currentRole;
  const roleDef = scn.role(role);

  // 4. 每个阶段的轮数上限
  const cap = st.phase === "report" ? roleDef.caps?.report_exchanges : roleDef.caps?.kickoff_exchanges;
  const capApplies = st.phase === "report" || st.phase === "kickoff";
  if (cap !== undefined && capApplies && (st.phaseExchanges[role] ?? 0) >= cap) {
    addEvent(st, "cap", { role, phase: st.phase, cap });
    if (st.phase === "report") {
      endSession(st, "report_cap");
      plan.system.push(`${roleDef.name}看了看表:"就这样吧。"汇报结束,正在生成复盘……`);
      plan.ended = true;
    } else {
      leaveKickoff(st);
      plan.system.push(`${roleDef.name}起身去开会了。你可以先去找别人。`);
    }
    return plan;
  }

  // 5. 时间与轮数
  st.exchanges[role] = (st.exchanges[role] ?? 0) + 1;
  st.phaseExchanges[role] = (st.phaseExchanges[role] ?? 0) + 1;
  plan.role = role;

  // 6. 套话与出戏:不解锁、不记账,让角色按人设听不懂
  if (gate.meta_or_injection) {
    addEvent(st, "meta_injection", { summary: gate.summary });
    plan.directive = makeDirective("confused");
    spend(scn, st, roleDef.time_cost_min, plan);
    return plan;
  }

  // 7. 承诺账本(用本轮披露之前的状态判断是否过早)
  const premature = !evalRequirement(d.rubric.premature_until, stateResolver(st, scn));
  const commitsNow: LedgerEntry[] = [];
  for (const c of gate.commitments) {
    if (!c.firm) continue;
    const entry: LedgerEntry = {
      id: `L${st.ledger.length + 1}`,
      type: c.type,
      valueText: c.value_text,
      turn: st.turn,
      role,
      premature,
      knownAtThatTime: knownSnapshot(st),
    };
    st.ledger.push(entry);
    commitsNow.push(entry);
    addEvent(st, "commitment", { ...entry });
  }
  if (gate.acts.includes("retract_commitment")) {
    const types = gate.retracts?.length ? gate.retracts : undefined;
    for (const e of st.ledger) {
      if (e.retractedTurn !== undefined || e.type === "solution") continue;
      if (types && !types.includes(e.type as never)) continue;
      e.retractedTurn = st.turn;
      addEvent(st, "retraction", { ledger: e.id, type: e.type });
    }
  }
  if (gate.acts.includes("propose_solution") && premature) {
    addEvent(st, "premature_solution", { summary: gate.summary });
  }

  // 8. 信任:加分行为每种只算一次,每轮最多 +1;减分行为照扣
  if (roleDef.trust) {
    const before = st.trust[role] ?? 0;
    let delta = 0;
    const used = (st.trustPlusUsed[role] ??= []);
    for (const m of gate.trust_moves) {
      if (m.dir === "minus") delta -= 1;
      else if (!used.includes(m.what) && delta < 1) {
        used.push(m.what);
        delta += 1;
      }
    }
    const after = Math.max(0, Math.min(roleDef.trust.max, before + delta));
    if (after !== before) {
      st.trust[role] = after;
      addEvent(st, "trust_change", { role, from: before, to: after, moves: gate.trust_moves.map((m) => `${m.dir}:${m.what}`) });
    }
  }

  // 9. 授权
  for (const t of matched) {
    if (t.kind !== "perm") continue;
    if (t.role === role) setFlag(st, t.flag, role);
    else plan.hints.push({ kind: "blocked", ruleId: t.id, missing: t.flag, missingKind: "auth", toRole: t.role });
  }

  // 10. 解锁:角色对、意图对、前提满足
  const resolver = () => stateResolver(st, scn);
  const byFact = new Map<string, Extract<Trigger, { kind: "fact" }>[]>();
  for (const t of matched) {
    if (t.kind === "fact") byFact.set(t.factId, [...(byFact.get(t.factId) ?? []), t]);
  }
  for (const [factId, ts] of byFact) {
    const fact = scn.fact(factId);
    const mine = ts.filter((t) => t.role === role).sort((a, b) => levelRank(b.level) - levelRank(a.level));
    if (mine.length === 0) {
      const best = ts.sort((a, b) => levelRank(b.level) - levelRank(a.level))[0]!;
      if (hasFactAtLeast(st, factId, best.level)) continue;
      const to = redirectTarget(scn, st, role, best.role);
      if (to) {
        plan.hints.push({ kind: "redirect", ruleId: best.id, toRole: to });
        addEvent(st, "redirect", { from: role, to, trigger: best.id });
        discover(scn, st, to, `redirect:${best.id}`, plan);
      }
      continue;
    }
    // 命中的最高一级如果前提不满足,退到前提满足的那一级,同时记一条"卡住了"
    const ok = mine.find((t) => evalRequirement(t.rule.requires, resolver()));
    const blocked = mine.find((t) => t !== ok && (!ok || levelRank(t.level) > levelRank(ok.level)));
    if (blocked) {
      plan.hints.push({ kind: "blocked", ruleId: blocked.id, ...missingOf(scn, st, blocked.rule.requires) });
      addEvent(st, "blocked", { role, trigger: blocked.id });
    }
    if (!ok) continue;
    const told = st.roleTold[role]?.[factId];
    if (told && levelRank(told) >= levelRank(ok.level)) continue;
    const text = ok.level === "L1" ? (ok.rule.say ?? fact.statement) : fact.statement;
    const rv: Reveal = { factId, level: ok.level, text, ruleId: ok.id };
    if (ok.rule.gives) rv.gives = ok.rule.gives;
    plan.reveals.push(rv);
    recordReveal(st, factId, ok.level, role, role);
    if (ok.rule.gives) obtainArtifact(st, ok.rule.gives, role, plan);
  }
  for (const t of matched) {
    if (t.kind !== "artifact") continue;
    if (st.artifacts[t.artifactId]) continue;
    if (t.role !== role) {
      const to = redirectTarget(scn, st, role, t.role) ?? t.role;
      plan.hints.push({ kind: "redirect", ruleId: t.id, toRole: to });
      addEvent(st, "redirect", { from: role, to, trigger: t.id });
      discover(scn, st, to, `redirect:${t.id}`, plan);
      continue;
    }
    const art = scn.artifact(t.artifactId);
    if (!evalRequirement(art.unlock?.requires, resolver())) {
      plan.hints.push({ kind: "blocked", ruleId: t.id, ...missingOf(scn, st, art.unlock?.requires) });
      continue;
    }
    obtainArtifact(st, t.artifactId, role, plan);
    plan.reveals.push({ factId: "", level: "L3", text: `把「${art.title}」交给对方`, gives: art.id, ruleId: t.id });
  }

  // 11. 压力时刻:每轮最多一个
  const semantic = new Set(matched.filter((t) => t.kind === "trap").map((t) => (t as { trapId: string }).trapId));
  let beat: string | undefined;
  let trapId: string | undefined;
  for (const t of d.traps) {
    if (trapDue(scn, st, t, role, semantic)) {
      beat = fireTrap(scn, st, t, plan);
      trapId = t.id;
      break;
    }
  }

  // 12. 态度
  plan.directive = pickDirective(scn, st, { role: roleDef, gate, plan, commitsNow, beat, trapId });

  // 13. 时间(放在最后:本轮仍然有回复,用完后强制进入判断阶段)
  spend(scn, st, roleDef.time_cost_min, plan);
  return plan;
}

interface DirectiveCtx {
  role: Role;
  gate: GateOutput;
  plan: TurnPlan;
  commitsNow: LedgerEntry[];
  beat?: string;
  trapId?: string;
}

export function pickDirective(scn: LoadedScenario, st: SessionState, c: DirectiveCtx): Directive {
  const { role, gate, plan } = c;
  const extra: Partial<Directive> = {};
  if (c.beat) extra.beat = c.beat;
  if (c.trapId) extra.trapId = c.trapId;
  const redirect = plan.hints.find((h) => h.kind === "redirect");
  if (redirect?.toRole) extra.redirectTo = redirect.toRole;

  const stance = ((): Directive["stance"] => {
    if (c.commitsNow.length) return role.on_commitment ?? "pocket";
    if (gate.acts.includes("propose_solution") || (st.phase === "report" && gate.acts.includes("commit_price")))
      return "push_back";
    const blocked = plan.hints.find((h) => h.kind === "blocked");
    if (blocked && plan.reveals.length === 0) {
      if (blocked.toRole) return "deflect";
      if (blocked.missingKind === "trust" || blocked.missingKind === "auth") return "guarded";
    }
    if (redirect && plan.reveals.length === 0) return "deflect";
    const cap = st.phase === "report" ? role.caps?.report_exchanges : role.caps?.kickoff_exchanges;
    if (cap && (st.phaseExchanges[role.id] ?? 0) >= Math.ceil(cap * 0.75)) return "impatient";
    if (role.trust && (st.exchanges[role.id] ?? 0) === 1) return "test_user";
    const trustOk = !role.trust || (st.trust[role.id] ?? 0) >= 1;
    if (plan.reveals.some((r) => r.level !== "L1") && trustOk) return "cooperative";
    if (role.trust && !trustOk) return "guarded";
    return "neutral";
  })();

  // 压力时刻自带态度时优先于常规规则(承诺除外:听到承诺一律先记账)
  const trapStance = c.trapId ? scn.traps.get(c.trapId)?.stance : undefined;
  if (trapStance && !c.commitsNow.length) return makeDirective(trapStance, extra);
  if (c.beat && stance === "neutral") return makeDirective("beat", extra);
  const d = makeDirective(stance, extra);
  const blockedAuth = plan.hints.find((h) => h.kind === "blocked" && h.missingKind === "auth");
  if (blockedAuth && !d.beat) {
    const boss = scn.roles.get(bossRole(scn))?.name ?? "老板";
    d.beat = blockedAuth.toRole ? `说明这事得${boss}点头,让对方去问${boss}` : `说明没有${boss}点头,这些不能给你`;
  }
  return d;
}

// ------------------------------------------------------------------
// 按钮动作:换人、看资料、去现场、做验证、提交判断、收工
// ------------------------------------------------------------------

export interface ActionResult {
  ok: boolean;
  system: string[];
  obtained: string[];
  discovered: string[];
  text?: string;
}

const ar = (ok: boolean, system: string[] = [], extra: Partial<ActionResult> = {}): ActionResult => ({
  ok,
  system,
  obtained: [],
  discovered: [],
  ...extra,
});

function phaseAllowsDiscovery(st: SessionState) {
  return st.phase === "kickoff" || st.phase === "discovery";
}

export function switchRole(scn: LoadedScenario, st: SessionState, roleId: string, plan: TurnPlan = emptyPlan()): boolean {
  if (!scn.roles.has(roleId)) {
    plan.system.push("没有这个人。");
    return false;
  }
  if (!st.discovered.includes(roleId)) {
    plan.system.push("你还不知道这个人在哪、管什么。可以先问问身边的人该找谁。");
    return false;
  }
  if (st.phase === "report") {
    plan.system.push("汇报阶段只和周总谈。");
    return false;
  }
  if (!phaseAllowsDiscovery(st)) {
    plan.system.push("现在不能去找人了。");
    return false;
  }
  if (roleId === st.currentRole) return true;
  addEvent(st, "switch_role", { from: st.currentRole, to: roleId });
  st.currentRole = roleId;
  leaveKickoff(st);
  spend(scn, st, scn.data.budget.switch_person_min, plan);
  plan.system.push(`你去找了${scn.role(roleId).name}(${scn.role(roleId).title})。`);
  return phaseAllowsDiscovery(st);
}

export function doSwitchRole(scn: LoadedScenario, st: SessionState, roleId: string): ActionResult {
  const plan = emptyPlan();
  const ok = switchRole(scn, st, roleId, plan);
  return ar(ok, plan.system);
}

export function doOpenArtifact(scn: LoadedScenario, st: SessionState, artifactId: string): ActionResult {
  const a = scn.artifacts.get(artifactId);
  const rec = st.artifacts[artifactId];
  if (!a || !rec) return ar(false, ["你还没有拿到这份资料。"]);
  if (rec.openedTurn !== undefined) return ar(true, [`你又翻了翻「${a.title}」。`]);
  if (!phaseAllowsDiscovery(st)) return ar(false, ["现在没时间细看资料了。"]);
  const plan = emptyPlan();
  rec.openedTurn = st.turn;
  addEvent(st, "artifact_open", { artifact: artifactId });
  if ("seen_any_artifact" in st.flags) st.flags.seen_any_artifact = true;
  applyVia(scn, st, artifactId, plan);
  leaveKickoff(st);
  spend(scn, st, a.review_cost_min, plan);
  return ar(true, [`你花了 ${a.review_cost_min} 分钟看「${a.title}」。`, ...plan.system], { obtained: plan.obtained });
}

export function doAction(scn: LoadedScenario, st: SessionState, actionId: string): ActionResult {
  const a = scn.data.actions[actionId];
  if (!a) return ar(false, ["没有这个动作。"]);
  if (!phaseAllowsDiscovery(st)) return ar(false, ["现在不能做这个了。"]);
  if (st.actionsDone[actionId]) return ar(false, ["你已经去过了。"]);
  if (!evalRequirement(a.requires, stateResolver(st, scn))) {
    return ar(false, ["你还不认识操作部的人,也没有老板点头,直接过去不合适。"]);
  }
  const plan = emptyPlan();
  st.actionsDone[actionId] = { turn: st.turn };
  addEvent(st, "action", { action: actionId });
  applyVia(scn, st, actionId, plan);
  for (const eff of a.effects) applyEffect(scn, st, eff, plan, `action:${actionId}`);
  leaveKickoff(st);
  const narrative = a.narrative ? scn.readText(a.narrative)?.trim() : undefined;
  const text = narrative ?? `(${a.title})`;
  spend(scn, st, a.cost_min, plan);
  return ar(true, [text, ...plan.system], { obtained: plan.obtained, discovered: plan.discovered, text });
}

function applyEffect(scn: LoadedScenario, st: SessionState, eff: string, plan: TurnPlan, why: string) {
  let m: RegExpMatchArray | null;
  if ((m = eff.match(/^discover\s+(\w+)$/))) discover(scn, st, m[1]!, why, plan);
  else if ((m = eff.match(/^trust\.(\w+)\s*([+-]\d+)$/))) {
    const role = scn.roles.get(m[1]!);
    if (!role?.trust) return;
    const before = st.trust[m[1]!] ?? 0;
    const after = Math.max(0, Math.min(role.trust.max, before + Number(m[2])));
    st.trust[m[1]!] = after;
    if (after !== before) addEvent(st, "trust_change", { role: m[1], from: before, to: after, why });
  } else if ((m = eff.match(/^set\s+(\w+)$/))) setFlag(st, m[1]!, why);
  // "reveal X@L2" 由 facts 里的 via 规则负责,这里不重复处理(校验器检查两者一致)
}

export function doExperiment(scn: LoadedScenario, st: SessionState, experimentId: string): ActionResult {
  const x = scn.experiments.get(experimentId);
  if (!x) return ar(false, ["没有这个验证。"]);
  if (!phaseAllowsDiscovery(st)) return ar(false, ["现在不能做验证了。"]);
  if (st.experiments[experimentId]) return ar(true, [`验证结果:${x.result}`], { text: x.result });
  if (!evalRequirement(x.requires, stateResolver(st, scn))) {
    return ar(false, [`做这个验证需要先拿到:${requirementLeaves(x.requires).join("、")}。`]);
  }
  const plan = emptyPlan();
  st.experiments[experimentId] = { turn: st.turn };
  addEvent(st, "experiment", { experiment: experimentId });
  applyVia(scn, st, experimentId, plan);
  leaveKickoff(st);
  const text = `你花了 ${scn.data.budget.experiment_min} 分钟做「${x.title}」。结果:${x.result}`;
  spend(scn, st, scn.data.budget.experiment_min, plan);
  return ar(true, [text, ...plan.system], { text: x.result });
}

export function submitJudgment(scn: LoadedScenario, st: SessionState, form: Record<string, string>): ActionResult {
  if (!(st.phase === "kickoff" || st.phase === "discovery" || st.phase === "judgment")) {
    return ar(false, ["现在不能提交判断。"]);
  }
  const fields = scn.data.judgment_form.map((f) => f.id);
  const clean: Record<string, string> = {};
  for (const id of fields) clean[id] = (form[id] ?? "").trim();
  st.judgment = clean;
  addEvent(st, "judgment_submit", { filled: fields.filter((f) => clean[f]) });
  setPhase(st, "report");
  st.currentRole = bossRole(scn);
  return ar(true, ["下午,会议室。你把判断整理好,去向周总汇报。"]);
}

/** 汇报开场:周总先开口。承诺账本在这里被原话拿出来(方案 3.3.6)。 */
export function planReportOpening(scn: LoadedScenario, st: SessionState): TurnPlan {
  const plan = emptyPlan();
  const boss = bossRole(scn);
  plan.role = boss;
  const firm = st.ledger.filter((e) => e.type !== "solution");
  if (firm.length && !st.ledgerRecalled) {
    st.ledgerRecalled = true;
    const said = firm.map((e) => e.valueText).join("、");
    addEvent(st, "trap", { trap: "ledger_recall", by: boss, entries: firm.map((e) => e.id) });
    plan.directive = makeDirective("push_back", {
      beat: `开口第一句就把对方上午的原话拿出来:"你上午说${said}",问现在是不是还算数、怎么又变了`,
    });
  } else {
    plan.directive = makeDirective("push_back", { beat: "让对方直接说结论:到底怎么回事、要多少钱、多久能在大会上演示" });
  }
  return plan;
}

export function endSession(st: SessionState, reason: NonNullable<SessionState["endedReason"]>) {
  if (st.phase === "debrief") return;
  st.endedReason = reason;
  setPhase(st, "debrief");
}

/** 回复里提到了某个还没出现的人,且场景允许由当前角色引出,则让他出现(人物迷雾)。 */
export function discoverFromReply(scn: LoadedScenario, st: SessionState, roleId: string, reply: string): string[] {
  const found: string[] = [];
  for (const r of scn.data.roles) {
    if (st.discovered.includes(r.id) || r.discovered === "start") continue;
    if (!reply.includes(r.name)) continue;
    const ok = r.discovered.by_role?.includes(roleId) || Object.values(scn.role(roleId).redirects).includes(r.id);
    if (ok) {
      discover(scn, st, r.id, `mentioned_by:${roleId}`);
      found.push(r.id);
    }
  }
  return found;
}
