// 对抗集的格式(scenarios/<场景>/evals/adversarial/*.yaml)。
// 一个对抗集分若干组,每组是一局:先走准备步骤(setup,和脚本化玩家同一种步骤格式、同一种闸门标注,
// 用标注喂导演,保证该出现的人出现、该到的阶段到了),再连续发探测(probes)。
// 探测只写用户的原话:离线用关键词闸门,在线用真闸门,看演员在压力下会不会漏、会不会编。
// 严格模式:拼错的键、未知的事实 id、组 id 重复,都直接报错(退出码 2)。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { triggers, type LoadedScenario } from "@fde/engine";
import { Step, lintPlayer } from "../players.ts";

const Probe = z.strictObject({
  say: z.string().min(1),
  /** 这一句想套的东西:事实 id(P1、C2……)或 meta(系统提示、出戏)。只用于报告和人工核对。 */
  aims: z.array(z.string()).optional(),
});
export type Probe = z.infer<typeof Probe>;

const Group = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "组 id 只含字母、数字、-、_"),
  title: z.string().min(1),
  setup: z.array(Step).default([]),
  probes: z.array(Probe).min(1),
});
export type Group = z.infer<typeof Group>;

const Suite = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  /** 对应方案里的哪条门槛。 */
  plan: z.string().optional(),
  groups: z.array(Group).min(1),
});
export type Suite = z.infer<typeof Suite>;

export class SuiteInputError extends Error {}

export function parseSuite(raw: unknown, file: string): Suite {
  const r = Suite.safeParse(raw);
  if (!r.success) {
    throw new SuiteInputError(`${file}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

/** 脚本自身的错误:未知的触发器、角色、资料、事实 id,组 id 重复。 */
export function lintSuite(scn: LoadedScenario, s: Suite): string[] {
  const errs: string[] = [];
  const known = {
    triggers: new Set(triggers(scn).keys()),
    roles: new Set(scn.roles.keys()),
    artifacts: new Set(scn.artifacts.keys()),
    experiments: new Set(scn.experiments.keys()),
    actions: new Set(Object.keys(scn.data.actions)),
  };
  const seen = new Set<string>();
  for (const g of s.groups) {
    if (seen.has(g.id)) errs.push(`组 id 重复:${g.id}`);
    seen.add(g.id);
    if (g.setup.length) for (const e of lintPlayer({ id: g.id, steps: g.setup }, known)) errs.push(`${g.id} 准备步骤 ${e}`);
    g.probes.forEach((p, i) => {
      for (const a of p.aims ?? []) if (a !== "meta" && !scn.facts.has(a)) errs.push(`${g.id} 探测 #${i + 1} aims 里有未知的事实 ${a}`);
    });
  }
  return errs;
}

/** 读一个目录下的全部对抗集;文件名(不含 .yaml)必须和 id 一致,--suite 按它挑。 */
export function loadSuites(scn: LoadedScenario, dir: string): Suite[] {
  if (!existsSync(dir)) throw new SuiteInputError(`找不到对抗集目录 ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      let raw: unknown;
      try {
        raw = parse(readFileSync(join(dir, f), "utf8"));
      } catch (e) {
        throw new SuiteInputError(`${f}: YAML 解析失败:${(e as Error).message}`);
      }
      const s = parseSuite(raw, f);
      if (s.id !== basename(f, ".yaml")) throw new SuiteInputError(`${f}: id 是 ${s.id},要和文件名一致`);
      const errs = lintSuite(scn, s);
      if (errs.length) throw new SuiteInputError(`${f}: ${errs.join("; ")}`);
      return s;
    });
}
