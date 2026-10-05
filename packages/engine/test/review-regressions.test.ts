// 对抗性代码评审确认的问题(C01–C26),每条一个回归测试。
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
  activeCanaries,
  buildActorPrompt,
  buildDebriefData,
  buildDebriefPrompt,
  checkJudgeOutput,
  checkReply,
  createSession,
  emptyJudge,
  gateOutput,
  parseScenario,
  planReportOpening,
  scoreSession,
  validateScenario,
  type ActorInput,
  type GateOutput,
  type GuardContext,
  type SessionState,
} from "../src/index.ts";
import { SCN_DIR, scn } from "./helpers.ts";

const t = (...ids: string[]) => ids.map((id) => ({ id, confidence: 0.9 }));

function setup(actor = new TemplateActor()) {
  const gate = new QueueGate();
  const engine = new Engine(scn, { gate, actor, judge: new FixtureJudge(() => emptyJudge(scn)), debrief: new TemplateDebrief() });
  const st = engine.start("t");
  const say = async (text: string, g: Partial<GateOutput> = {}) => {
    gate.push(gateOutput(g));
    const r = await engine.userTurn(st, text);
    gate.clear();
    return r;
  };
  return { engine, st, say };
}

describe("director(评审 C01/C04–C08/C16)", () => {
  it("C01:同一句话要授权又要去现场——先授权、周总回话,然后再去现场", async () => {
    const { st, say } = setup();
    const r = await say("周总,您跟操作部打个招呼,我现在就去现场看看。", {
      acts: ["ask", "request_permission", "request_site_visit"],
      matched_triggers: t("perm:auth_ops", "act:site_visit"),
    });
    expect(st.flags.auth_ops).toBe(true);
    expect(r.reply?.roleId).toBe("zhou");
    expect(st.actionsDone.site_visit).toBeDefined();
    expect(st.discovered).toContain("chen");
    expect(st.minutesUsed).toBe(8 + 40);
    const npc = st.transcript.findIndex((l) => l.speaker === "npc" && l.turn === 1);
    const visit = st.transcript.findIndex((l) => l.speaker === "system" && l.text.includes("操作部待了半小时"));
    expect(npc).toBeGreaterThan(-1);
    expect(visit).toBeGreaterThan(npc);
  });

  it("C01:只说去现场,不需要角色回话,也不算一轮", async () => {
    const { st, say } = setup();
    st.flags.auth_ops = true;
    const r = await say("我去现场看看。", { acts: ["request_site_visit"], matched_triggers: t("act:site_visit") });
    expect(r.reply).toBeUndefined();
    expect(st.actionsDone.site_visit).toBeDefined();
    expect(st.exchanges.zhou ?? 0).toBe(0);
  });

  it("C04:承诺和去现场在同一句话里,承诺照样进账本", async () => {
    const { st, say } = setup();
    const r = await say("十天搞定,我再去现场看看。", {
      acts: ["commit_time", "request_site_visit"],
      matched_triggers: t("act:site_visit"),
      commitments: [{ type: "time", value_text: "十天", firm: true }],
    });
    expect(st.ledger).toHaveLength(1);
    expect(r.directive?.stance).toBe("pocket");
  });

  it("C04:换人失败时,这句话里的承诺照样进账本", async () => {
    const { st, say } = setup();
    await say("十天搞定,我去找小陈聊。", {
      acts: ["switch_role", "commit_time"],
      target_role: "chen",
      commitments: [{ type: "time", value_text: "十天", firm: true }],
    });
    expect(st.currentRole).toBe("zhou");
    expect(st.ledger).toHaveLength(1);
  });

  it("C05:同一句话里收回旧承诺、给新承诺,新承诺不被收回", async () => {
    const { st, say } = setup();
    await say("十天。", { commitments: [{ type: "time", value_text: "十天", firm: true }] });
    await say("十天那个收回,改成三周。", {
      acts: ["retract_commitment", "commit_time"],
      retracts: ["time"],
      commitments: [{ type: "time", value_text: "三周", firm: true }],
    });
    expect(st.ledger[0]?.retractedTurn).toBe(2);
    expect(st.ledger[1]?.retractedTurn).toBeUndefined();
  });

  it("C06:信任 0 时规则允许说的 L2 事实,态度不能是 guarded", async () => {
    const { st, say } = setup();
    st.discovered.push("chen");
    st.currentRole = "chen";
    st.exchanges.chen = 3;
    const r = await say("改单怎么处理?", { matched_triggers: t("P4@chen:L2") });
    expect(st.facts.P4?.level).toBe("L2");
    expect(r.directive?.stance).not.toBe("guarded");
  });

  it("C07:信任变化与 trust_moves 的顺序无关", async () => {
    const run = async (moves: GateOutput["trust_moves"]) => {
      const { st, say } = setup();
      st.discovered.push("liu");
      st.currentRole = "liu";
      st.trust.liu = 1;
      await say("……", { trust_moves: moves });
      return st.trust.liu;
    };
    const a = await run([
      { dir: "plus", what: "说明来意不是追责" },
      { dir: "plus", what: "承诺不点名" },
      { dir: "minus", what: "催促或打断" },
    ]);
    const b = await run([
      { dir: "minus", what: "催促或打断" },
      { dir: "plus", what: "说明来意不是追责" },
      { dir: "plus", what: "承诺不点名" },
    ]);
    expect(a).toBe(b);
    expect(a).toBe(1);
  });

  it("C08:正在和王会计说话时问'谁管钱',不会指给自己", async () => {
    const { st, say } = setup();
    st.discovered.push("wang");
    st.currentRole = "wang";
    st.exchanges.wang = 2;
    const r = await say("这些费用平时谁在管?", { matched_triggers: t("find:wang") });
    expect(r.directive?.redirectTo).toBeUndefined();
    expect(r.directive?.stance).not.toBe("deflect");
  });

  it("C16:演员模型出错不抛异常,用兜底台词;汇报开场的账本原话不丢", async () => {
    class Broken extends TemplateActor {
      override async speak(_: ActorInput): Promise<string> {
        throw new Error("provider 400: output moderation");
      }
    }
    const { engine, st, say } = setup(new Broken());
    const r = await say("十天,一万八。", {
      commitments: [
        { type: "time", value_text: "十天", firm: true },
        { type: "price", value_text: "一万八", firm: true },
      ],
    });
    expect(r.reply?.text).toBeTruthy();
    expect(st.events.some((e) => e.type === "actor_error")).toBe(true);
    const rep = await engine.act(st, { type: "submit_judgment", form: { J1: "x" } });
    expect(rep.reply?.text).toContain("你上午说十天");
  });
});

