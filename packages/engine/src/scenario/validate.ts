// 场景校验器(方案 4.3)。结构层面的"不允许未定义的键"由 schema 在加载时完成;
// 这里做语义检查:引用、合计、可达性、证据来源、参考路径时长、泄露风险。
import { exprIdentifiers, isExpression, parseExpr, requirementLeaves, type ExprNode } from "../expr.ts";
import { extractNumbers } from "../numbers.ts";
import { IMPLEMENTED_DIMENSIONS, d2Ids, parseD2Key, parseD3Key, parseD5Key } from "../rubric-keys.ts";
import { knownIdentifiers } from "../state.ts";
import { triggers } from "../triggers.ts";
import type { LoadedScenario } from "./load.ts";
import { isViaUnlock, levelRank, type Level, type Requirement } from "./schema.ts";

export interface ValidationReport {
  errors: string[];
  warnings: string[];
  info: string[];
}

export function validateScenario(scn: LoadedScenario): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const d = scn.data;
  const roleIds = new Set(scn.roles.keys());
  const artifactIds = new Set(scn.artifacts.keys());
  const expIds = new Set(scn.experiments.keys());
  const actionIds = new Set(Object.keys(d.actions));
  const diagIds = new Set(d.truth.diagnosis_items.map((t) => t.id));
  const idents = knownIdentifiers(scn);

  // ---------------- 1. 引用 ----------------
  const checkReq = (req: Requirement | undefined, where: string) => {
    for (const leaf of requirementLeaves(req)) checkExpr(leaf, where);
  };
  const checkExpr = (src: string, where: string) => {
    if (!isExpression(src)) {
      errors.push(`${where}:条件写不成表达式「${src}」`);
      return;
    }
    const { ids, calls } = exprIdentifiers(src);
    for (const id of ids) if (!idents.has(id)) errors.push(`${where}:条件「${src}」里有未知标识符 ${id}`);
    for (const c of calls) {
      if (c.fn !== "only_talked_to") errors.push(`${where}:未知函数 ${c.fn}`);
      for (const a of c.args) if (!roleIds.has(a)) errors.push(`${where}:${c.fn} 的参数 ${a} 不是角色`);
    }
  };
  const need = (ok: boolean, msg: string) => {
    if (!ok) errors.push(msg);
  };

  need(roleIds.has(d.briefing.opening.speaker), `briefing.opening.speaker ${d.briefing.opening.speaker} 不是角色`);
  for (const r of d.roles) {
    for (const [topic, to] of Object.entries(r.redirects)) need(roleIds.has(to), `角色 ${r.id} 的指路「${topic}」指向未知角色 ${to}`);
    if (r.discovered !== "start") {
      for (const b of r.discovered.by_role ?? []) need(roleIds.has(b), `角色 ${r.id} discovered.by_role 有未知角色 ${b}`);
      for (const a of r.discovered.by_action ?? []) need(actionIds.has(a), `角色 ${r.id} discovered.by_action 有未知动作 ${a}`);
    }
    if (r.trust && r.trust.initial > r.trust.max) errors.push(`角色 ${r.id} 的初始信任大于上限`);
  }
  for (const [f, def] of Object.entries(d.flags)) {
    if (def.granted_by) need(roleIds.has(def.granted_by), `flag ${f} 的 granted_by ${def.granted_by} 不是角色`);
  }
  for (const f of d.facts) {
    for (const u of f.unlock) {
      if (isViaUnlock(u)) {
        need(artifactIds.has(u.via) || actionIds.has(u.via) || expIds.has(u.via), `事实 ${f.id} 的 via ${u.via} 不是资料、动作或验证`);
      } else {
        need(roleIds.has(u.role), `事实 ${f.id} 的解锁角色 ${u.role} 不存在`);
        if (!u.volunteered && !u.ask) errors.push(`事实 ${f.id}@${u.role}:${u.level} 既不是主动说的也没有 ask`);
        if (u.volunteered && !d.traps.some((t) => t.reveal === f.id && t.by === u.role))
          errors.push(`事实 ${f.id}@${u.role}:${u.level} 标了 volunteered,但没有任何 ${u.role} 的压力时刻 reveal 它,永远说不出来`);
        if (u.level === "L1" && !u.say) warnings.push(`事实 ${f.id}@${u.role}:L1 没有 say,L1 披露时会直接给 statement`);
        checkReq(u.requires, `事实 ${f.id}@${u.role}`);
      }
      if (u.gives) need(artifactIds.has(u.gives), `事实 ${f.id} gives 了未知资料 ${u.gives}`);
    }
  }
  for (const a of d.artifacts) {
    need(roleIds.has(a.holder), `资料 ${a.id} 的持有人 ${a.holder} 不存在`);
    for (const t of a.supports ?? []) need(diagIds.has(t), `资料 ${a.id} supports 了未知对照项 ${t}`);
    checkReq(a.unlock?.requires, `资料 ${a.id}`);
    if (!a.unlock && !d.facts.some((f) => f.unlock.some((u) => u.gives === a.id)))
      errors.push(`资料 ${a.id} 没有任何获得途径(既没有 unlock,也没有事实 gives 它)`);
  }
  for (const [id, a] of Object.entries(d.actions)) {
    checkReq(a.requires, `动作 ${id}`);
    if (a.narrative && !scn.readText(a.narrative)) warnings.push(`动作 ${id} 的叙述稿 ${a.narrative} 还没写`);
    for (const eff of a.effects) {
      let m: RegExpMatchArray | null;
      if ((m = eff.match(/^reveal\s+(\w+)@(L[123])$/))) {
        const fact = scn.facts.get(m[1]!);
        if (!fact) errors.push(`动作 ${id} 的效果「${eff}」引用了未知事实`);
        else if (!fact.unlock.some((u) => isViaUnlock(u) && u.via === id && u.level === m![2]))
          errors.push(`动作 ${id} 的效果「${eff}」在事实 ${m[1]} 里没有对应的 via: ${id} 规则`);
      } else if ((m = eff.match(/^discover\s+(\w+)$/))) need(roleIds.has(m[1]!), `动作 ${id} 的效果「${eff}」角色不存在`);
      else if ((m = eff.match(/^trust\.(\w+)\s*[+-]\d+$/))) need(roleIds.has(m[1]!), `动作 ${id} 的效果「${eff}」角色不存在`);
      else if ((m = eff.match(/^set\s+(\w+)$/))) need(m[1]! in d.flags, `动作 ${id} 的效果「${eff}」flag 不存在`);
      else errors.push(`动作 ${id} 的效果「${eff}」看不懂`);
    }
    for (const f of d.facts)
      for (const u of f.unlock)
        if (isViaUnlock(u) && u.via === id && !a.effects.includes(`reveal ${f.id}@${u.level}`))
          warnings.push(`事实 ${f.id} 有 via: ${id} 规则,但动作 ${id} 的 effects 没有列出 reveal ${f.id}@${u.level}`);
  }
  for (const x of d.experiments) {
    checkReq(x.requires, `验证 ${x.id}`);
    for (const t of x.supports) need(diagIds.has(t), `验证 ${x.id} supports 了未知对照项 ${t}`);
  }
  const semanticTraps: string[] = [];
  for (const t of d.traps) {
    need(roleIds.has(t.by), `压力时刻 ${t.id} 的角色 ${t.by} 不存在`);
    if (isExpression(t.when)) checkExpr(t.when, `压力时刻 ${t.id}`);
    else semanticTraps.push(t.id);
    for (const a of t.after ?? []) need(scn.traps.has(a), `压力时刻 ${t.id} after 了未知压力时刻 ${a}`);
    for (const f of t.sets ?? []) need(f in d.flags, `压力时刻 ${t.id} sets 了未知 flag ${f}`);
    for (const r of t.discover ?? []) need(roleIds.has(r), `压力时刻 ${t.id} discover 了未知角色 ${r}`);
    if (t.reveal) {
      const f = scn.facts.get(t.reveal);
      if (!f) errors.push(`压力时刻 ${t.id} reveal 了未知事实 ${t.reveal}`);
      else if (!f.unlock.some((u) => !isViaUnlock(u) && u.role === t.by))
        errors.push(`压力时刻 ${t.id} reveal ${t.reveal},但该事实没有 ${t.by} 的解锁规则`);
    }
  }
  if (semanticTraps.length) info.push(`由闸门识别条件的压力时刻:${semanticTraps.join("、")}`);
  // 兜底台词不过守卫、原样说出,所以不能含别的事实的金丝雀词
  for (const t of d.traps) {
    if (!t.line) continue;
    for (const f of d.facts) {
      if (f.id === t.reveal) continue;
      for (const w of f.canaries ?? []) if (t.line.includes(w)) warnings.push(`压力时刻 ${t.id} 的兜底台词含有事实 ${f.id} 的金丝雀词「${w}」`);
    }
  }
  const noLine = d.traps.filter((t) => !t.line).map((t) => t.id);
  if (noLine.length) warnings.push(`压力时刻没有兜底台词(line):${noLine.join("、")}。演员出错时这个压力时刻会丢`);

  // ---------------- 2. 合计数自洽 ----------------
  const tr = d.truth;
  const cats = tr.error_categories ?? [];
  if (cats.length && tr.error_log_total !== undefined) {
    const n = cats.reduce((s, c) => s + c.count, 0);
    need(n === tr.error_log_total, `异常件数合计 ${n} ≠ error_log_total ${tr.error_log_total}`);
  }
  if (cats.length && tr.loss_total !== undefined) {
    const n = cats.reduce((s, c) => s + c.loss, 0);
    need(n === tr.loss_total, `损失合计 ${n} ≠ loss_total ${tr.loss_total}`);
  }
  if (cats.length) {
    const expNums = new Set(d.experiments.flatMap((x) => extractNumbers(x.result).map((n) => n.value)));
    for (const c of cats) {
      if (!expNums.has(c.count)) warnings.push(`分类 ${c.id} 的件数 ${c.count} 没有出现在任何验证结果里`);
      if (!expNums.has(c.loss)) warnings.push(`分类 ${c.id} 的损失 ${c.loss} 没有出现在任何验证结果里`);
    }
  }
  if (tr.intake_formats) info.push(`来料文件合计 ${Object.values(tr.intake_formats).reduce((s, v) => s + v, 0)}`);
  if (tr.key_customer && cats.length) {
    const hs = cats.find((c) => /HS/.test(c.id));
    if (hs && tr.key_customer.hs_cases > hs.count) errors.push(`关键客户的 HS 件数大于 HS 分类总件数`);
    if (hs && tr.key_customer.hs_loss > hs.loss) errors.push(`关键客户的 HS 损失大于 HS 分类总损失`);
  }

  const ru = d.rubric;
  const dimIds = ru.dimensions.map((x) => x.id);
  for (const id of dimIds) {
    if (!(IMPLEMENTED_DIMENSIONS as readonly string[]).includes(id)) errors.push(`评分维度 ${id} 没有实现(只有 ${IMPLEMENTED_DIMENSIONS.join("、")})`);
  }
  for (const id of new Set(dimIds)) if (dimIds.filter((x) => x === id).length > 1) errors.push(`评分维度 ${id} 重复`);
  for (const k of Object.keys(ru.d3_points)) if (!parseD3Key(k)) errors.push(`d3_points 的键 ${k} 看不懂`);
  const dimSum = ru.dimensions.reduce((s, x) => s + x.max, 0);
  need(dimSum === 100, `评分维度合计 ${dimSum} ≠ 100`);
  const dimMax = (id: string) => ru.dimensions.find((x) => x.id === id)?.max;
  const sum = (o: Record<string, number>) => Object.values(o).reduce((s, v) => s + v, 0);
  const diagSum = tr.diagnosis_items.reduce((s, t) => s + t.weight, 0);
  if (dimMax("D4") !== undefined && diagSum !== dimMax("D4"))
    warnings.push(`诊断对照项权重合计 ${diagSum} ≠ D4 满分 ${dimMax("D4")}(算分时会按比例缩放)`);
  if (dimMax("D2") !== undefined) need(sum(ru.d2_points) === dimMax("D2"), `d2_points 合计 ${sum(ru.d2_points)} ≠ D2 满分 ${dimMax("D2")}`);
  if (dimMax("D3") !== undefined) need(sum(ru.d3_points) === dimMax("D3"), `d3_points 合计 ${sum(ru.d3_points)} ≠ D3 满分 ${dimMax("D3")}`);
  if (dimMax("D7") !== undefined) {
    const w = ru.d7_checklist.reduce((s, x) => s + x.points, 0);
    need(w === dimMax("D7"), `d7_checklist 合计 ${w} ≠ D7 满分 ${dimMax("D7")}`);
  }
  if (dimMax("D5") !== undefined) {
    let d5 = 0;
    for (const [k, v] of Object.entries(ru.d5_points)) {
      const { ids } = parseD5Key(k);
      for (const id of ids) need(scn.facts.has(id), `d5_points 引用了未知事实 ${id}`);
      d5 += v * ids.length;
    }
    need(d5 === dimMax("D5"), `d5_points 可得合计 ${d5} ≠ D5 满分 ${dimMax("D5")}`);
  }
  if (dimMax("D6") !== undefined && sum(ru.d6_penalties) < dimMax("D6")!)
    info.push(`D6 全部扣分项合计 ${sum(ru.d6_penalties)},小于满分 ${dimMax("D6")}`);
  for (const k of Object.keys(ru.d2_points)) {
    for (const id of d2Ids(parseD2Key(k))) need(artifactIds.has(id) || expIds.has(id), `d2_points 的键 ${k} 引用了未知资料或验证 ${id}`);
  }
  for (const r of ru.premature_until) checkReq(r, "rubric.premature_until");
  for (const c of ru.caps) {
    checkExpr(c.if, `封顶规则「${c.label}」`);
    for (const k of Object.keys(c.set ?? {})) need(dimMax(k) !== undefined, `封顶规则「${c.label}」set 了未知维度 ${k}`);
  }

  // ---------------- 3. 可达性 ----------------
  const reach = reachability(scn);
  for (const f of d.facts) {
    const lvl = reach.facts.get(f.id);
    if (!lvl) errors.push(`事实 ${f.id} 没有任何可达的解锁路径`);
    else if (f.key && levelRank(lvl) < levelRank(ru.d1_min_level))
      warnings.push(`关键事实 ${f.id} 最高只能到 ${lvl},达不到计分线 ${ru.d1_min_level}`);
  }
  for (const r of d.roles) if (!reach.roles.has(r.id)) errors.push(`角色 ${r.id} 永远不会出现`);
  for (const a of d.artifacts) if (!reach.artifacts.has(a.id)) errors.push(`资料 ${a.id} 拿不到`);
  for (const x of d.experiments) if (!reach.experiments.has(x.id)) errors.push(`验证 ${x.id} 永远做不了`);
  for (const t of tr.diagnosis_items) {
    const src = [
      ...d.artifacts.filter((a) => reach.openable.has(a.id) && a.supports?.includes(t.id)).map((a) => a.id),
      ...d.experiments.filter((x) => reach.experiments.has(x.id) && x.supports.includes(t.id)).map((x) => x.id),
    ];
    if (!src.length) errors.push(`诊断对照项 ${t.id} 没有任何可达的资料或验证能提供 A 级证据`);
  }
  const reachW = d.facts.filter((f) => {
    const l = reach.facts.get(f.id);
    return l && levelRank(l) >= levelRank(ru.d1_min_level);
  });
  const total = d.facts.reduce((s, f) => s + f.weight, 0);
  info.push(
    `可达到 ${ru.d1_min_level} 的事实权重 ${reachW.reduce((s, f) => s + f.weight, 0)} / 全部 ${total}(拿满 D1 需要 ${Math.round(total * ru.full_credit_ratio * 10) / 10})`,
  );

  // ---------------- 4. 参考路径时长 ----------------
  const ratio = d.budget.expert_path_minutes / d.budget.discovery_minutes;
  need(ratio <= 0.9, `参考路径 ${d.budget.expert_path_minutes} 分钟超过预算的 90%(${Math.round(ratio * 100)}%)`);
  if (!scn.readText(d.debrief.expert_path)) warnings.push(`参考路径文稿 ${d.debrief.expert_path} 还没写`);
  if (d.debrief.real_world_note && !scn.readText(d.debrief.real_world_note))
    warnings.push(`现实对照文稿 ${d.debrief.real_world_note} 还没写`);

  // ---------------- 5. 泄露风险 ----------------
  const publicText = [...d.world_public, d.briefing.company, d.briefing.goal, d.briefing.opening.text].join("\n");
  const publicNums = new Set(extractNumbers(publicText).map((n) => n.value));
  for (const f of d.facts) {
    for (const w of f.canaries ?? []) if (publicText.includes(w)) errors.push(`公共背景里出现了事实 ${f.id} 的金丝雀词「${w}」`);
    for (const n of extractNumbers(f.statement)) {
      if (n.value >= 100 && publicNums.has(n.value)) errors.push(`公共背景里出现了事实 ${f.id} 的数字 ${n.raw}`);
    }
  }

  // ---------------- 6. 触发器 ----------------
  const asks = new Map<string, string[]>();
  for (const t of triggers(scn).values()) {
    const key = `${"role" in t ? t.role : "*"}|${t.ask}`;
    asks.set(key, [...(asks.get(key) ?? []), t.id]);
    if (t.kind === "fact") {
      const f = scn.fact(t.factId);
      for (const w of f.canaries ?? []) if (t.ask.includes(w)) errors.push(`触发器 ${t.id} 的描述里含有事实内容「${w}」`);
      for (const n of extractNumbers(t.ask)) if (n.value > 2) warnings.push(`触发器 ${t.id} 的描述里有数字 ${n.raw}`);
    }
  }
  for (const [k, ids] of asks) if (ids.length > 1) warnings.push(`触发器描述重复(${k.split("|")[1]}):${ids.join("、")}`);
  info.push(`触发器 ${triggers(scn).size} 条`);

  return { errors, warnings, info };
}

