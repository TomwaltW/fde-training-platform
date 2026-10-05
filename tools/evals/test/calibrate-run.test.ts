// 标定主流程:示例标定集在 mock 模式下达标;故意不稳定的 fixture 组让稳定性不过;
// 一致性不过时按维度列出差异;--live 缺 Key 时点名缺哪个环境变量。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadScenario } from "@fde/engine";
import { loadModelsConfig } from "@fde/llm";
import { createLiveJudge, liveJudgeEnvProblem } from "../src/calibration/live.ts";
import { renderReport } from "../src/calibration/report.ts";
import { recordFixtures, runCalibration } from "../src/calibration/run.ts";
import { scoreJudgeOutput } from "../src/calibration/scoring.ts";

const root = resolve(import.meta.dirname, "../../..");
const scnDir = join(root, "scenarios/freight-docs");
const scn = loadScenario(scnDir);
const calibDir = join(scnDir, "evals/calibration");
const cli = join(root, "tools/evals/src/calibrate.ts");
const tsx = join(root, "node_modules/.bin/tsx");

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "fde-calib-run-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
type Judge = { T: { id: string; verdict: string; grade?: string; evidence: string[] }[]; W: { id: string; met: boolean; evidence: string[] }[] };

/** 复制示例用例 example-EV_good 到临时标定集,可以换掉 fixtures 和人工标注。 */
function copyGood(dir: string, id: string, fixtures?: unknown[], human?: (text: string) => string) {
  const src = join(calibDir, "example-EV_good");
  const dst = join(dir, id);
  mkdirSync(dst, { recursive: true });
  cpSync(join(src, "session.json"), join(dst, "session.json"));
  const text = readFileSync(join(src, "human.yaml"), "utf8");
  writeFileSync(join(dst, "human.yaml"), human ? human(text) : text);
  if (fixtures) {
    mkdirSync(join(dst, "judge-fixtures"));
    fixtures.forEach((f, i) => writeFileSync(join(dst, "judge-fixtures", `${i + 1}.json`), JSON.stringify(f)));
  } else {
    cpSync(join(src, "judge-fixtures"), join(dst, "judge-fixtures"), { recursive: true });
  }
  return dst;
}

describe("示例标定集(mock)", () => {
  it("两个示例用例:稳定性、一致性都达标", async () => {
    const res = await runCalibration({ scn, dir: calibDir, runs: 3, mode: { kind: "mock" } });
    expect(res.cases.map((c) => c.id)).toEqual(["example-EV_good", "example-EV_rush"]);
    expect(res.cases.every((c) => !c.error)).toBe(true);
    // 第 3 份 fixture 故意和前两份有一点差别,但在 ±3 以内
    const good = res.cases[0]!;
    expect(good.stability).toMatchObject({ totals: [98, 98, 96], spread: 2, ok: true });
    expect(res.cases[1]!.stability).toMatchObject({ totals: [4, 4, 6], spread: 2, ok: true });
    // 示例 fixture 本身是干净的:引用的编号都存在,程序校验没有降级
    for (const c of res.cases) for (const r of c.runs) expect(r.issues).toEqual([]);
    // 14 个单元格里只有 EV_rush 的 D5 故意差 2 档
    expect(res.agreement).toMatchObject({ agreed: 13, total: 14, ok: true });
    expect(res.agreement.cells.filter((c) => !c.ok).map((c) => `${c.caseId}:${c.dim}`)).toEqual(["example-EV_rush:D5"]);
    expect(res.ok).toBe(true);

    const text = renderReport(res, scn).join("\n");
    expect(text).toContain("一、裁判稳定性");
    expect(text).toContain("二、与人工标注的一致性");
    expect(text).toMatch(/example-EV_good\s+98 \/ 98 \/ 96\s+2\s+D4 D7\s+✓ 通过/);
    expect(text).toContain("4|0 ✗");
    expect(text).toContain("一致 13/14 = 92.9%");
    expect(text).toContain("→ 达标");
  });

  it("算分走引擎:和 runPlayer 离线跑 EV_good 的结果一致", () => {
    const st = readJson(join(calibDir, "example-EV_good/session.json"));
    const r = scoreJudgeOutput(scn, st, readJson(join(calibDir, "example-EV_good/judge-fixtures/1.json")));
    expect(r.total).toBe(98);
    expect(r.dims).toEqual({ D1: 20, D2: 14, D3: 15, D4: 20, D5: 9, D6: 10, D7: 10 });
    expect(r.items).toMatchObject({ T1: "hit·A", S1: "写进", W5: "是" });
  });

  it("--case 只跑指定用例;不存在的用例报错", async () => {
    const res = await runCalibration({ scn, dir: calibDir, runs: 2, caseIds: ["example-EV_rush"], mode: { kind: "mock" } });
    expect(res.cases.map((c) => c.id)).toEqual(["example-EV_rush"]);
    expect(res.cases[0]!.stability?.totals).toEqual([4, 4]);
    await expect(runCalibration({ scn, dir: calibDir, runs: 3, caseIds: ["nope"], mode: { kind: "mock" } })).rejects.toThrow("没有这些用例:nope");
  });
});

