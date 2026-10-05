// 标定工具(方案 3.4.4,门槛见 3.4.2 第 5、6 条):
//   pnpm calibrate --mock                   每个用例的 judge-fixtures/*.json 按顺序当作裁判第 i 次的输出,不调模型
//   pnpm calibrate --live [--record]        裁判用真模型(config/models.yaml 的 judge 环节,读仓库根目录 .env);
//                                           --record 把这次的裁判输出存成没有 fixture 的用例的 judge-fixtures
//   pnpm calibrate --init <session.json> --id <caseId>
//                                           从一份对局建用例目录,生成待填的 human.yaml 和可读的 transcript.md
//   pnpm calibrate --init-player EV_good --id <caseId>
//                                           同上,对局由脚本化玩家离线跑出来
//   通用:--runs 3(每个用例跑几次)、--case <id>(可重复)、--scenario scenarios/freight-docs、--dir <标定集目录>、-v
// 输出稳定性表、一致性表和总结论。退出码:0 两道门槛都过;1 有门槛没过或用例出错;2 参数或配置错误(如缺 Key、场景读不进来)。
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadScenario, type LoadedScenario } from "@fde/engine";
import { initCase } from "./calibration/cases.ts";
import { CalibrationInputError } from "./calibration/human.ts";
import { createLiveJudge, type LiveJudge } from "./calibration/live.ts";
import { DEFAULT_RUNS } from "./calibration/metrics.ts";
import { playerSession } from "./calibration/player.ts";
import { renderReport } from "./calibration/report.ts";
import { recordFixtures, runCalibration, type JudgeMode } from "./calibration/run.ts";

const root = resolve(import.meta.dirname, "../../..");
// pnpm 会把工作目录切到仓库根目录;用户在别处敲命令时,相对路径按他敲命令的目录解析
const userCwd = process.env.INIT_CWD ?? process.cwd();
// 仓库里的路径显示成相对路径,仓库外的(--dir 指到别处)显示绝对路径
const rel = (p: string) => {
  const r = relative(root, p);
  return r.startsWith("..") || isAbsolute(r) ? p : r || ".";
};