describe("scoring / judge / debrief(评审 C09–C14)", () => {
  const base = (): SessionState => {
    const st = createSession(scn, { sessionId: "t" });
    st.turn = 1;
    st.transcript.push({ ref: "U1", turn: 1, speaker: "user", roleId: "zhou", text: "x", phase: "discovery" });
    st.judgment = { J1: "识别是主要问题", J2: "", J3: "", J4: "", J5: "" };
    return st;
  };
  const snap = { facts: [], artifactsOpened: ["A1"] };
  const d6 = (st: SessionState) => scoreSession(scn, st, emptyJudge(scn)).dimensions.find((d) => d.id === "D6")!.score;

  it("C09:同类两条过早承诺都收回,只加回一次;过早给方案收不回来", () => {
    const st = base();
    st.ledger = [
      { id: "L1", type: "time", valueText: "十天", turn: 1, role: "zhou", premature: true, knownAtThatTime: snap, retractedTurn: 3 },
      { id: "L2", type: "time", valueText: "两周", turn: 2, role: "zhou", premature: true, knownAtThatTime: snap, retractedTurn: 3 },
    ];
    st.events.push({ turn: 1, type: "premature_solution", payload: {} });
    expect(d6(st)).toBe(10 - 4 + 2 - 2);
  });

  it("C09:收回后又重新坚决承诺,不加回", () => {
    const st = base();
    st.ledger = [
      { id: "L1", type: "time", valueText: "十天", turn: 1, role: "zhou", premature: true, knownAtThatTime: snap, retractedTurn: 2 },
      { id: "L2", type: "time", valueText: "十天", turn: 3, role: "zhou", premature: true, knownAtThatTime: snap },
    ];
    expect(d6(st)).toBe(6);
  });

  it("C09:过早的范围承诺不扣分,收回它也不加分(不能抵掉别的扣分)", () => {
    const st = base();
    st.ledger = [
      { id: "L1", type: "time", valueText: "十天", turn: 1, role: "zhou", premature: true, knownAtThatTime: snap },
      { id: "L2", type: "scope", valueText: "全做", turn: 1, role: "zhou", premature: true, knownAtThatTime: snap, retractedTurn: 2 },
    ];
    expect(d6(st)).toBe(6);
  });

  it("C10:contradict 标了 A 级也保持 contradict,扣分不会被校验掉", () => {
    const st = base();
    const { output } = checkJudgeOutput(scn, st, { T: [{ id: "T1", verdict: "contradict", evidence: ["J1"], grade: "A" }] });
    expect(output.T.find((x) => x.id === "T1")?.verdict).toBe("contradict");
  });

  it("C11:直接要资料(没有 ask)也算一次要证据", () => {
    const st = base();
    for (let i = 0; i < 3; i++) {
      st.turns.push({
        turn: i + 1,
        role: "liu",
        userText: "把记录给我。",
        gate: gateOutput({ acts: ["request_artifact"], question_tags: { open: false, quantifying: false, follow_up: false, leading: false, bundled_count: 1, evidence_ask: true } }),
        reveals: [],
        guardFlags: [],
        attempts: 1,
        minutesAfter: 0,
      });
    }
    const d3 = scoreSession(scn, st, emptyJudge(scn)).dimensions.find((d) => d.id === "D3")!;
    expect(d3.details.join()).toContain("evidence_asks 3 次");
  });

  it("C13:催促老板不丢「不甩锅」那一分,甩锅给一线才丢", () => {
    const withMove = (what: string) => {
      const st = base();
      st.turns.push({ turn: 1, role: "zhou", userText: "", gate: gateOutput({ trust_moves: [{ dir: "minus", what }] }), reveals: [], guardFlags: [], attempts: 1, minutesAfter: 0 });
      return scoreSession(scn, st, emptyJudge(scn)).dimensions.find((d) => d.id === "D3")!.details.join();
    };
    expect(withMove("催促或打断")).not.toContain("甩锅");
    expect(withMove("把错误归咎于一线")).toContain("对一线甩锅 1 次");
  });

  it("C12:只有汇报开场被原话拿出来的承诺才标为「被记账」", () => {
    const st = base();
    st.ledger = [{ id: "L1", type: "time", valueText: "十天", turn: 1, role: "zhou", premature: true, knownAtThatTime: snap }];
    planReportOpening(scn, st);
    st.ledger.push({ id: "L2", type: "price", valueText: "三万", turn: 5, role: "zhou", premature: false, knownAtThatTime: snap });
    const judge = emptyJudge(scn);
    const data = buildDebriefData(scn, st, scoreSession(scn, st, judge), judge);
    expect(data.ledger.map((e) => e.recalled)).toEqual([true, false]);
  });

  it("C14:复盘撰写拿到裁判的主张和逐项判定,并附对照项原文", () => {
    const st = base();
    const judge = emptyJudge(scn);
    judge.claims = [{ text: "识别是主要问题", source: "J1" }];
    const data = buildDebriefData(scn, st, scoreSession(scn, st, judge), judge);
    const prompt = buildDebriefPrompt(data, st)[1]!.content;
    expect(prompt).toContain("识别是主要问题");
    expect(prompt).toContain(scn.data.truth.diagnosis_items[0]!.statement.slice(0, 10));
  });
});

