// 对抗集:pnpm evals:adversarial [--live] [--suite leak|numbers]… [--scenario scenarios/freight-docs] [--gates config/quality-gates.yaml] [-v]
//   离线(默认):准备步骤用脚本标注,探测用关键词闸门 + 模板台词。确定性的冒烟测试:证明工具能跑、审计不误报。
//   在线(--live):探测用真闸门 + 真演员(config/models.yaml,读仓库根目录 .env)。判泄露、编造两道门槛,
//                  报告守卫拦截率、兜底率、每轮耗时和花费。
// 对抗集在 <场景>/evals/adversarial/*.yaml,格式见 tools/evals/src/adversarial/suite.ts,说明见 docs/quality-gates.md。
// 退出码:0 门槛全部通过;1 有门槛没过或某组崩溃;2 参数或配置错误(对抗集写错、门槛配置写错、--live 缺 Key)。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LlmActor, LlmGate, loadScenario, type LoadedScenario } from "@fde/engine";
import { createGateway, loadModelsConfig, type LlmCallLog } from "@fde/llm";
import { runSuite, suiteBarInput, type AdversarialMode, type SuiteRun } from "./adversarial/runner.ts";
import { loadSuites, SuiteInputError, type Suite } from "./adversarial/suite.ts";
import { describeIssue } from "./quality/auditor.ts";
import { adversarialBars, barsFailed, renderBars } from "./quality/bars.ts";
import { loadQualityGates, type QualityGates } from "./quality/config.ts";
import { liveEnvProblem } from "./quality/live-env.ts";

const root = resolve(import.meta.dirname, "../../..");

const USAGE = `用法:
  pnpm evals:adversarial [--live] [--suite leak|numbers]… [-v]
其他选项:--scenario <场景目录>(默认 scenarios/freight-docs)、--gates <门槛配置>(默认 config/quality-gates.yaml)
说明见 docs/quality-gates.md`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        live: { type: "boolean", default: false },
        suite: { type: "string", multiple: true },
        scenario: { type: "string", default: "scenarios/freight-docs" },
        gates: { type: "string", default: "config/quality-gates.yaml" },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    console.error(`参数错误:${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const scnDir = resolve(root, values.scenario!);
  let scn: LoadedScenario;
  let gates: QualityGates;
  let suites: Suite[];
  try {
    scn = loadScenario(scnDir);
  } catch (e) {
    console.error(`无法读取场景 --scenario ${values.scenario}:${(e as Error).message}`);
    return 2;
  }
  try {
    gates = loadQualityGates(resolve(root, values.gates!));
    suites = loadSuites(scn, join(scnDir, "evals/adversarial"));
  } catch (e) {
    console.error(`${e instanceof SuiteInputError ? "对抗集有误:" : ""}${(e as Error).message}`);
    return 2;
  }
  const unknown = (values.suite ?? []).filter((id) => !suites.some((s) => s.id === id));
  if (unknown.length) {
    console.error(`没有对抗集 ${unknown.join("、")}(现有:${suites.map((s) => s.id).join("、")})\n\n${USAGE}`);
    return 2;
  }
  if (values.suite?.length) suites = suites.filter((s) => values.suite!.includes(s.id));

  const calls: LlmCallLog[] = [];
  let mode: AdversarialMode = { kind: "offline" };
  if (values.live) {
    try {
      if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
      const cfg = loadModelsConfig(process.env.FDE_MODELS_CONFIG ?? join(root, "config/models.yaml"));
      const problem = liveEnvProblem(cfg, process.env, ["gate", "actor"]);
      if (problem) throw new Error(`${problem}。在仓库根目录的 .env 里配置后重试;没有 Key 时不加 --live。`);
      const chat = createGateway(cfg, { onCall: (l) => calls.push(l) });
      mode = { kind: "live", gate: new LlmGate(chat), actor: new LlmActor(chat) };
      console.error(`闸门 ${cfg.stages.gate.provider}/${cfg.stages.gate.model} · 演员 ${cfg.stages.actor.provider}/${cfg.stages.actor.model}`);
    } catch (e) {
      console.error(`无法用 --live:${(e as Error).message}`);
      return 2;
    }
  }

  const runs: SuiteRun[] = [];
  for (const s of suites) {
    const run = await runSuite(scn, s, mode, calls);
    runs.push(run);
    console.log(`\n== ${s.id}:${s.title}`);
    for (const g of run.groups) {
      const sent = g.probes.filter((p) => p.delivered).length;
      const issues = g.delivered.reduce((n, a) => n + a.issues.length, 0);
      const ok = !g.crashed && !g.setupProblems.length && !issues;
      console.log(`${ok ? "✓" : "✗"} ${g.group} ${g.title}  ${sent}/${g.probes.length} 轮送达${issues ? ` · ${issues} 处问题` : ""}`);
      if (g.crashed) console.log(`    崩溃:${g.crashed.split("\n").slice(0, 4).join("\n    ")}`);
      for (const p of g.setupProblems) console.log(`    ✗ ${p}`);
      for (const a of g.delivered) for (const i of a.issues) console.log(`    ✗ ${a.ref}(${a.roleId}):${describeIssue(i)}  「${a.text}」`);
      for (const p of g.probes.filter((x) => !x.delivered)) console.log(`    · 没送达:「${p.say}」→ ${p.system.join(" | ") || "无"}`);
      if (values.verbose) {
        for (const p of g.probes) console.log(`    > ${p.say}\n      ${p.reply ?? `(${p.system.join(" | ") || "无回复"})`}${p.ms !== undefined ? `  [${p.ms} ms]` : ""}`);
        for (const a of g.delivered) for (const e of a.echoes) console.log(`    · 复述了用户说过的数 ${e}(${a.ref})`);
      }
    }
  }

  const bars = adversarialBars(runs.map(suiteBarInput), gates, mode.kind);
  console.log("");
  for (const l of renderBars(bars, `质量门槛 · 对抗集(${values.gates},${mode.kind === "live" ? "在线" : "离线"})`)) console.log(l);

  const outDir = join(root, "tools/evals/out");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `adversarial-${mode.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ scenario: scn.data.meta.id, mode: mode.kind, bars, suites: runs, calls }, null, 2));
  console.log(`明细:${file.replace(`${root}/`, "")}`);
  return barsFailed(bars) ? 1 : 0;
}

process.exit(await main());
