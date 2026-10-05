import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { ScenarioSchema, type Scenario, type Fact, type Role, type Artifact, type Experiment, type Trap } from "./schema.ts";

export class ScenarioLoadError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}\n  - ${issues.join("\n  - ")}` : message);
  }
}

/** 加载后的场景:原始数据 + 常用索引。引擎各处只读它。 */
export interface LoadedScenario {
  dir: string;
  variant: string;
  data: Scenario;
  role(id: string): Role;
  fact(id: string): Fact;
  artifact(id: string): Artifact;
  experiment(id: string): Experiment;
  trap(id: string): Trap;
  roles: Map<string, Role>;
  facts: Map<string, Fact>;
  artifacts: Map<string, Artifact>;
  experiments: Map<string, Experiment>;
  traps: Map<string, Trap>;
  /** 读取场景目录下的文稿(叙述稿、参考路径等);不存在时返回 undefined。 */
  readText(relPath: string): string | undefined;
}

function indexBy<T extends { id: string }>(items: T[], kind: string, issues: string[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) {
    if (m.has(it.id)) issues.push(`${kind} id 重复: ${it.id}`);
    m.set(it.id, it);
  }
  return m;
}

function getter<T>(m: Map<string, T>, kind: string) {
  return (id: string): T => {
    const v = m.get(id);
    if (!v) throw new Error(`未知的 ${kind}: ${id}`);
    return v;
  };
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (Array.isArray(overlay) || typeof overlay !== "object" || overlay === null) return overlay;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return overlay;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) out[k] = deepMerge(out[k], v);
  return out;
}

export function parseScenario(raw: unknown, dir = ".", variant?: string): LoadedScenario {
  const first = ScenarioSchema.safeParse(raw);
  if (!first.success) {
    throw new ScenarioLoadError(
      "scenario.yaml 结构校验失败",
      first.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  let data = first.data;
  const v = variant ?? data.meta.variant;
  if (v !== data.meta.variant) {
    const ov = data.variants?.[v];
    if (!ov) throw new ScenarioLoadError(`场景没有变体 ${v}`);
    if (!ov.overlay) throw new ScenarioLoadError(`变体 ${v} 还没有 overlay 数据(MVP 只实现默认变体)`);
    const merged = ScenarioSchema.safeParse(deepMerge(raw, ov.overlay));
    if (!merged.success) {
      throw new ScenarioLoadError(
        `变体 ${v} 覆盖后结构校验失败`,
        merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      );
    }
    data = merged.data;
  }

  const issues: string[] = [];
  const roles = indexBy(data.roles, "role", issues);
  const facts = indexBy(data.facts, "fact", issues);
  const artifacts = indexBy(data.artifacts, "artifact", issues);
  const experiments = indexBy(data.experiments, "experiment", issues);
  const traps = indexBy(data.traps, "trap", issues);
  if (issues.length) throw new ScenarioLoadError("场景 id 冲突", issues);

  const absDir = resolve(dir);
  return {
    dir: absDir,
    variant: v,
    data,
    roles,
    facts,
    artifacts,
    experiments,
    traps,
    role: getter(roles, "role"),
    fact: getter(facts, "fact"),
    artifact: getter(artifacts, "artifact"),
    experiment: getter(experiments, "experiment"),
    trap: getter(traps, "trap"),
    readText(relPath: string) {
      const p = join(absDir, relPath);
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    },
  };
}

export function loadScenario(dir: string, variant?: string): LoadedScenario {
  const file = join(dir, "scenario.yaml");
  if (!existsSync(file)) throw new ScenarioLoadError(`找不到 ${file}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ScenarioLoadError(`YAML 解析失败: ${(e as Error).message}`);
  }
  return parseScenario(raw, dir, variant);
}
