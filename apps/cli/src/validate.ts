// 场景校验:pnpm validate [场景目录...]
import { resolve } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { loadScenario, validateScenario, ScenarioLoadError } from "@fde/engine";

const root = resolve(import.meta.dirname, "../../..");
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(resolve(root, "scenarios"))
      .map((d) => resolve(root, "scenarios", d))
      .filter((d) => existsSync(resolve(d, "scenario.yaml")));

let failed = false;
for (const dir of dirs) {
  console.log(`\n=== ${dir} ===`);
  try {
    const scn = loadScenario(dir);
    const r = validateScenario(scn);
    for (const e of r.errors) console.log(`  ✗ ${e}`);
    for (const w of r.warnings) console.log(`  ! ${w}`);
    for (const i of r.info) console.log(`  · ${i}`);
    console.log(r.errors.length ? `  结果:${r.errors.length} 个错误` : "  结果:通过");
    if (r.errors.length) failed = true;
  } catch (e) {
    failed = true;
    console.log(e instanceof ScenarioLoadError ? `  ✗ ${e.message}` : e);
  }
}
process.exit(failed ? 1 : 0);
