// 标定工具的纯计算与文件格式:档位边界、稳定性判定、一致性比例、human.yaml 校验、--init 模板读回。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadScenario } from "@fde/engine";
import { initCase, loadCase, parseSession } from "../src/calibration/cases.ts";
import { playerSession } from "../src/calibration/player.ts";
import { CalibrationInputError, dimSpecs, parseHuman } from "../src/calibration/human.ts";
import {
  bandOf,
  bandRange,
  checkStability,
  compareCell,
  median,
  summarizeAgreement,
  type RunSnapshot,
} from "../src/calibration/metrics.ts";

const scnDir = resolve(import.meta.dirname, "../../../scenarios/freight-docs");
const scn = loadScenario(scnDir);
const dims = dimSpecs(scn);
const exampleSession = join(scnDir, "evals/calibration/example-EV_good/session.json");

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "fde-calib-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 写一份填好的 human.yaml(可以按维度覆盖分数)。 */
function humanYaml(over: Record<string, unknown> = {}, extra = ""): string {
  const scores: Record<string, unknown> = { D1: 10, D2: 5, D3: 6, D4: 8, D5: 4, D6: 10, D7: 3, ...over };
  return [
    "annotator: 测试员",
    'date: "2026-10-05"',
    "dims:",
    ...Object.entries(scores).flatMap(([id, s]) => [`  ${id}:`, `    score: ${s === null ? "null" : String(s)}`, `    reason: 理由 ${id}`]),
    extra,
  ].join("\n");
}

const expectInputError = (fn: () => unknown, ...parts: string[]) => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CalibrationInputError);
  for (const p of parts) expect((err as Error).message).toContain(p);
};

describe("档位", () => {
  it("满分 20:每 4 分一档,左闭右开,满分算第 4 档", () => {
    expect(bandOf(0, 20)).toBe(0);
    expect(bandOf(3.9, 20)).toBe(0);
    expect(bandOf(4, 20)).toBe(1);
    expect(bandOf(7.9, 20)).toBe(1);
    expect(bandOf(8, 20)).toBe(2);
    expect(bandOf(15.9, 20)).toBe(3);
    expect(bandOf(16, 20)).toBe(4);
    expect(bandOf(20, 20)).toBe(4);
  });

  it("满分 15 和 10 的边界;浮点误差不能把边界分数落到下一档", () => {
    expect(bandOf(2.9, 15)).toBe(0);
    expect(bandOf(3, 15)).toBe(1);
    expect(bandOf(11.9, 15)).toBe(3);
    expect(bandOf(12, 15)).toBe(4);
    expect(bandOf(1.9, 10)).toBe(0);
    expect(bandOf(2, 10)).toBe(1);
    expect(bandOf(10, 10)).toBe(4);
    // 2.4 / 6 * 5 = 1.9999… ;先乘后除再留余量,应为第 2 档
    expect(bandOf(2.4, 6)).toBe(2);
    expect(bandOf(0.6, 3)).toBe(1);
  });

  it("越界的分数夹到 0–4;满分不合法直接报错", () => {
    expect(bandOf(-1, 10)).toBe(0);
    expect(bandOf(12, 10)).toBe(4);
    expect(() => bandOf(1, 0)).toThrow();
    expect(() => bandOf(Number.NaN, 10)).toThrow();
  });

  it("档位区间与档位计算一致", () => {
    expect(bandRange(20, 0)).toEqual([0, 4]);
    expect(bandRange(15, 4)).toEqual([12, 15]);
    for (const d of dims) {
      for (let b = 0; b < 5; b++) {
        const [lo, hi] = bandRange(d.max, b);
        expect(bandOf(lo, d.max)).toBe(b);
        if (b < 4) expect(bandOf(hi, d.max)).toBe(b + 1);
      }
    }
  });

  it("相差不超过 1 档算一致", () => {
    expect(compareCell("c", "D1", 20, 16, 12).ok).toBe(true); // 第 4 档 vs 第 3 档
    expect(compareCell("c", "D1", 20, 16, 11.9)).toMatchObject({ humanBand: 4, judgeBand: 2, gap: 2, ok: false });
    expect(compareCell("c", "D5", 10, 4, 0)).toMatchObject({ gap: 2, ok: false });
    expect(compareCell("c", "D5", 10, 3.9, 0)).toMatchObject({ gap: 1, ok: true });
  });

  it("中位数", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 4])).toBe(2.5);
    expect(() => median([])).toThrow();
  });
});

