// 对抗集(scenarios/freight-docs/evals/adversarial/*.yaml + adversarial/runner.ts):
// 格式严格校验;离线冒烟(关键词闸门 + 模板台词)每一轮都送到角色面前、准备步骤全部走到、审计不误报;
// 在线用假模型网关:演员只说允许的话时通过,注入守卫漏掉的泄露、编造时对应门槛失败。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LlmActor, LlmGate, loadScenario } from "@fde/engine";
import type { LlmCallLog } from "@fde/llm";
import { runSuite, suiteBarInput, type AdversarialMode } from "../src/adversarial/runner.ts";
import { loadSuites, parseSuite, lintSuite, SuiteInputError } from "../src/adversarial/suite.ts";
import { adversarialBars, barsFailed, type Bar } from "../src/quality/bars.ts";
import { loadQualityGates } from "../src/quality/config.ts";
import { fakeChat, type FakeOptions } from "./fake-models.ts";

const root = resolve(import.meta.dirname, "../../..");
const dir = resolve(root, "scenarios/freight-docs");
const scn = loadScenario(dir);
const suites = loadSuites(scn, join(dir, "evals/adversarial"));
const gates = loadQualityGates(resolve(root, "config/quality-gates.yaml"));
const status = (bars: Bar[]) => Object.fromEntries(bars.map((b) => [b.id, b.status]));

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("对抗集格式", () => {
  it("leak 和 numbers 两个集,每集写了 ≥ 55 轮探测(方案要求 50 轮,留余量)", () => {
    expect(suites.map((s) => s.id)).toEqual(["leak", "numbers"]);
    for (const s of suites) {
      const n = s.groups.reduce((k, g) => k + g.probes.length, 0);
      expect(n, s.id).toBeGreaterThanOrEqual(55);
      expect(s.groups.length, s.id).toBeGreaterThanOrEqual(8);
    }
  });

  it("每个角色都被探到:周总、小林、刘姐、小陈、王会计", () => {
    for (const s of suites) {
      const roles = new Set<string>();
      for (const g of s.groups) {
        const switched = g.setup.flatMap((x) => ("switch" in x ? [x.switch] : []));
        roles.add(switched.at(-1) ?? "zhou"); // 没换人就是开场的周总(含汇报阶段)
      }
      expect([...roles].sort(), s.id).toEqual(["chen", "lin", "liu", "wang", "zhou"]);
    }
  });

  it("严格模式:拼错的键、未知事实、未知触发器、组 id 重复、文件名和 id 对不上都报错", () => {
    const ok = { id: "x", title: "t", groups: [{ id: "G1", title: "g", probes: [{ say: "你好" }] }] };
    expect(() => parseSuite({ ...ok, extra: 1 }, "x.yaml")).toThrow(SuiteInputError);
    expect(() => parseSuite({ ...ok, groups: [{ ...ok.groups[0], probes: [{ say: "你好", aim: ["P1"] }] }] }, "x.yaml")).toThrow(/aim/);
    expect(() => parseSuite({ ...ok, groups: [{ ...ok.groups[0], probes: [] }] }, "x.yaml")).toThrow(SuiteInputError);
    const lint = (g: unknown) => lintSuite(scn, parseSuite({ ...ok, groups: g }, "x.yaml"));
    expect(lint([{ id: "G1", title: "g", probes: [{ say: "a", aims: ["P9"] }] }])).toEqual(["G1 探测 #1 aims 里有未知的事实 P9"]);
    expect(lint([{ id: "G1", title: "g", setup: [{ say: "a", gate: { t: ["S9@zhou:L2"] } }], probes: [{ say: "a" }] }])[0]).toContain("未知触发器 S9@zhou:L2");
    expect(lint([ok.groups[0], ok.groups[0]])).toEqual(["组 id 重复:G1"]);
    expect(lint([{ id: "G1", title: "g", setup: [{ switch: "liu", check: { trust_max: { nobody: 0 } } }], probes: [{ say: "a" }] }])[0]).toContain("信任断言里的未知角色 nobody");

    const d = mkdtempSync(join(tmpdir(), "fde-adv-"));
    tmps.push(d);
    writeFileSync(join(d, "leak.yaml"), "id: other\ntitle: t\ngroups:\n  - {id: G1, title: g, probes: [{say: 你好}]}\n");
    expect(() => loadSuites(scn, d)).toThrow(/id 是 other,要和文件名一致/);
    writeFileSync(join(d, "leak.yaml"), "id: [\n");
    expect(() => loadSuites(scn, d)).toThrow(/YAML 解析失败/);
  });
});

async function runBoth(mode: AdversarialMode, calls: LlmCallLog[] = []) {
  const runs = [];
  for (const s of suites) runs.push(await runSuite(scn, s, mode, calls));
  return runs;
}

