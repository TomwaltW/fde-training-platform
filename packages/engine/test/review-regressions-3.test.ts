// 第三轮复核(验证第二轮修复)确认的问题。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  Engine,
  FixtureJudge,
  QueueGate,
  TemplateActor,
  TemplateDebrief,
  checkReply,
  emptyJudge,
  gateOutput,
  parseScenario,
  validateScenario,
  type GateOutput,
  type GuardContext,
} from "../src/index.ts";
import { SCN_DIR, scn } from "./helpers.ts";

const t = (...ids: string[]) => ids.map((id) => ({ id, confidence: 0.9 }));
const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  actorContext: ["公司 60 人。操作部 22(单证 14、跟单 8),销售 15,仓库 12,财务 4,其他 7"],
  userTexts: [],
  ledgerTexts: [],
  canaries: [],
  stance: "test_user",
  ...over,
});
const flags = (reply: string, c = ctx()) => checkReply(reply, c).map((f) => `${f.type}:${f.detail}`);

describe("guard round 3", () => {
  it("R3-1:试探性的反问(你们专业不专业?)不算附和", () => {
    for (const s of ["你们专业吗?", "你们专业不专业?", "(上下打量你)你们专业不专业啊?先说说你来干嘛的。", "我完全同意不了。", "太对了吗?"]) {
      expect(flags(s), s).toEqual([]);
    }
    expect(flags("你们专业,我放心。")).toEqual(["sycophancy:你们专业"]);
  });

  it("R3-4:常见的附和前缀照样拦", () => {
    for (const s of ["这点你说得对。", "我也觉得你说得对。", "确实你说得对。"]) {
      expect(flags(s).some((f) => f.startsWith("sycophancy")), s).toBe(true);
    }
  });

  it("R3-2:阿拉伯数字写的'7点8分钟''8点4'按小数检查,不拆成钟点加整数", () => {
    expect(flags("录一票平均7点8分钟。")).toEqual(["number:7点8"]);
    expect(flags("错误率差不多是8点4。")).toEqual(["number:8点4"]);
    expect(flags("8点30开会,7点5分到。")).toEqual([]);
  });
});

describe("director round 3", () => {
  it("R3-3:对小陈说'肯去现场看'又顺带问了一句,现场的效果之外不再重复加信任", async () => {
    const gate = new QueueGate();
    const engine = new Engine(scn, { gate, actor: new TemplateActor(), judge: new FixtureJudge(() => emptyJudge(scn)), debrief: new TemplateDebrief() });
    const st = engine.start("t");
    st.discovered.push("liu", "chen");
    st.currentRole = "chen";
    st.exchanges.chen = 3;
    st.traps.TR5 = { turn: 0 };
    st.flags.auth_ops = true;
    const say = async (text: string, g: Partial<GateOutput>) => {
      gate.push(gateOutput(g));
      await engine.userTurn(st, text);
      gate.clear();
    };
    await say("录的时候最常卡在哪?我想去现场看看。", {
      acts: ["ask", "request_site_visit"],
      matched_triggers: t("P7@chen:L2", "act:site_visit"),
      trust_moves: [{ dir: "plus", what: "肯去现场看" }],
    });
    expect(st.actionsDone.site_visit).toBeDefined();
    expect(st.trust.chen).toBe(1);
    await say("能给我看看你自己整理的对照资料吗?", { matched_triggers: t("P5@chen:L3") });
    expect(st.artifacts.A3).toBeUndefined();
  });
});

describe("validator round 3", () => {
  const raw = () => parse(readFileSync(join(SCN_DIR, "scenario.yaml"), "utf8"));
  const errs = (data: unknown, id: string) => validateScenario(parseScenario(data, SCN_DIR)).errors.filter((e) => e.includes(id));

  it("R3-5:汇报阶段的条件可以引用调研阶段打开过的资料", () => {
    const data = raw();
    data.facts.push({ id: "Z1", cat: "problem", weight: 1, statement: "测试", unlock: [{ role: "zhou", level: "L2", ask: "测试问题一", requires: ["phase==report and opened.A1"] }] });
    data.facts.push({ id: "Z2", cat: "problem", weight: 1, statement: "测试", unlock: [{ role: "zhou", level: "L2", ask: "测试问题二", requires: ["phase==kickoff and opened.A1"] }] });
    expect(errs(data, "Z1")).toEqual([]);
    expect(errs(data, "Z2").length).toBeGreaterThan(0);
  });

  it("R3-6:只能在开场做的验证不误报为做不了", () => {
    const data = raw();
    data.experiments.push({ id: "X9", title: "趁周总在跟他去仓库转一圈", requires: ["phase==kickoff"], result: "看了", supports: ["T1"] });
    expect(errs(data, "X9")).toEqual([]);
  });

  it("R3-7:信任会掉,'trust.liu<1' 这类条件可达", () => {
    const data = raw();
    data.roles.find((r: { id: string }) => r.id === "liu").trust.initial = 2;
    data.facts.push({ id: "Z3", cat: "problem", weight: 1, statement: "测试", unlock: [{ role: "liu", level: "L2", ask: "测试问题三", requires: ["trust.liu<1"] }] });
    expect(errs(data, "Z3")).toEqual([]);
  });

  it("兜底台词里有别的事实的金丝雀词 → 警告", () => {
    const data = raw();
    data.traps.find((x: { id: string }) => x.id === "TR5").line = "上了系统,我的小抄是不是也没用了?";
    const r = validateScenario(parseScenario(data, SCN_DIR));
    expect(r.warnings.some((w) => w.includes("TR5") && w.includes("小抄"))).toBe(true);
  });
});