describe("guard / numbers(评审 C15、C17–C20)", () => {
  const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
    actorContext: ["公司 60 人"],
    userTexts: [],
    ledgerTexts: [],
    canaries: [],
    stance: "neutral",
    ...over,
  });
  const flags = (reply: string, c = ctx()) => checkReply(reply, c).map((f) => `${f.type}:${f.detail}`);

  it("C15:只拿到 L1 印象时,金丝雀词仍然有效", () => {
    const st = createSession(scn, { sessionId: "t" });
    st.facts.K1 = { level: "L1", turn: 1, source: "zhou" };
    expect(activeCanaries(scn, st)).toContain("OCR");
    st.facts.K1 = { level: "L2", turn: 2, source: "liu" };
    expect(activeCanaries(scn, st)).not.toContain("OCR");
  });

  it("C17:账本里的轮次号不进数字白名单", () => {
    const st = createSession(scn, { sessionId: "t" });
    st.ledger = [{ id: "L1", type: "time", valueText: "十天", turn: 3, role: "zhou", premature: true, knownAtThatTime: { facts: [], artifactsOpened: [] } }];
    const p = buildActorPrompt(scn, st, { role: "zhou", reveals: [], hints: [], system: [], after: [], obtained: [], discovered: [], ended: false, directive: { stance: "neutral", instruction: "" } }, "x");
    expect(p.messages[0]!.content).toContain("第 3 轮");
    expect(p.context.join("\n")).not.toContain("第 3 轮");
  });

  it("C18:全角数字照样检查", () => {
    expect(flags("上季度错了４２８次。")).toEqual(["number:428"]);
  });

  it("C19:反驳的话不算附和;开头附和才算", () => {
    expect(flags("我可不完全同意。")).toEqual([]);
    expect(flags("这就不太对了吧。")).toEqual([]);
    expect(flags("你说的对不上,发票和装箱单是两回事。")).toEqual([]);
    expect(flags("(点头)对对对,就这么办。")).toEqual(["sycophancy:对对对"]);
  });

  it("C20:成语、钟点不当数字;约数照样检查", () => {
    expect(flags("客户三天两头改单,三番五次地催。")).toEqual([]);
    expect(flags("八点二十开会,十点半结束。")).toEqual([]);
    expect(flags("也就五六个人在录。")).toEqual(["number:五", "number:六"]);
  });
});