const USAGE = `用法:
  pnpm calibrate --mock [--runs ${DEFAULT_RUNS}] [--case <id>]… [-v]
  pnpm calibrate --live [--runs ${DEFAULT_RUNS}] [--case <id>]… [--record] [-v]
  pnpm calibrate --init <session.json> --id <caseId>
  pnpm calibrate --init-player <EV_id> --id <caseId>
其他选项:--scenario <场景目录>(默认 scenarios/freight-docs)、--dir <标定集目录>(默认 <场景>/evals/calibration)
说明见 docs/calibration.md`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        mock: { type: "boolean", default: false },
        live: { type: "boolean", default: false },
        runs: { type: "string", default: String(DEFAULT_RUNS) },
        case: { type: "string", multiple: true },
        init: { type: "string" },
        "init-player": { type: "string" },
        id: { type: "string" },
        scenario: { type: "string", default: "scenarios/freight-docs" },
        dir: { type: "string" },
        record: { type: "boolean", default: false },
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
  const fail = (msg: string) => {
    console.error(`${msg}\n\n${USAGE}`);
    return 2;
  };
  if (values.mock && values.live) return fail("--mock 和 --live 只能选一个");
  const initPlayer = values["init-player"];
  if (values.init && initPlayer) return fail("--init 和 --init-player 只能选一个");
  if (values.id && !values.init && !initPlayer) return fail("--id 只和 --init / --init-player 一起用");
  if (values.record && !values.live) return fail("--record 只在 --live 下有意义(mock 本来就是回放 fixture)");

  const scnDir = resolve(root, values.scenario!);
  let scn: LoadedScenario;
  try {
    scn = loadScenario(scnDir);
  } catch (e) {
    // 场景目录写错、scenario.yaml 解析或校验不过:属于配置错误(退出码 2),只给原因,不打堆栈
    console.error(`无法读取场景 --scenario ${values.scenario}:${(e as Error).message}`);
    return 2;
  }
  const dir = values.dir ? resolve(userCwd, values.dir) : join(scnDir, "evals/calibration");

  // ---------- --init / --init-player:建用例目录
  if (values.init || initPlayer) {
    if (!values.id) return fail(`${values.init ? "--init" : "--init-player"} 需要同时给 --id <caseId>(用作目录名)`);
    let r: ReturnType<typeof initCase>;
    if (initPlayer) {
      const ps = await playerSession(scn, scnDir, initPlayer);
      if (ps.failedChecks.length) {
        console.error(`! 脚本化玩家 ${initPlayer} 有 ${ps.failedChecks.length} 条断言没过,这局对话可能不是预期的样子(pnpm evals --player ${initPlayer} 看详情)`);
      }
      r = initCase({ scn, calibrationDir: dir, state: ps.state, caseId: values.id });
    } else {
      r = initCase({ scn, calibrationDir: dir, sessionFile: resolve(userCwd, values.init!), caseId: values.id });
    }
    console.log(`已建标定用例 ${values.id}:`);
    for (const f of r.files) console.log(`  ${rel(f)}`);
    console.log(
      `\n下一步:先别跑裁判,读 transcript.md,在 human.yaml 里逐维度打分并写理由;` +
        `\n填完后 pnpm calibrate --live --case ${values.id}(或在 judge-fixtures/ 放裁判输出后用 --mock)。`,
    );
    return 0;
  }

  if (!/^\d+$/.test(values.runs!) || Number(values.runs) < 1) return fail(`--runs 必须是正整数(实际 ${values.runs})`);
  const runs = Number(values.runs);

  // ---------- 选裁判
  let live: LiveJudge | undefined;
  let mode: JudgeMode = { kind: "mock" };
  if (values.live) {
    try {
      live = createLiveJudge(root);
    } catch (e) {
      console.error(`无法用 --live:${(e as Error).message}`);
      return 2;
    }
    mode = { kind: "live", judge: live.judge, onProgress: (m) => console.error(`  ${m}`) };
    console.error(`裁判模型 ${live.model}`);
  } else if (!values.mock) {
    console.error("(没指定 --mock 或 --live,按 --mock 运行)");
  }

  const res = await runCalibration({ scn, dir, runs, mode, ...(values.case?.length && { caseIds: values.case }) });
  for (const line of renderReport(res, scn, { verbose: values.verbose! })) console.log(line);

  if (live?.calls.length) {
    const cost = live.calls.reduce((s, c) => s + (c.costYuan ?? 0), 0);
    const failed = live.calls.filter((c) => !c.ok).length;
    console.log(`\n模型调用 ${live.calls.length} 次(失败 ${failed}),约 ¥${cost.toFixed(3)}`);
  }
  if (values.record) {
    for (const c of res.cases) {
      if (c.error || !c.runs.length) continue;
      const files = recordFixtures(c);
      console.log(files ? `已录制 ${c.id}:${files.map(rel).join("、")}` : `跳过录制 ${c.id}:judge-fixtures/ 里已经有文件(不覆盖)`);
    }
  }

  // 明细(含裁判原始输出)落盘,和 pnpm evals 放在一起
  const outDir = join(root, "tools/evals/out");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `calibrate-${res.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ ...res, calls: live?.calls ?? [] }, null, 2));
  console.log(`明细:${rel(file)}`);
  return res.ok ? 0 : 1;
}

try {
  process.exit(await main());
} catch (e) {
  // 输入文件不合法(human.yaml、session.json、用例 id):给出文件和原因,不打堆栈
  if (e instanceof CalibrationInputError) {
    console.error(`输入有误:${e.message}`);
    process.exit(2);
  }
  throw e;
}
