// 回归评测:pnpm evals [--live] [--player EV_good] [--runs 3] [--scenario scenarios/freight-docs] [--gates config/quality-gates.yaml]
//   离线(默认):闸门用脚本里的标准标注,演员用模板,裁判用脚本里的固定输出。完全确定,测导演和算分。
//   在线(--live):闸门、演员用真模型(config/models.yaml),裁判仍用固定输出;额外报告闸门命中率和花费。
// 跑完打印质量门槛表(config/quality-gates.yaml,说明见 docs/quality-gates.md)。
// 退出码:0 玩家断言和要判的门槛全部通过;1 有没过的;2 配置错误(门槛配置写错、--live 缺 Key)。
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LlmActor, LlmGate, loadScenario } from "@fde/engine";
import { createGateway, loadModelsConfig, type LlmCallLog } from "@fde/llm";
import { loadPlayers } from "./players.ts";
import { checkExpectations, runPlayer, type Mode, type PlayerRun } from "./runner.ts";
import { describeIssue } from "./quality/auditor.ts";
import { evalBars, evalRunInput, renderBars, type EvalRunInput } from "./quality/bars.ts";
import { loadQualityGates, type QualityGates } from "./quality/config.ts";
import { liveEnvProblem } from "./quality/live-env.ts";

const root = resolve(import.meta.dirname, "../../..");
const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    player: { type: "string", multiple: true },
    runs: { type: "string", default: "1" },
    scenario: { type: "string", default: "scenarios/freight-docs" },
    gates: { type: "string", default: "config/quality-gates.yaml" },
    verbose: { type: "boolean", short: "v", default: false },
  },
});

const scnDir = resolve(root, values.scenario!);
const scn = loadScenario(scnDir);
const players = loadPlayers(join(scnDir, "evals/players")).filter((p) => !values.player?.length || values.player.includes(p.id));
const specs = new Map((scn.data.evals ?? []).map((e) => [e.id, e]));

let gates: QualityGates;
try {
  gates = loadQualityGates(resolve(root, values.gates!));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const calls: LlmCallLog[] = [];
let mode: Mode = { kind: "offline" };
if (values.live) {
  // 模型配置读不了、写错了,和缺 Key 一样是配置错误(退出码 2),不能当成评测失败
  let cfg: ReturnType<typeof loadModelsConfig>;
  try {
    if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
    cfg = loadModelsConfig(process.env.FDE_MODELS_CONFIG ?? join(root, "config/models.yaml"));
  } catch (e) {
    console.error(`无法用 --live:${(e as Error).message}`);
    process.exit(2);
  }
  const problem = liveEnvProblem(cfg, process.env, ["gate", "actor"]);
  if (problem) {
    console.error(`无法用 --live:${problem}。在仓库根目录的 .env 里配置后重试;没有 Key 时不加 --live。`);
    process.exit(2);
  }
  const chat = createGateway(cfg, { onCall: (l) => calls.push(l) });
  mode = { kind: "live", deps: { gate: new LlmGate(chat), actor: new LlmActor(chat) } };
}

const runs = Math.max(1, Number(values.runs));
const results: (PlayerRun & { expectChecks: ReturnType<typeof checkExpectations> })[] = [];
const barInputs: EvalRunInput[] = [];
let failed = 0;

for (const p of players) {
  for (let r = 0; r < runs; r++) {
    const callsBefore = calls.length;
    const run = await runPlayer(scn, p, mode);
    const specExpect = specs.get(p.id)?.expect ?? {};
    const expect = { ...(p.expect ?? {}), ...specExpect };
    const expectChecks = checkExpectations(run, expect);
    // 玩家文件只能追加断言,不能改写 scenario.yaml 里方案定下的门槛
    for (const k of Object.keys(p.expect ?? {})) {
      if (k in specExpect) expectChecks.push({ name: k, ok: false, detail: "玩家文件的 expect 和 scenario.yaml 的 evals 重名(只能追加,不能改写)" });
    }
    const all = [...run.checks, ...expectChecks];
    const bad = all.filter((c) => !c.ok);
    if (bad.length || run.crashed) failed++;
    results.push({ ...run, expectChecks });
    // 花费按调用顺序切:玩家是一个接一个跑的,不靠 sessionId(同一毫秒开的两局会重名)
    barInputs.push(evalRunInput(run, Boolean(bad.length || run.crashed), calls.slice(callsBefore)));

    const dims = run.dims ? Object.entries(run.dims).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    console.log(
      `${bad.length || run.crashed ? "✗" : "✓"} ${p.id}${runs > 1 ? ` #${r + 1}` : ""}  总分 ${run.total ?? "-"}  ${dims}  用时 ${run.minutesUsed} 分钟 · ${run.turns} 轮`,
    );
    if (run.crashed) console.log(`    崩溃:${run.crashed.split("\n").slice(0, 4).join("\n    ")}`);
    for (const c of values.verbose ? all : bad) console.log(`    ${c.ok ? "·" : "✗"} ${c.name}:${c.detail}`);
    if (run.gateAgreement) {
      const g = run.gateAgreement;
      console.log(`    闸门命中 ${g.matched}/${g.expected},多命中 ${g.extra}`);
    }
    for (const a of run.delivered) {
      for (const i of a.issues) console.log(`    ✗ 交付台词 ${a.ref}(${a.roleId}):${describeIssue(i)}  「${a.text}」`);
      if (values.verbose) for (const e of a.echoes) console.log(`    · 复述了用户说过的数 ${e}(${a.ref}「${a.text}」)`);
    }
    if (!specs.has(p.id)) console.log(`    ! scenario.yaml 的 evals 里没有 ${p.id}`);
  }
}
for (const id of specs.keys()) if (!players.some((p) => p.id === id) && !values.player?.length) console.log(`! 还没有脚本:${id}`);

if (calls.length) {
  const cost = calls.reduce((s, c) => s + (c.costYuan ?? 0), 0);
  const byStage = Object.groupBy(calls, (c) => c.stage);
  console.log(`\n模型调用 ${calls.length} 次,约 ¥${cost.toFixed(3)}`);
  for (const [stage, cs] of Object.entries(byStage)) {
    const lat = cs!.map((c) => c.latencyMs).sort((a, b) => a - b);
    console.log(`  ${stage}: ${cs!.length} 次,失败 ${cs!.filter((c) => !c.ok).length},中位耗时 ${lat[Math.floor(lat.length / 2)]} ms`);
  }
}

const bars = evalBars(barInputs, gates, mode.kind);
console.log("");
for (const l of renderBars(bars, `质量门槛(${values.gates},${mode.kind === "live" ? "在线" : "离线"})`)) console.log(l);

const outDir = join(root, "tools/evals/out");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${values.live ? "live" : "offline"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      scenario: scn.data.meta.id,
      mode: mode.kind,
      bars,
      results: results.map(({ state, report, ...r }) => ({ ...r, ledger: state?.ledger, debrief: report?.markdown })),
      calls,
    },
    null,
    2,
  ),
);
// 玩家全过、门槛没过时也要在最后一行说清楚,不能只看到"N/N 通过"却拿到退出码 1。
// "脚本化玩家断言"这一项就是前面的"N/N 通过",不再算一次:玩家没过、门槛都过时,最后一行和以前一字不差
const barFails = bars.filter((b) => b.status === "fail" && b.id !== "players").length;
console.log(`\n${results.length - failed}/${results.length} 通过${barFails ? `;门槛 ${barFails} 项未过` : ""} · 明细:${file.replace(`${root}/`, "")}`);
process.exit(failed || barFails ? 1 : 0);
