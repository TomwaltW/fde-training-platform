import { describe, expect, it } from "vitest";
import { checkJudgeOutput, createSession, emptyJudge, scoreSession, type SessionState } from "../src/index.ts";
import { scn } from "./helpers.ts";

function session(): SessionState {
  const st = createSession(scn, { sessionId: "t" });
  st.turn = 1;
  st.transcript.push({ ref: "U1", turn: 1, speaker: "user", roleId: "zhou", text: "主要问题不是识别", phase: "discovery" });
  st.judgment = { J1: "主要问题是单据之间不一致", J2: "", J3: "大会演示", J4: "两周小验证", J5: "" };
  return st;
}

describe("judge output check", () => {
  it("引用不存在的编号、或只引用角色台词 → 按 miss", () => {
    const st = session();
    const { output, issues } = checkJudgeOutput(scn, st, {
      T: [
        { id: "T1", verdict: "hit", evidence: ["U99"], grade: "C" },
        { id: "T2", verdict: "hit", evidence: ["N1"], grade: "C" },
        { id: "T3", verdict: "hit", evidence: ["J2"], grade: "C" }, // J2 是空的
      ],
    });
    expect(output.T.find((t) => t.id === "T1")?.verdict).toBe("miss");
    expect(output.T.find((t) => t.id === "T2")?.verdict).toBe("miss");
    expect(output.T.find((t) => t.id === "T3")?.verdict).toBe("miss");
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it("A 级证据在事件日志里没有对应的资料或验证 → 按 miss;有就保留", () => {
    const st = session();
    const raw = { T: [{ id: "T1", verdict: "hit", evidence: ["J1"], grade: "A" }] };
    expect(checkJudgeOutput(scn, st, raw).output.T[0]?.verdict).toBe("miss");
    st.experiments.X3 = { turn: 1 };
    expect(checkJudgeOutput(scn, st, raw).output.T[0]?.verdict).toBe("hit");
  });

  it("命中但没给等级 → 按 D", () => {
    const st = session();
    const { output } = checkJudgeOutput(scn, st, { T: [{ id: "T2", verdict: "hit", evidence: ["J1"] }] });
    expect(output.T.find((t) => t.id === "T2")?.grade).toBe("D");
  });

  it("S、W 项必须有 J 引用才算", () => {
    const st = session();
    const { output } = checkJudgeOutput(scn, st, {
      S: [{ id: "S1", mentioned_in_judgment: true, evidence: ["U1"] }],
      W: [{ id: "W5", met: true, evidence: ["J4"] }],
    });
    expect(output.S.find((s) => s.id === "S1")?.mentioned_in_judgment).toBe(false);
    expect(output.W.find((w) => w.id === "W5")?.met).toBe(true);
  });

  it("结构完全不对的输出不崩溃,全部按 miss", () => {
    const st = session();
    const { output, issues } = checkJudgeOutput(scn, st, "not json at all");
    expect(output.T.every((t) => t.verdict === "miss")).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("scoring", () => {
  it("D4:contradict 扣一半权重,D 级命中打五折,总分不为负", () => {
    const st = session();
    const judge = emptyJudge(scn);
    judge.T = [
      { id: "T1", verdict: "contradict", evidence: ["J1"], note: "" },
      { id: "T2", verdict: "hit", evidence: ["J1"], grade: "D", note: "" },
    ];
    const d4 = scoreSession(scn, st, judge).dimensions.find((d) => d.id === "D4")!;
    expect(d4.score).toBe(0); // -3 + 2.5 → 夹到 0
    judge.T = [{ id: "T2", verdict: "hit", evidence: ["J1"], grade: "D", note: "" }];
    expect(scoreSession(scn, st, judge).dimensions.find((d) => d.id === "D4")!.score).toBe(2.5);
  });

  it("D5:事实既要解锁到 L2,又要写进判断", () => {
    const st = session();
    const judge = emptyJudge(scn);
    judge.S = judge.S.map((s) => (s.id === "S1" ? { ...s, mentioned_in_judgment: true, evidence: ["J3"] } : s));
    expect(scoreSession(scn, st, judge).dimensions.find((d) => d.id === "D5")!.score).toBe(0);
    st.facts.S1 = { level: "L2", turn: 1, source: "zhou" };
    expect(scoreSession(scn, st, judge).dimensions.find((d) => d.id === "D5")!.score).toBe(3);
  });

  it("D6:过早报工期、报价、保证准确率,收回一项加回 2;没看资料就报价 → D6 记 0 并打标记", () => {
    const st = session();
    const snap = { facts: [], artifactsOpened: [] };
    st.ledger = [
      { id: "L1", type: "time", valueText: "十天", turn: 1, role: "zhou", premature: true, knownAtThatTime: snap },
      { id: "L2", type: "price", valueText: "一万八", turn: 1, role: "zhou", premature: true, knownAtThatTime: snap, retractedTurn: 3 },
    ];
    st.exchanges = { zhou: 1 };
    const r = scoreSession(scn, st, emptyJudge(scn));
    expect(r.dimensions.find((d) => d.id === "D6")!.score).toBe(0);
    expect(r.badges).toContain("先报价后看货");
    expect(r.caps.map((c) => c.label)).toEqual(expect.arrayContaining(["只和周总说过话", "没打开过任何资料"]));
  });

  it("D6:看过资料之后的承诺不触发「先报价后看货」,收回过早承诺加分", () => {
    const st = session();
    const snap = { facts: [], artifactsOpened: ["A1"] };
    st.ledger = [{ id: "L1", type: "time", valueText: "十天", turn: 1, role: "zhou", premature: true, knownAtThatTime: snap, retractedTurn: 2 }];
    const r = scoreSession(scn, st, emptyJudge(scn));
    expect(r.badges).toEqual([]);
    expect(r.dimensions.find((d) => d.id === "D6")!.score).toBe(8); // 10 - 4 + 2
  });

  it("封顶:只和周总说过话 → 总分不超过 45", () => {
    const st = session();
    st.exchanges = { zhou: 5 };
    for (const f of scn.data.facts) st.facts[f.id] = { level: "L3", turn: 1, source: "zhou" };
    const judge = emptyJudge(scn);
    judge.T = judge.T.map((t) => ({ ...t, verdict: "hit" as const, grade: "B" as const, evidence: ["J1"] }));
    judge.W = judge.W.map((w) => ({ ...w, met: true, evidence: ["J4"] }));
    const r = scoreSession(scn, st, judge);
    expect(r.rawTotal).toBeGreaterThan(45);
    expect(r.total).toBe(45);
  });
});