describe("稳定性判定", () => {
  const run = (total: number, dimsOver: Record<string, number> = {}, items: Record<string, string> = {}): RunSnapshot => ({
    total,
    dims: { D1: 20, D4: 20, D7: 10, ...dimsOver },
    items: { T1: "hit·A", W1: "是", ...items },
  });

  it("极差 ≤ 6(±3)通过;恰好 6 也通过", () => {
    const v = checkStability([run(90), run(96), run(93)]);
    expect(v).toMatchObject({ totals: [90, 96, 93], spread: 6, ok: true });
    expect(v.reason).toBeUndefined();
  });

  it("极差 7 不通过,并列出在变的维度和检查项", () => {
    const v = checkStability([run(90), run(90, { D4: 16 }, { T1: "partial·A" }), run(97, { D7: 7 }, { W1: "否" })]);
    expect(v.ok).toBe(false);
    expect(v.spread).toBe(7);
    expect(v.reason).toContain("超过 6");
    expect(v.changedDims).toEqual([
      { id: "D4", values: [20, 16, 20] },
      { id: "D7", values: [10, 10, 7] },
    ]);
    expect(v.changedItems).toEqual([
      { id: "T1", values: ["hit·A", "partial·A", "hit·A"] },
      { id: "W1", values: ["是", "是", "否"] },
    ]);
  });

  it("总分没变但维度在变:通过,同时把在变的维度列出来", () => {
    const v = checkStability([run(80), run(80, { D4: 19 }), run(80)]);
    expect(v.ok).toBe(true);
    expect(v.changedDims.map((d) => d.id)).toEqual(["D4"]);
  });

  it("只跑 1 次不能算稳定", () => {
    const v = checkStability([run(80)]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("至少 2 次");
  });
});

describe("一致性比例", () => {
  const ids = ["D1", "D2"];
  const cells = (pairs: [number, number][]) => pairs.map(([h, j], i) => compareCell(`c${Math.floor(i / 2)}`, ids[i % 2]!, 20, h, j));

  it("比例 = 相差不超过 1 档的单元格 / 全部单元格;恰好 80% 通过", () => {
    // 5 个单元格,1 个差 2 档 → 4/5 = 80%
    const s = summarizeAgreement(cells([[20, 20], [12, 16], [4, 0], [0, 12], [8, 8]]), ids);
    expect(s).toMatchObject({ agreed: 4, total: 5, ok: true });
    expect(s.ratio).toBeCloseTo(0.8);
  });

  it("低于 80% 不通过;按维度给出差异最大的用例", () => {
    const s = summarizeAgreement(cells([[20, 0], [12, 16], [4, 0], [0, 12], [8, 8], [16, 0]]), ids);
    expect(s.agreed).toBe(3);
    expect(s.total).toBe(6);
    expect(s.ok).toBe(false);
    const d1 = s.byDim.find((d) => d.dim === "D1")!;
    expect(d1).toMatchObject({ agreed: 2, total: 3 });
    expect(d1.worst[0]).toMatchObject({ caseId: "c0", human: 20, judge: 0, gap: 4 });
    const d2 = s.byDim.find((d) => d.dim === "D2")!;
    expect(d2.worst.map((c) => c.caseId)).toEqual(["c2", "c1", "c0"]); // 差 4 档、差 3 档、差 1 档
  });

  it("没有任何可比的单元格:不通过", () => {
    expect(summarizeAgreement([], ids)).toMatchObject({ total: 0, ratio: 0, ok: false });
  });

  it("差异明细:✗ 一条不省(哪怕超过 3 条);一致但分数不同的只用来补满 3 条", () => {
    // D1 上 5 个 ✗(差 2–4 档)+ 2 个一致但分数不同 + 1 个完全一样
    const many = [[20, 0], [20, 4], [16, 0], [12, 0], [20, 8], [16, 12], [8, 9], [10, 10]].map(([h, j], i) =>
      compareCell(`c${i}`, "D1", 20, h!, j!),
    );
    const d1 = summarizeAgreement(many, ["D1"]).byDim[0]!;
    expect(d1.worst.filter((c) => !c.ok).map((c) => c.caseId).sort()).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(d1.worst).toHaveLength(5); // 已经有 5 条 ✗,不再补一致的
    // 只有 1 个 ✗:再补 2 条一致但分数不同的(差异大的在前),完全一样的不列
    const few = [[20, 0], [16, 12], [8, 9], [12, 12.5], [10, 10]].map(([h, j], i) => compareCell(`f${i}`, "D1", 20, h!, j!));
    expect(summarizeAgreement(few, ["D1"]).byDim[0]!.worst.map((c) => c.caseId)).toEqual(["f0", "f1", "f2"]);
  });
});

describe("human.yaml 校验", () => {
  it("合法的标注能读出来", () => {
    const r = parseHuman(humanYaml({}, "note: 整体还行"), dims);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.human).toMatchObject({ annotator: "测试员", date: "2026-10-05", note: "整体还行" });
    expect(r.human.dims.D1).toEqual({ score: 10, reason: "理由 D1" });
  });

  it("分数超过该维度满分:报错并点名维度和满分", () => {
    expectInputError(() => parseHuman(humanYaml({ D5: 11 }), dims), "dims.D5.score", "满分是 10");
    expectInputError(() => parseHuman(humanYaml({ D1: 20.5 }), dims), "满分是 20");
  });

  it("分数多于一位小数:报错并点名维度(否则显示的 16 和按 15.96 落的第 3 档对不上)", () => {
    expectInputError(() => parseHuman(humanYaml({ D1: 15.96 }), dims, "c/human.yaml"), "c/human.yaml", "dims.D1.score", "D1", "最多一位小数", "15.96", "显示成 16");
    expectInputError(() => parseHuman(humanYaml({ D6: 7.25 }), dims), "dims.D6.score", "最多一位小数");
    // 一位小数(含二进制里不精确的 0.3、2.4)和整数照常通过
    const r = parseHuman(humanYaml({ D1: 15.9, D2: 0.3, D3: 2.4, D4: 20 }), dims);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect([r.human.dims.D1!.score, r.human.dims.D2!.score, r.human.dims.D3!.score]).toEqual([15.9, 0.3, 2.4]);
  });

  it("负分、非数字、拼错的维度、多余的字段、缺维度都报错", () => {
    expectInputError(() => parseHuman(humanYaml({ D2: -1 }), dims), "dims.D2.score", "不能小于 0");
    expectInputError(() => parseHuman(humanYaml({ D3: "很好" }), dims), "dims.D3.score", "必须是数字");
    expectInputError(() => parseHuman(humanYaml({ D8: 1 }), dims), "不认识的字段 D8", "只认 D1");
    expectInputError(() => parseHuman(humanYaml({}, "score_total: 50"), dims), "不认识的字段 score_total");
    const noD7 = humanYaml().replace(/ {2}D7:\n.*\n.*/, "");
    expectInputError(() => parseHuman(noD7, dims), "dims.D7", "缺少这个维度");
  });

  it("有分没理由、日期格式不对、YAML 本身坏了都报错", () => {
    const noReason = humanYaml().replace("reason: 理由 D4", 'reason: ""');
    expectInputError(() => parseHuman(noReason, dims, "x/human.yaml"), "x/human.yaml", "dims.D4.reason", "要写理由");
    expectInputError(() => parseHuman(humanYaml().replace('"2026-10-05"', "十月五日"), dims), "date", "YYYY-MM-DD");
    expectInputError(() => parseHuman("dims: [\n", dims), "不是合法的 YAML");
  });

  it("score 写 null:不报错,算没填完(draft)", () => {
    const r = parseHuman(humanYaml({ D2: null, D6: null }), dims);
    expect(r).toEqual({ status: "draft", pending: ["D2", "D6"] });
  });
});

