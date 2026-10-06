// 标定主流程:读用例 → 每个用例跑 N 次裁判(mock 用 fixture,live 用真模型)→ 引擎算分
// → 稳定性(每个用例的总分极差)+ 一致性(所有用例 × 维度与人工标注的档位差)。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgePort, LoadedScenario } from "@fde/engine";
import { CASE_ID, FIXTURE_DIR, listCaseIds, loadCase, type CalibrationCase } from "./cases.ts";
import { CalibrationInputError, dimSpecs, type DimSpec, type HumanParse } from "./human.ts";
import {
  checkStability,
  compareCell,
  median,
  summarizeAgreement,
  type AgreementCell,
  type AgreementSummary,
  type StabilityVerdict,
} from "./metrics.ts";
import { hasUserTurns, scoreJudgeOutput, type ScoredRun } from "./scoring.ts";

/** 方案 3.4.4:标定集要攒够 20 份。 */
export const TARGET_CASES = 20;
/** 示例用例的目录名前缀;和真实用例混在一起时提醒删掉。 */
export const EXAMPLE_PREFIX = "example-";

export type JudgeMode =
  | { kind: "mock" }
  | { kind: "live"; judge: JudgePort; onProgress?: (msg: string) => void };

export interface CaseResult {
  id: string;
  dir: string;
  /** 读文件失败、fixture 不够、裁判调用失败。出错的用例两道门槛都算不过。 */
  error?: string;
  warnings: string[];
  runs: ScoredRun[];
  stability?: StabilityVerdict;
  human: HumanParse | null;
  /** 一致性比较用的裁判分:各维度在多次运行里的中位数(方案 3.4.2 "跑 3 次取中位")。 */
  judgeDims?: Record<string, number>;
  /** 维度 id → 分数等于中位数的那次运行(下标),差异明细里用它的算分依据和检查项判定对照人工理由。 */
  judgeRun?: Record<string, number>;
}

export interface CalibrationResult {
  scenario: string;
  mode: JudgeMode["kind"];
  runs: number;
  dims: DimSpec[];
  cases: CaseResult[];
  stability: { ok: boolean; passed: number; total: number };
  agreement: AgreementSummary & { skipped: { id: string; reason: string }[] };
  ok: boolean;
  warnings: string[];
}