describe("稳定性不过", () => {
  it("故意不稳定的 fixture 组:第 3 次把 T2、T3 判成 miss、W1–W3 判否 → 极差超过 6,列出在变的维度和检查项", async () => {
    const dir = tmp();
    const base = readJson(join(calibDir, "example-EV_good/judge-fixtures/1.json")) as Judge;
    const shaky = structuredClone(base);
    for (const t of shaky.T) if (t.id === "T2" || t.id === "T3") Object.assign(t, { verdict: "miss", evidence: [] });
    for (const w of shaky.W) if (["W1", "W2", "W3"].includes(w.id)) Object.assign(w, { met: false, evidence: [] });
    copyGood(dir, "shaky", [base, base, shaky]);

    const res = await runCalibration({ scn, dir, runs: 3, mode: { kind: "mock" } });
    const s = res.cases[0]!.stability!;
    expect(s.ok).toBe(false);
    expect(s.totals[0]).toBe(98);
    expect(s.spread).toBeGreaterThan(6);
    expect(s.changedDims.map((d) => d.id)).toEqual(["D2", "D4", "D7"]);
    expect(s.changedItems.map((i) => i.id)).toEqual(["T2", "T3", "W1", "W2", "W3"]);
    expect(res.stability).toMatchObject({ ok: false, passed: 0, total: 1 });
    expect(res.ok).toBe(false);

    const text = renderReport(res, scn).join("\n");
    expect(text).toContain("✗ 不过");
    expect(text).toContain("在变的检查项 W1");
    expect(text).toContain("把对应检查项改成更具体的是非题");
    expect(text).toContain("→ 不达标");
  });

  it("mock 模式 fixture 不够 --runs 次:这个用例出错,不当作通过", async () => {
    const dir = tmp();
    const base = readJson(join(calibDir, "example-EV_good/judge-fixtures/1.json"));
    copyGood(dir, "few", [base, base]);
    const res = await runCalibration({ scn, dir, runs: 3, mode: { kind: "mock" } });
    expect(res.cases[0]!.error).toContain("至少 3 份");
    expect(res.ok).toBe(false);
    expect(renderReport(res, scn).join("\n")).toContain("✗ 出错");
  });
});

describe("一致性不过", () => {
  it("人工标注和裁判普遍差 2 档以上 → 比例低于 80%,按维度列出差异最大的用例和理由", async () => {
    const dir = tmp();
    // 把人工分全部压到 0:EV_good 的裁判分大多在第 4 档
    copyGood(dir, "harsh", undefined, (t) => t.replace(/score: [\d.]+/g, "score: 0"));
    copyGood(dir, "same");
    const res = await runCalibration({ scn, dir, runs: 3, mode: { kind: "mock" } });
    expect(res.stability.ok).toBe(true);
    expect(res.agreement.total).toBe(14);
    expect(res.agreement.agreed).toBe(7);
    expect(res.agreement.ok).toBe(false);
    const d4 = res.agreement.byDim.find((d) => d.dim === "D4")!;
    expect(d4.worst[0]).toMatchObject({ caseId: "harsh", human: 0, judge: 20, gap: 4 });

    const text = renderReport(res, scn).join("\n");
    expect(text).toContain("差异最大的用例(按维度;逐条看是规则问题还是抽取问题)");
    expect(text).toContain("✗ harsh  人工 0(第 0 档)vs 裁判 20(第 4 档),差 4 档");
    expect(text).toContain("算分依据:T1 hit·A +6");
    expect(text).toContain("一致性 ✗ 50.0%");
  });

  it("human.yaml 没填完的用例跳过一致性;一份可比的都没有 → 不达标", async () => {
    const dir = tmp();
    copyGood(dir, "draft", undefined, (t) => t.replace("score: 18", "score: null"));
    const res = await runCalibration({ scn, dir, runs: 3, mode: { kind: "mock" } });
    expect(res.agreement.skipped).toEqual([{ id: "draft", reason: "human.yaml 还没填完:D1" }]);
    expect(res.agreement.ok).toBe(false);
    expect(res.ok).toBe(false);
  });

  it("human.yaml 不合法:这个用例出错并带上文件路径", async () => {
    const dir = tmp();
    copyGood(dir, "bad", undefined, (t) => t.replace("score: 18", "score: 25"));
    const res = await runCalibration({ scn, dir, runs: 3, mode: { kind: "mock" } });
    expect(res.cases[0]!.error).toContain(join(dir, "bad/human.yaml"));
    expect(res.cases[0]!.error).toContain("满分是 20");
    expect(res.ok).toBe(false);
  });
});

