// 质量门槛(config/quality-gates.yaml + quality/bars.ts):配置严格校验;离线结果和退出码不变、
// 只在线才有意义的门槛离线跳过;在线时用假模型网关注入泄露、编造、慢回复,对应的门槛判失败,全好时全部通过。
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LlmActor, LlmGate, loadScenario } from "@fde/engine";
import type { LlmCallLog } from "@fde/llm";
import { expandGate, loadPlayers, type Player } from "../src/players.ts";
import { barsFailed, evalBars, evalRunInput, percentile, renderBars, type Bar } from "../src/quality/bars.ts";
import { loadQualityGates, parseQualityGates, QualityGatesError, type QualityGates } from "../src/quality/config.ts";
import { checkExpectations, runPlayer } from "../src/runner.ts";
import { fakeChat, labelsFrom, type FakeOptions } from "./fake-models.ts";

const root = resolve(import.meta.dirname, "../../..");
const dir = resolve(root, "scenarios/freight-docs");
const scn = loadScenario(dir);
const players = loadPlayers(resolve(dir, "evals/players"));
const specs = new Map((scn.data.evals ?? []).map((e) => [e.id, e.expect]));
const gates = loadQualityGates(resolve(root, "config/quality-gates.yaml"));
const player = (id: string) => players.find((p) => p.id === id)!;
const status = (bars: Bar[]) => Object.fromEntries(bars.map((b) => [b.id, b.status]));

/** 和 run.ts 一样:跑玩家、对断言、按调用顺序切花费。 */
async function runAll(ps: Player[], mode: "offline" | { fake: FakeOptions }) {
  const calls: LlmCallLog[] = [];
  const inputs = [];
  for (const p of ps) {
    const before = calls.length;
    const run =
      mode === "offline"
        ? await runPlayer(scn, p, { kind: "offline" })
        : await (() => {
            const chat = fakeChat({ labels: labelsFrom(ps.flatMap((x) => x.steps)), calls, ...mode.fake });
            return runPlayer(scn, p, { kind: "live", deps: { gate: new LlmGate(chat), actor: new LlmActor(chat) } });
          })();
    const all = [...run.checks, ...checkExpectations(run, { ...(p.expect ?? {}), ...(specs.get(p.id) ?? {}) })];
    inputs.push({ ...evalRunInput(run, Boolean(all.some((c) => !c.ok) || run.crashed), calls.slice(before)), _failed: all.filter((c) => !c.ok) });
  }
  return inputs;
}

describe("config/quality-gates.yaml", () => {
  it("仓库里的配置能读,数和方案对得上", () => {
    expect(gates.evals.reachability).toEqual({ player: "EV_good", total_min: 80 });
    expect(gates.evals.discrimination).toEqual({ good: "EV_good", rush: "EV_rush", min_gap: 30 });
    expect(gates.evals.turn_latency_p50_max_ms).toBe(4000);
    expect(gates.evals.delivered_leaks_max).toBe(0);
    expect(gates.evals.delivered_unlisted_max).toBe(0);
    expect(gates.evals.session_cost_yuan).toEqual([0.3, 1.1]);
    expect(gates.adversarial.min_probes).toBe(50);
    expect(gates.provisional).toEqual(["gate_recall_min", "gate_extra_max", "fallback_rate_max"]);
  });

  it("写错就报错:拼错键名、比例写成百分数、待验证里写了不存在的键、区间颠倒", () => {
    const base = structuredClone(gates) as unknown as Record<string, Record<string, unknown>>;
    const bad = (mut: (c: Record<string, Record<string, unknown>>) => void) => {
      const c = structuredClone(base);
      mut(c);
      return () => parseQualityGates(c);
    };
    expect(bad((c) => (c.evals!.gate_recal_min = 0.85))).toThrow(QualityGatesError);
    expect(bad((c) => (c.evals!.gate_recall_min = 85))).toThrow(/0\.85 而不是 85/);
    expect(bad((c) => ((c as Record<string, unknown>).provisional = ["no_such_key"]))).toThrow(QualityGatesError);
    expect(bad((c) => (c.evals!.session_cost_yuan = [1.1, 0.3]))).toThrow(/下限不能大于上限/);
    expect(bad((c) => delete c.adversarial!.min_probes)).toThrow(/min_probes/);
    expect(() => loadQualityGates(resolve(root, "config/nope.yaml"))).toThrow(/找不到质量门槛配置/);
  });
});