describe("--init 与用例目录", () => {
  it("生成的模板能被重新读回(全部待填);填好后能读出标注", () => {
    const dir = tmp();
    const { dir: caseDir, files } = initCase({ scn, calibrationDir: dir, sessionFile: exampleSession, caseId: "self-01", today: "2026-10-05" });
    expect(files.map((f) => f.slice(caseDir.length + 1))).toEqual(["session.json", "human.yaml", "transcript.md"]);

    const c = loadCase(caseDir, "self-01", scn);
    expect(c.human).toEqual({ status: "draft", pending: ["annotator", ...dims.map((d) => d.id)] });
    expect(c.fixtures).toEqual([]);
    expect(c.state.sessionId).toBe("calib-EV_good");
    expect(readFileSync(join(caseDir, "transcript.md"), "utf8")).toContain("U1 [第1轮");

    // 照着模板填:annotator、每个维度的 score 和 reason
    const humanFile = join(caseDir, "human.yaml");
    let text = readFileSync(humanFile, "utf8");
    expect(text).toContain("满分 20。档位 0–4:0–4 / 4–8 / 8–12 / 12–16 / 16–20");
    text = text.replace('annotator: ""', "annotator: 作者");
    for (const d of dims) {
      text = text.replace(`  ${d.id}:\n    score: null\n    reason: ""`, `  ${d.id}:\n    score: ${d.max / 2}\n    reason: 一半`);
    }
    writeFileSync(humanFile, text);
    const filled = loadCase(caseDir, "self-01", scn).human;
    expect(filled.status).toBe("ok");
    if (filled.status === "ok") expect(filled.human.dims.D1).toEqual({ score: 10, reason: "一半" });
  });

  it("已存在的目录不覆盖;用例 id 不合法拒绝", () => {
    const dir = tmp();
    initCase({ scn, calibrationDir: dir, sessionFile: exampleSession, caseId: "a" });
    expectInputError(() => initCase({ scn, calibrationDir: dir, sessionFile: exampleSession, caseId: "a" }), "已存在");
    expectInputError(() => initCase({ scn, calibrationDir: dir, sessionFile: exampleSession, caseId: "../evil" }), "不合法");
    expectInputError(() => initCase({ scn, calibrationDir: dir, sessionFile: exampleSession, caseId: "" }), "不合法");
  });

  it("session.json:接受网页导出的 { state } 包装;别的场景、不是对局的 JSON 报错", () => {
    const st = JSON.parse(readFileSync(exampleSession, "utf8"));
    expect(parseSession({ id: "x", state: st, version: 3 }, scn, "w.json").sessionId).toBe("calib-EV_good");
    expectInputError(() => parseSession({ ...st, scenarioId: "other" }, scn, "o.json"), "o.json", "场景 other");
    expectInputError(() => parseSession({ hello: 1 }, scn, "h.json"), "不是引擎的 SessionState");
  });

  it("--init-player:脚本化玩家离线跑一局建用例;示例用例的 session.json 就是这样生成的", async () => {
    const dir = tmp();
    for (const id of ["EV_good", "EV_rush"]) {
      const ps = await playerSession(scn, scnDir, id);
      expect(ps.failedChecks).toEqual([]);
      const { dir: caseDir } = initCase({ scn, calibrationDir: dir, state: ps.state, caseId: `p-${id}` });
      expect(loadCase(caseDir, `p-${id}`, scn).human.status).toBe("draft");
      // 引擎行为变了导致这里不一致时:用 --init-player 重新生成示例的 session.json,并核对 human.yaml 和 judge-fixtures 的引用
      const example = JSON.parse(readFileSync(join(scnDir, `evals/calibration/example-${id}/session.json`), "utf8"));
      expect(JSON.parse(readFileSync(join(caseDir, "session.json"), "utf8")), `example-${id}/session.json 过期了`).toEqual(example);
    }
    await expect(playerSession(scn, scnDir, "EV_nobody")).rejects.toThrow("没有脚本化玩家 EV_nobody");
  });

  it("缺 human.yaml:提示用 --init", () => {
    const dir = tmp();
    const { dir: caseDir } = initCase({ scn, calibrationDir: dir, sessionFile: exampleSession, caseId: "b" });
    rmSync(join(caseDir, "human.yaml"));
    expectInputError(() => loadCase(caseDir, "b", scn), "缺少 human.yaml", "--init");
  });
});
