// 回归评测:pnpm evals [--live] [--player EV_good] [--runs 3] [--scenario scenarios/freight-docs]
//   离线(默认):闸门用脚本里的标准标注,演员用模板,裁判用脚本里的固定输出。完全确定,测导演和算分。
//   在线(--live):闸门、演员用真模型(config/models.yaml),裁判仍用固定输出;额外报告闸门命中率和花费。
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LlmActor, LlmGate, loadScenario } from "@fde/engine";
import { createGateway, loadModelsConfig, type LlmCallLog } from "@fde/llm";
import { loadPlayers } from "./players.ts";
import { checkExpectations, runPlayer, type Mode, type PlayerRun } from "./runner.ts";

const root = resolve(import.meta.dirname, "../../..");
const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    player: { type: "string", multiple: true },
    runs: { type: "string", default: "1" },
    scenario: { type: "string", default: "scenarios/freight-docs" },
    verbose: { type: "boolean", short: "v", default: false },
  },
});

const scnDir = resolve(root, values.scenario!);
const scn = loadScenario(scnDir);
const players = loadPlayers(join(scnDir, "evals/players")).filter((p) => !values.player?.length || values.player.includes(p.id));
const specs = new Map((scn.data.evals ?? []).map((e) => [e.id, e]));

const calls: LlmCallLog[] = [];
let mode: Mode = { kind: "offline" };
if (values.live) {
  if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
  const cfg = loadModelsConfig(process.env.FDE_MODELS_CONFIG ?? join(root, "config/models.yaml"));
  const chat = createGateway(cfg, { onCall: (l) => calls.push(l) });
  mode = { kind: "live", deps: { gate: new LlmGate(chat), actor: new LlmActor(chat) } };
}

const runs = Math.max(1, Number(values.runs));
const results: (PlayerRun & { expectChecks: ReturnType<typeof checkExpectations> })[] = [];
let failed = 0;

for (const p of players) {
  for (let r = 0; r < runs; r++) {
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

const outDir = join(root, "tools/evals/out");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${values.live ? "live" : "offline"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      scenario: scn.data.meta.id,
      mode: mode.kind,
      results: results.map(({ state, report, ...r }) => ({ ...r, ledger: state?.ledger, debrief: report?.markdown })),
      calls,
    },
    null,
    2,
  ),
);
console.log(`\n${results.length - failed}/${results.length} 通过 · 明细:${file.replace(`${root}/`, "")}`);
process.exit(failed ? 1 : 0);