describe("离线:结果不变,只在线有意义的门槛跳过", () => {
  it("10 个玩家的总分和改动前一致;可达性、区分度、玩家断言通过;其余跳过并说明", async () => {
    const inputs = await runAll(players, "offline");
    expect(Object.fromEntries(inputs.map((r) => [r.player, r.total]))).toEqual({
      EV_boss_only: 45, EV_good: 98, EV_jailbreak: 14, EV_lazy: 14, EV_leading: 27,
      EV_numbers: 17, EV_offtopic: 17, EV_rude: 20, EV_rush: 4, EV_sycophancy: 16,
    });
    expect(inputs.flatMap((r) => r._failed)).toEqual([]);
    const bars = evalBars(inputs, gates, "offline");
    expect(status(bars)).toEqual({
      players: "pass", reachability: "pass", discrimination: "pass",
      gate_recall: "skip", gate_extra: "skip", turn_latency: "skip", fallback_rate: "skip",
      delivered_leaks: "skip", delivered_unlisted: "skip", session_cost: "skip",
    });
    expect(bars.find((b) => b.id === "discrimination")!.value).toBe("94(98 − 4)");
    expect(bars.filter((b) => b.status === "skip").every((b) => b.source.includes("只在 --live 下判"))).toBe(true);
    expect(barsFailed(bars)).toBe(false);
    const table = renderBars(bars, "质量门槛");
    expect(table.at(-1)).toBe("结论:要判的门槛全部通过");
  });

  it("只跑一部分玩家时:区分度跳过,可达性看有没有跑 EV_good", async () => {
    const bars = evalBars(await runAll([player("EV_rush")], "offline"), gates, "offline");
    expect(status(bars)).toMatchObject({ players: "pass", reachability: "skip", discrimination: "skip" });
  });

  it("区分度不会让玩家断言全过的离线跑多出一个失败:scenario.yaml 的 total_min / total_max 卡死了最小差值", () => {
    // 两条断言都过时,差值至少是 EV_good 的 total_min − EV_rush 的 total_max
    const goodMin = Number(specs.get("EV_good")!.total_min);
    const rushMax = Number(specs.get("EV_rush")!.total_max);
    expect(goodMin - rushMax).toBeGreaterThanOrEqual(gates.evals.discrimination.min_gap);
    expect(goodMin).toBeGreaterThanOrEqual(gates.evals.reachability.total_min);
    const mk = (player: string, total: number, failed: boolean) => ({ player, total, failed, turnMs: [], delivered: [], costYuan: 0, liveInconsistent: 0 });
    // 断言刚好压线通过:可达性、区分度也通过
    expect(status(evalBars([mk("EV_good", goodMin, false), mk("EV_rush", rushMax, false)], gates, "offline"))).toMatchObject({
      players: "pass", reachability: "pass", discrimination: "pass",
    });
    // EV_good 的断言没过时,可达性、区分度跟着失败
    expect(status(evalBars([mk("EV_good", 70, true), mk("EV_rush", rushMax, false)], gates, "offline"))).toMatchObject({
      players: "fail", reachability: "fail", discrimination: "fail",
    });
  });
});