// ------------------------------------------------------------------
// 乐观可达性:假设玩家每一步都做对,哪些人、事实、资料、验证最终能拿到
// ------------------------------------------------------------------

export interface Reachability {
  roles: Set<string>;
  flags: Set<string>;
  facts: Map<string, Level>;
  artifacts: Set<string>;
  /** 汇报阶段之前就能拿到、因而能打开看的资料(A 级证据只能来自这些)。 */
  openable: Set<string>;
  experiments: Set<string>;
  actions: Set<string>;
  traps: Set<string>;
}

/** 三值判断:这个条件在某个时刻"可能为真"、"可能为假"。 */
interface TV {
  t: boolean;
  f: boolean;
}
const BOTH: TV = { t: true, f: true };

/**
 * 乐观可达性:假设玩家每一步都做对。和引擎的约束保持一致:
 *   - 分阶段推进(开场 → 调研 → 汇报),后面阶段才拿到的东西不能满足前面阶段的条件
 *   - 开场只能和开场人说话;调研阶段可以和任何已出现的人说话;汇报阶段只能和老板说话
 *   - 去现场、做验证、看资料只能在调研阶段(开场时做这些会直接进入调研)
 *   - 主动说出的事实(volunteered)只能由压力时刻的 reveal 说出来
 *   - 条件按三值逻辑判断:每个标识符取它在这一阶段可能取到的值的范围,"TR1 and not TR3" 这类混合条件不会被误判
 */