export interface CalibrationOptions {
  scn: LoadedScenario;
  /** 标定集目录(scenarios/<场景>/evals/calibration)。 */
  dir: string;
  runs: number;
  /** 只跑这些用例;不传跑全部。 */
  caseIds?: string[];
  mode: JudgeMode;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function judgeCase(opts: CalibrationOptions, c: CalibrationCase): Promise<ScoredRun[]> {
  const { scn, runs, mode } = opts;
  if (mode.kind === "mock") {
    if (c.fixtures.length < runs) {
      throw new Error(`mock 模式需要至少 ${runs} 份 ${FIXTURE_DIR}/*.json(第 i 份当作裁判的第 i 次输出),现在只有 ${c.fixtures.length} 份`);
    }
    return c.fixtures.slice(0, runs).map((f) => scoreJudgeOutput(scn, c.state, f.raw));
  }
  const out: ScoredRun[] = [];
  for (let i = 0; i < runs; i++) {
    // 一句话都没说的对局,Engine.finish 不调裁判;这里也不花这个钱
    if (!hasUserTurns(c.state)) {
      out.push(scoreJudgeOutput(scn, c.state, null));
      continue;
    }
    mode.onProgress?.(`裁判 ${c.id} 第 ${i + 1}/${runs} 次…`);
    let raw: unknown;
    try {
      raw = await mode.judge.judge({ scn, st: structuredClone(c.state) });
    } catch (e) {
      // 真模型失败时引擎会按空结果算分;标定时不能这样,否则会被当成"裁判不稳定"
      throw new Error(`第 ${i + 1} 次裁判调用失败:${errMsg(e)}`);
    }
    out.push(scoreJudgeOutput(scn, c.state, raw));
  }
  return out;
}

/** 各维度取中位数;同时找一次"该维度分数等于中位数"的运行(偶数次时可能没有,取第一次)。 */
function medianDims(runs: ScoredRun[], dims: DimSpec[]) {
  const judgeDims: Record<string, number> = {};
  const judgeRun: Record<string, number> = {};
  for (const d of dims) {
    const m = median(runs.map((r) => r.dims[d.id] ?? 0));
    judgeDims[d.id] = m;
    judgeRun[d.id] = Math.max(0, runs.findIndex((r) => r.dims[d.id] === m));
  }
  return { judgeDims, judgeRun };
}

export async function runCalibration(opts: CalibrationOptions): Promise<CalibrationResult> {
  const { scn, dir, runs, mode } = opts;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs 必须是正整数(实际 ${runs})`);
  const dims = dimSpecs(scn);
  const all = listCaseIds(dir);
  const warnings: string[] = [];
  let ids = all;
  if (opts.caseIds?.length) {
    const unknown = opts.caseIds.filter((id) => !all.includes(id));
    if (unknown.length) {
      throw new CalibrationInputError(dir, [`没有这些用例:${unknown.join("、")}(现有:${all.join("、") || "无"})`]);
    }
    ids = all.filter((id) => opts.caseIds!.includes(id));
  }

  const cases: CaseResult[] = [];
  for (const id of ids) {
    const caseDir = join(dir, id);
    const res: CaseResult = { id, dir: caseDir, warnings: [], runs: [], human: null };
    cases.push(res);
    if (!CASE_ID.test(id)) {
      res.error = `目录名「${id}」不是合法的用例 id(字母或数字开头,只含字母、数字、-、_)`;
      continue;
    }
    let c: CalibrationCase;
    try {
      c = loadCase(caseDir, id, scn);
    } catch (e) {
      res.error = errMsg(e);
      continue;
    }
    res.human = c.human;
    res.warnings.push(...c.warnings);
    try {
      res.runs = await judgeCase(opts, c);
    } catch (e) {
      res.error = errMsg(e);
      continue;
    }
    res.stability = checkStability(res.runs);
    Object.assign(res, medianDims(res.runs, dims));
  }

  // ---------- 一致性:只统计人工标注已填完、裁判也跑成功的用例
  const cells: AgreementCell[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const c of cases) {
    if (c.error) skipped.push({ id: c.id, reason: "用例出错" });
    else if (c.human?.status === "draft") skipped.push({ id: c.id, reason: `human.yaml 还没填完:${c.human.pending.join("、")}` });
    else if (c.human?.status === "ok" && c.judgeDims) {
      for (const d of dims) cells.push(compareCell(c.id, d.id, d.max, c.human.human.dims[d.id]!.score, c.judgeDims[d.id]!));
    }
  }
  const agreement = { ...summarizeAgreement(cells, dims.map((d) => d.id)), skipped };

  const stabilityPassed = cases.filter((c) => c.stability?.ok).length;
  const stability = { ok: cases.length > 0 && stabilityPassed === cases.length, passed: stabilityPassed, total: cases.length };

  if (!cases.length) warnings.push(`标定集是空的:${dir} 下还没有用例(用 --init 建一个)`);
  else if (!opts.caseIds?.length && cases.length < TARGET_CASES) {
    warnings.push(`标定集只有 ${cases.length} 份,方案 3.4.4 要求 ${TARGET_CASES} 份(自己玩 5、内测 10、脚本化玩家 5)`);
  }
  const examples = all.filter((id) => id.startsWith(EXAMPLE_PREFIX));
  if (examples.length && examples.length < all.length) {
    warnings.push(`标定集里还混着示例用例 ${examples.join("、")}(示例标注不是真实标注),正式标定前请删掉`);
  }

  return {
    scenario: scn.data.meta.id,
    mode: mode.kind,
    runs,
    dims,
    cases,
    stability,
    agreement,
    ok: stability.ok && agreement.ok && cases.every((c) => !c.error),
    warnings,
  };
}

/**
 * --record:把 live 跑出来的裁判原始输出存成这个用例的 judge-fixtures/1.json…,以后 mock 模式回放。
 * 已经有 fixture 的用例不动(不覆盖手写或之前录的),返回 null。
 */
export function recordFixtures(c: CaseResult): string[] | null {
  const dir = join(c.dir, FIXTURE_DIR);
  if (existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(".json"))) return null;
  mkdirSync(dir, { recursive: true });
  return c.runs.map((r, i) => {
    const file = join(dir, `${i + 1}.json`);
    writeFileSync(file, `${JSON.stringify(r.raw, null, 2)}\n`);
    return file;
  });
}