describe("--live", () => {
  it("缺裁判的 Key:点名缺哪个环境变量", () => {
    const cfg = loadModelsConfig(join(root, "config/models.yaml"));
    expect(liveJudgeEnvProblem(cfg, {})).toContain("缺少环境变量 DEEPSEEK_API_KEY");
    expect(liveJudgeEnvProblem(cfg, { DEEPSEEK_API_KEY: "  " })).toContain("DEEPSEEK_API_KEY");
    expect(liveJudgeEnvProblem(cfg, { DEEPSEEK_API_KEY: "sk-test" })).toBeNull();
    expect(() => createLiveJudge(root, {})).toThrow(/缺少环境变量 DEEPSEEK_API_KEY.*--mock/);
  });

  it("裁判用注入的 JudgePort 跑 N 次,失败时这个用例出错;--record 只写到没有 fixture 的用例", async () => {
    const dir = tmp();
    const base = readJson(join(calibDir, "example-EV_good/judge-fixtures/1.json"));
    const caseDir = copyGood(dir, "rec", []);
    let n = 0;
    const res = await runCalibration({
      scn,
      dir,
      runs: 3,
      mode: { kind: "live", judge: { judge: async () => (n++, base) } },
    });
    expect(n).toBe(3);
    expect(res.cases[0]!.stability).toMatchObject({ totals: [98, 98, 98], ok: true });
    expect(recordFixtures(res.cases[0]!)).toEqual([1, 2, 3].map((i) => join(caseDir, "judge-fixtures", `${i}.json`)));
    expect(recordFixtures(res.cases[0]!)).toBeNull(); // 已经有了,不覆盖
    const replay = await runCalibration({ scn, dir, runs: 3, mode: { kind: "mock" } });
    expect(replay.cases[0]!.stability?.totals).toEqual([98, 98, 98]);

    const broken = await runCalibration({
      scn,
      dir,
      runs: 3,
      mode: { kind: "live", judge: { judge: async () => Promise.reject(new Error("429 限流")) } },
    });
    expect(broken.cases[0]!.error).toContain("第 1 次裁判调用失败:429 限流");
    expect(broken.ok).toBe(false);
  });
});

describe("命令行", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      const stdout = execFileSync(tsx, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, stdio: "pipe" });
      return { code: 0, out: stdout };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  it("--live 没有 Key:非 0 退出,打印缺少的环境变量", () => {
    // 用一份裁判 Key 变量名独一无二的模型配置,保证本机 .env 里有 Key 时也不会真的调模型
    const dir = tmp();
    const cfg = readFileSync(join(root, "config/models.yaml"), "utf8").replace("api_key_env: DEEPSEEK_API_KEY", "api_key_env: FDE_CALIBRATE_TEST_NO_SUCH_KEY");
    writeFileSync(join(dir, "models.yaml"), cfg);
    const r = run(["--live"], { FDE_MODELS_CONFIG: join(dir, "models.yaml") });
    expect(r.code).toBe(2);
    expect(r.out).toContain("缺少环境变量 FDE_CALIBRATE_TEST_NO_SUCH_KEY");
  }, 30_000);

  it("--init 少了 --id、--mock 和 --live 同时给:参数错误", () => {
    expect(run(["--init", "x.json"])).toMatchObject({ code: 2 });
    expect(run(["--init", "x.json"]).out).toContain("--init 需要同时给 --id");
    expect(run(["--mock", "--live"]).out).toContain("只能选一个");
    expect(run(["--runs", "0"]).out).toContain("--runs 必须是正整数");
  }, 30_000);
});