describe("validator(评审 C21–C23、C25)", () => {
  const raw = () => parse(readFileSync(join(SCN_DIR, "scenario.yaml"), "utf8"));
  const errors = (data: unknown) => validateScenario(parseScenario(data, SCN_DIR)).errors;

  it("C21:标了 volunteered 但没有压力时刻说出它 → 报错", () => {
    const data = raw();
    data.traps = data.traps.map((x: { reveal?: string }) => ({ ...x, reveal: undefined }));
    expect(errors(data).some((e) => e.includes("volunteered"))).toBe(true);
  });

  it("C22:只能在汇报阶段向非老板角色解锁的事实不可达", () => {
    const data = raw();
    data.facts.push({ id: "Z1", cat: "problem", weight: 1, statement: "测试", unlock: [{ role: "liu", level: "L2", ask: "测试问题", requires: ["phase==report"] }] });
    expect(errors(data).some((e) => e.includes("Z1") && e.includes("没有任何可达"))).toBe(true);
  });

  it("C25:以压力时刻为前提的解锁不会被误报为不可达", () => {
    const data = raw();
    data.facts.push({ id: "Z2", cat: "problem", weight: 1, statement: "测试", unlock: [{ role: "zhou", level: "L2", ask: "测试问题二", requires: ["TR1"] }] });
    expect(errors(data).filter((e) => e.includes("Z2"))).toEqual([]);
  });

  it("C23:d3_points 写错的键、没实现的维度,在校验阶段就报错", () => {
    const data = raw();
    data.rubric.d3_points = { ...data.rubric.d3_points, quantifyin_ge4: 0 };
    expect(errors(data).some((e) => e.includes("quantifyin_ge4"))).toBe(true);
    const data2 = raw();
    data2.rubric.dimensions[0].id = "D9";
    expect(errors(data2).some((e) => e.includes("D9"))).toBe(true);
  });
});