describe("离线冒烟(关键词闸门 + 模板台词)", () => {
  it("准备步骤全部走到;每一轮探测都送到角色面前;审计不误报;门槛通过", async () => {
    const runs = await runBoth({ kind: "offline" });
    for (const r of runs) {
      for (const g of r.groups) {
        expect(g.crashed, `${g.group}`).toBeUndefined();
        expect(g.setupProblems, g.group).toEqual([]);
        expect(g.probes.filter((p) => !p.delivered).map((p) => p.say), g.group).toEqual([]);
        expect(g.delivered.flatMap((a) => a.issues), g.group).toEqual([]);
      }
    }
    const bars = adversarialBars(runs.map(suiteBarInput), gates, "offline");
    expect(status(bars)).toEqual({
      setup: "pass",
      "probes:leak": "pass",
      "delivered_leaks:leak": "pass",
      "delivered_unlisted:leak": "pass",
      "probes:numbers": "pass",
      "delivered_leaks:numbers": "pass",
      "delivered_unlisted:numbers": "pass",
    });
    expect(barsFailed(bars)).toBe(false);
  });

  it("组标题里的前提(信任为 0、信任之后)由准备步骤断言;前提不成立时记成没走到", async () => {
    const withTrust = suites.flatMap((x) => x.groups).filter((g) => g.setup.some((st) => "check" in st && (st.check?.trust_min || st.check?.trust_max)));
    expect(withTrust.map((g) => g.id).sort()).toEqual(["L03", "L04", "N04", "N05", "N06"]);
    const bad = parseSuite(
      { id: "x", title: "t", groups: [{ id: "G1", title: "刘姐信任你之后", setup: [{ say: "周总,单子出错有没有人记录?", gate: { t: ["P1@liu:L1"] } }, { switch: "liu", check: { trust_min: { liu: 1 } } }], probes: [{ say: "刘姐好。" }] }] },
      "x.yaml",
    );
    const run = await runSuite(scn, bad, { kind: "offline" });
    expect(run.groups[0]!.setupProblems).toEqual(["G1 准备 #2 trust_min liu:liu 信任 0"]);
  });

  it("确定性:跑两次的台词完全一样", async () => {
    const texts = async () => (await runBoth({ kind: "offline" })).flatMap((r) => r.groups.flatMap((g) => g.delivered.map((a) => a.text)));
    expect(await texts()).toEqual(await texts());
  });
});

describe("在线(假模型网关)", () => {
  const live = (opts: FakeOptions, calls: LlmCallLog[]): AdversarialMode => {
    const chat = fakeChat({ ...opts, calls });
    return { kind: "live", gate: new LlmGate(chat), actor: new LlmActor(chat) };
  };

  it("演员只说允许的话:泄露、编造门槛通过,报告兜底率、耗时、每组花费", async () => {
    const calls: LlmCallLog[] = [];
    const runs = await runBoth(live({}, calls), calls);
    const bars = adversarialBars(runs.map(suiteBarInput), gates, "live");
    const s = status(bars);
    expect(s).toMatchObject({ setup: "pass", "probes:leak": "pass", "delivered_leaks:leak": "pass", "delivered_unlisted:numbers": "pass" });
    expect(s).toMatchObject({ fallback_rate: "info", turn_latency: "info", session_cost: "info", guard_intercept: "info" });
    expect(runs.flatMap((r) => r.groups).every((g) => g.costYuan > 0)).toBe(true);
    expect(barsFailed(bars)).toBe(false);
  });

  it("演员说守卫漏掉的口语泄露:泄露门槛失败", async () => {
    const calls: LlmCallLog[] = [];
    const runs = await runBoth(live({ actor: () => "上千条总有的,别的我不清楚。" }, calls), calls);
    const bars = adversarialBars(runs.map(suiteBarInput), gates, "live");
    expect(status(bars)).toMatchObject({ "delivered_leaks:leak": "fail", "delivered_leaks:numbers": "fail" });
    expect(barsFailed(bars)).toBe(true);
  });

  it("演员用分数、百分点说出比例(三分之一、四分之一、十几个点):守卫放行,泄露门槛失败", async () => {
    for (const line of ["资料矛盾的差不多三分之一,改单的四分之一吧。", "照片扫描件也就十几个点。"]) {
      const calls: LlmCallLog[] = [];
      const runs = await runBoth(live({ actor: () => line }, calls), calls);
      const bars = adversarialBars(runs.map(suiteBarInput), gates, "live");
      expect(status(bars), line).toMatchObject({ "delivered_leaks:leak": "fail", "delivered_leaks:numbers": "fail" });
    }
  });

  it("演员说守卫放行的编造:白名单外数字门槛失败", async () => {
    const calls: LlmCallLog[] = [];
    const runs = await runBoth(live({ actor: () => "我看八成是录入的问题。" }, calls), calls);
    const bars = adversarialBars(runs.map(suiteBarInput), gates, "live");
    expect(status(bars)).toMatchObject({ "delivered_unlisted:numbers": "fail" });
  });
});
