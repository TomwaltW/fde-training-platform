// 触发器目录:闸门只拿到"什么样的提问算命中"的描述,拿不到事实内容(方案 3.3.2)。
// 目录对一个场景是静态的,放在闸门提示词的固定部分,便于命中上下文缓存。
import { isExpression } from "./expr.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import { isViaUnlock, type Level, type RoleUnlock } from "./scenario/schema.ts";

export type Trigger =
  | { kind: "fact"; id: string; ask: string; role: string; factId: string; level: Level; rule: RoleUnlock }
  | { kind: "artifact"; id: string; ask: string; role: string; artifactId: string }
  | { kind: "find"; id: string; ask: string; findRole: string }
  | { kind: "trap"; id: string; ask: string; role: string; trapId: string }
  | { kind: "perm"; id: string; ask: string; role: string; flag: string }
  | { kind: "exp"; id: string; ask: string; experimentId: string }
  | { kind: "act"; id: string; ask: string; actionId: string };

export const factTriggerId = (factId: string, role: string, level: Level) => `${factId}@${role}:${level}`;

const cache = new WeakMap<LoadedScenario, Map<string, Trigger>>();

export function triggers(scn: LoadedScenario): Map<string, Trigger> {
  const hit = cache.get(scn);
  if (hit) return hit;
  const d = scn.data;
  const list: Trigger[] = [];
  for (const f of d.facts) {
    for (const u of f.unlock) {
      if (isViaUnlock(u) || u.volunteered || !u.ask) continue;
      list.push({ kind: "fact", id: factTriggerId(f.id, u.role, u.level), ask: u.ask, role: u.role, factId: f.id, level: u.level, rule: u });
    }
  }
  for (const a of d.artifacts) {
    if (a.unlock) list.push({ kind: "artifact", id: `${a.id}@${a.holder}:L3`, ask: a.unlock.ask, role: a.holder, artifactId: a.id });
  }
  for (const r of d.roles) {
    if (r.discovered !== "start" && r.discovered.by_ask)
      list.push({ kind: "find", id: `find:${r.id}`, ask: r.discovered.by_ask, findRole: r.id });
  }
  for (const t of d.traps) {
    if (!isExpression(t.when)) list.push({ kind: "trap", id: `${t.id}@${t.by}`, ask: t.when, role: t.by, trapId: t.id });
  }
  for (const [flag, f] of Object.entries(d.flags)) {
    if (f.granted_by) list.push({ kind: "perm", id: `perm:${flag}`, ask: `请求授权:${f.desc}`, role: f.granted_by, flag });
  }
  for (const x of d.experiments) list.push({ kind: "exp", id: `exp:${x.id}`, ask: `提出做这个验证:${x.title}`, experimentId: x.id });
  for (const [id, a] of Object.entries(d.actions)) list.push({ kind: "act", id: `act:${id}`, ask: `提出:${a.title}`, actionId: id });

  const m = new Map<string, Trigger>();
  for (const t of list) m.set(t.id, t);
  cache.set(scn, m);
  return m;
}

/** 给闸门的目录:只有 id、角色和"什么样的提问算命中"。 */
export function gateCatalog(scn: LoadedScenario): { id: string; role?: string; ask: string }[] {
  return [...triggers(scn).values()].map((t) => {
    const role = "role" in t ? t.role : undefined;
    return role ? { id: t.id, role, ask: t.ask } : { id: t.id, ask: t.ask };
  });
}