export function reachability(scn: LoadedScenario): Reachability {
  const d = scn.data;
  const boss = d.briefing.opening.speaker;
  const R: Reachability = {
    roles: new Set(d.roles.filter((r) => r.discovered === "start").map((r) => r.id)),
    flags: new Set(),
    facts: new Map(),
    artifacts: new Set(),
    openable: new Set(),
    experiments: new Set(),
    actions: new Set(),
    traps: new Set(),
  };
  const startRoles = new Set(R.roles);
  const has = (p: string) => d.phases.includes(p as never);
  let stage = "kickoff";
  const talkable = (role: string) => (stage === "discovery" ? R.roles.has(role) : role === boss && R.roles.has(boss));

  const boolOf = (name: string): TV | undefined => {
    const dot = name.indexOf(".");
    if (dot > 0) {
      const ns = name.slice(0, dot);
      const key = name.slice(dot + 1);
      if (ns === "discovered") return startRoles.has(key) ? { t: true, f: false } : { t: R.roles.has(key), f: true };
      if (ns === "opened") return { t: R.openable.has(key) || (stage === "discovery" && R.artifacts.has(key)), f: true };
      return undefined;
    }
    if (name === "no_artifact_opened" || name === "committed_before_any_artifact") return BOTH;
    if (name === "seen_any_artifact") return { t: R.openable.size > 0 || (stage === "discovery" && R.artifacts.size > 0), f: true };
    if (name in d.flags) return { t: R.flags.has(name), f: true };
    if (scn.facts.has(name)) return { t: R.facts.has(name), f: true };
    if (scn.artifacts.has(name)) return { t: R.artifacts.has(name), f: true };
    if (scn.experiments.has(name)) return { t: R.experiments.has(name), f: true };
    if (name in d.actions) return { t: R.actions.has(name), f: true };
    if (scn.traps.has(name)) return { t: R.traps.has(name), f: true };
    return undefined;
  };
  const rangeOf = (name: string): [number, number] | undefined => {
    const dot = name.indexOf(".");
    if (dot < 0) return undefined;
    const ns = name.slice(0, dot);
    const key = name.slice(dot + 1);
    const role = scn.roles.get(key);
    if (!role) return undefined;
    if (ns === "trust") {
      // 信任会被减分行为或 trust.X-N 效果拉低(引擎在 0 封底),所以下限是 0
      const t = role.trust ?? { initial: 0, max: 0 };
      const negEffect = Object.values(d.actions).some((a) => a.effects.some((e) => new RegExp(`^trust\\.${key}\\s*-\\d+$`).test(e)));
      const canDrop = Boolean(role.trust) && (R.roles.has(key) || negEffect);
      return [canDrop ? Math.min(t.initial, 0) : t.initial, R.roles.has(key) ? t.max : t.initial];
    }
    if (ns === "exchanges") return [0, R.roles.has(key) ? Number.POSITIVE_INFINITY : 0];
    return undefined;
  };
  const cmpRange = (op: string, [lo, hi]: [number, number], c: number): TV => {
    switch (op) {
      case ">=":
        return { t: hi >= c, f: lo < c };
      case ">":
        return { t: hi > c, f: lo <= c };
      case "<=":
        return { t: lo <= c, f: hi > c };
      case "<":
        return { t: lo < c, f: hi >= c };
      case "==":
        return { t: lo <= c && c <= hi, f: !(lo === c && hi === c) };
      case "!=":
        return { t: !(lo === c && hi === c), f: lo <= c && c <= hi };
    }
    return BOTH;
  };
  const kleene = (n: ExprNode): TV => {
    switch (n.t) {
      case "num":
        return { t: n.v !== 0, f: n.v === 0 };
      case "id": {
        const b = boolOf(n.name);
        if (b) return b;
        const r = rangeOf(n.name);
        if (r) return { t: r[1] > 0, f: r[0] === 0 };
        return BOTH;
      }
      case "call":
        return BOTH;
      case "not": {
        const v = kleene(n.e);
        return { t: v.f, f: v.t };
      }
      case "and": {
        const a = kleene(n.l);
        const b = kleene(n.r);
        return { t: a.t && b.t, f: a.f || b.f };
      }
      case "or": {
        const a = kleene(n.l);
        const b = kleene(n.r);
        return { t: a.t || b.t, f: a.f && b.f };
      }
      case "cmp": {
        if (n.l.t === "id" && n.l.name === "phase") {
          const rhs = n.r.t === "id" ? n.r.name : n.r.t === "num" ? String(n.r.v) : "";
          const eq = stage === rhs;
          const v = n.op === "==" ? eq : n.op === "!=" ? !eq : false;
          return { t: v, f: !v };
        }
        if (n.l.t === "id" && n.r.t === "num") {
          const r = rangeOf(n.l.name);
          if (r) return cmpRange(n.op, r, n.r.v);
        }
        return BOTH;
      }
    }
  };
  const can = (req: Requirement | undefined): boolean => {
    const tv = (q: Requirement): TV => {
      if (typeof q === "string") {
        try {
          return kleene(parseExpr(q));
        } catch {
          return { t: false, f: true }; // 写不成表达式:由引用检查报错
        }
      }
      const parts = (Array.isArray(q) ? q : "any" in q ? q.any : q.all).map(tv);
      if (!Array.isArray(q) && "any" in q) return { t: parts.some((p) => p.t), f: parts.every((p) => p.f) };
      return { t: parts.every((p) => p.t), f: parts.some((p) => p.f) };
    };
    return req === undefined || tv(req).t;
  };
  const addFact = (id: string, l: Level) => {
    const cur = R.facts.get(id);
    if (!cur || levelRank(l) > levelRank(cur)) {
      R.facts.set(id, l);
      return true;
    }
    return false;
  };

  const doAction = (id: string, mark: <T>(set: Set<T>, v: T) => void) => {
    mark(R.actions, id);
    for (const eff of d.actions[id]!.effects) {
      const m = eff.match(/^discover\s+(\w+)$/);
      if (m) mark(R.roles, m[1]!);
      const s = eff.match(/^set\s+(\w+)$/);
      if (s) mark(R.flags, s[1]!);
    }
  };

  const fixpoint = () => {
    for (let changed = true; changed; ) {
      changed = false;
      const mark = <T>(set: Set<T>, v: T) => {
        if (!set.has(v)) {
          set.add(v);
          changed = true;
        }
      };
      const speakers = [...R.roles].filter(talkable);
      for (const r of d.roles) {
        if (r.discovered === "start" || R.roles.has(r.id)) continue;
        const disc = r.discovered;
        const byRole = disc.by_role?.some((x) => speakers.includes(x));
        const byAction = stage === "discovery" && disc.by_action?.some((x) => R.actions.has(x));
        const byAsk = disc.by_ask !== undefined && speakers.length > 0;
        const byRedirect = speakers.some((x) => Object.values(scn.role(x).redirects).includes(r.id));
        if (byRole || byAction || byAsk || byRedirect) mark(R.roles, r.id);
      }
      for (const [f, def] of Object.entries(d.flags)) if (def.granted_by && talkable(def.granted_by)) mark(R.flags, f);
      for (const t of d.traps) {
        if (R.traps.has(t.id) || !talkable(t.by)) continue;
        if ((t.after ?? []).some((a) => !R.traps.has(a))) continue;
        if (isExpression(t.when) && !can(t.when)) continue;
        mark(R.traps, t.id);
        for (const f of t.sets ?? []) mark(R.flags, f);
        for (const r of t.discover ?? []) mark(R.roles, r);
        if (t.reveal) {
          const rule = scn.facts.get(t.reveal)?.unlock.find((u) => !isViaUnlock(u) && u.role === t.by);
          if (rule) {
            if (addFact(t.reveal, rule.level)) changed = true;
            if (rule.gives) mark(R.artifacts, rule.gives);
          }
        }
      }
      if (stage === "discovery") {
        for (const [id, a] of Object.entries(d.actions)) if (can(a.requires)) doAction(id, mark);
        for (const x of d.experiments) if (can(x.requires)) mark(R.experiments, x.id);
      }
      for (const a of d.artifacts) if (a.unlock && talkable(a.holder) && can(a.unlock.requires)) mark(R.artifacts, a.id);
      for (const f of d.facts) {
        for (const u of f.unlock) {
          let ok: boolean;
          if (isViaUnlock(u)) ok = stage === "discovery" && (R.artifacts.has(u.via) || R.actions.has(u.via) || R.experiments.has(u.via));
          else ok = !u.volunteered && Boolean(u.ask) && talkable(u.role) && can(u.requires);
          if (!ok) continue;
          if (addFact(f.id, u.level)) changed = true;
          if (u.gives) mark(R.artifacts, u.gives);
        }
      }
    }
  };

  // 开场时就能做的动作和验证(前提按开场判断):做了就进入调研,所以结果在调研阶段开始时生效
  const kickoffActions: string[] = [];
  const kickoffExperiments: string[] = [];
  for (const p of ["kickoff", "discovery", "report"]) {
    if (!has(p)) continue;
    stage = p;
    if (p === "discovery") {
      const noop = <T>(set: Set<T>, v: T) => void set.add(v);
      for (const id of kickoffActions) doAction(id, noop);
      for (const id of kickoffExperiments) R.experiments.add(id);
    }
    fixpoint();
    if (p === "kickoff") {
      for (const [id, a] of Object.entries(d.actions)) if (can(a.requires)) kickoffActions.push(id);
      for (const x of d.experiments) if (can(x.requires)) kickoffExperiments.push(x.id);
    }
    if (p === "discovery") R.openable = new Set(R.artifacts);
  }
  return R;
}