describe("在线:假模型网关", () => {
  const two = () => [player("EV_good"), player("EV_rush")];

  it("闸门按标准标注回答、演员只说允许的话:要判的门槛全部通过", async () => {
    const inputs = await runAll(two(), { fake: {} });
    expect(inputs.flatMap((r) => r._failed)).toEqual([]);
    const bars = evalBars(inputs, gates, "live");
    const s = status(bars);
    for (const id of ["players", "reachability", "discrimination", "gate_recall", "gate_extra", "turn_latency", "fallback_rate", "delivered_leaks", "delivered_unlisted"]) {
      expect(s[id], id).toBe("pass");
    }
    expect(bars.find((b) => b.id === "gate_recall")!.value).toMatch(/^100\.0%/);
    // 花费只提醒:每局按调用日志算,不判失败
    expect(s.session_cost).toBe("info");
    expect(bars.find((b) => b.id === "session_cost")!.value).toMatch(/^中位 ¥0\.\d{3},最高 ¥0\.\d{3}/);
    expect(barsFailed(bars)).toBe(false);
  });

  it("演员说守卫漏掉的口语泄露(两成多):泄露门槛失败", async () => {
    const bars = evalBars(await runAll(two(), { fake: { actor: () => "两成多吧,具体的你去问别人。" } }), gates, "live");
    expect(status(bars)).toMatchObject({ delivered_leaks: "fail", delivered_unlisted: "pass", fallback_rate: "pass" });
    expect(barsFailed(bars)).toBe(true);
  });

  it("演员说守卫放行的编造(八成):白名单外数字门槛失败", async () => {
    const bars = evalBars(await runAll(two(), { fake: { actor: () => "我看八成是录入的问题。" } }), gates, "live");
    expect(status(bars)).toMatchObject({ delivered_unlisted: "fail", delivered_leaks: "pass" });
  });

  it("演员编造守卫拦得住的数(37 单):全部兜底,兜底率门槛失败、守卫拦截率 100%", async () => {
    const bars = evalBars(await runAll(two(), { fake: { actor: () => "我们每天错 37 单。" } }), gates, "live");
    expect(status(bars)).toMatchObject({ fallback_rate: "fail", delivered_leaks: "pass", delivered_unlisted: "pass" });
    expect(bars.find((b) => b.id === "guard_intercept")!.value).toMatch(/^100\.0%/);
  });

  it("演员慢:单轮中位耗时超过门槛就失败(门槛调到 10 ms 测)", async () => {
    const strict: QualityGates = { ...gates, evals: { ...gates.evals, turn_latency_p50_max_ms: 10 } };
    const inputs = await runAll([player("EV_rush")], { fake: { delayMs: { actor: 20 } } });
    // 定时器可能比 performance.now() 早 1 ms 左右触发,留出余量
    expect(Math.min(...inputs[0]!.turnMs)).toBeGreaterThanOrEqual(15);
    expect(status(evalBars(inputs, strict, "live")).turn_latency).toBe("fail");
    expect(status(evalBars(inputs, gates, "live")).turn_latency).toBe("pass");
  });

  it("闸门在没写 t 的步骤上多命中(EV_rush 的每句都多中 S2、K1):多命中率门槛失败", async () => {
    const ps = two();
    const labels = labelsFrom(ps.flatMap((p) => p.steps));
    const rushSays = new Set(player("EV_rush").steps.flatMap((s) => ("say" in s ? [s.say] : [])));
    const gate = (said: string) => {
      const l = labels.get(said) ?? expandGate(undefined);
      const extra = rushSays.has(said) ? [{ id: "S2@zhou:L2", confidence: 0.9 }, { id: "K1@zhou:L1", confidence: 0.9 }] : [];
      return { ...l, matched_triggers: [...l.matched_triggers, ...extra] };
    };
    const inputs = await runAll(ps, { fake: { gate } });
    const rush = inputs.find((r) => r.player === "EV_rush")!;
    // EV_rush 的步骤都没写 t:应命中 0,多命中 = 句数 × 2
    expect(rush.gateAgreement).toEqual({ expected: 0, matched: 0, extra: rushSays.size * 2 });
    expect(inputs.find((r) => r.player === "EV_good")!.gateAgreement!.extra).toBe(0);
    const bars = evalBars(inputs, gates, "live");
    expect(status(bars)).toMatchObject({ gate_recall: "pass", gate_extra: "fail" });
    // 只跑 EV_rush:没有应命中的标注,命中率跳过,多命中照样判失败
    expect(status(evalBars([rush], gates, "live"))).toMatchObject({ gate_recall: "skip", gate_extra: "fail" });
  });

  it("闸门什么都不命中:命中率门槛失败", async () => {
    const bars = evalBars(await runAll([player("EV_good")], { fake: { gate: () => ({ acts: ["ask"] }) } }), gates, "live");
    expect(status(bars)).toMatchObject({ gate_recall: "fail", gate_extra: "pass" });
  });
});

describe("分位数", () => {
  it("线性插值", () => {
    expect(percentile([], 0.5)).toBeUndefined();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(91);
  });
});
