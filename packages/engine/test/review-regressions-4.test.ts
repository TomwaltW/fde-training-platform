// 第四轮(最后一轮轻量复核)确认的问题:动作代表的信任加分在执行时结算。
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
  emptyJudge,
  gateOutput,
  parseScenario,
  validateScenario,
  type GateOutput,
  type LoadedScenario,
} from "../src/index.ts";
import { SCN_DIR, scn } from "./helpers.ts";

const t = (...ids: string[]) => ids.map((id) => ({ id, confidence: 0.9 }));
const gesture = { dir: "plus" as const, what: "肯去现场看" };

function atChen(s: LoadedScenario = scn) {
  const gate = new QueueGate();
  const engine = new Engine(s, { gate, actor: new TemplateActor(), judge: new FixtureJudge(() => emptyJudge(s)), debrief: new TemplateDebrief() });
  const st = engine.start("t");
  st.discovered.push("liu", "chen");
  st.currentRole = "chen";
  st.exchanges.chen = 3;
  st.traps.TR5 = { turn: 0 };
  st.flags.auth_ops = true;
  const say = async (text: string, g: Partial<GateOutput>) => {
    gate.push(gateOutput(g));
    const r = await engine.userTurn(st, text);
    gate.clear();
    return r;
  };
  return { engine, st, say };
}
const visitReq = { acts: ["request_site_visit"] as GateOutput["acts"], matched_triggers: t("act:site_visit"), trust_moves: [gesture] };

describe("trust_move 在动作执行时结算", () => {
  it("去过现场之后再说'想去现场看看',不再加信任,小抄仍然拿不到", async () => {
    const { st, say } = atChen();
    await say("我想去你们现场看看。", visitReq);
    expect(st.trust.chen).toBe(1);
    const r = await say("我想再去现场看看。", visitReq);
    expect(r.system.join("")).toContain("已经去过");
    expect(st.trust.chen).toBe(1);
    await say("能给我看看你自己整理的对照资料吗?", { matched_triggers: t("P5@chen:L3") });
    expect(st.artifacts.A3).toBeUndefined();
  });

  it("用按钮去过现场之后,再说「肯去现场看」也不加分", async () => {
    const { engine, st, say } = atChen();
    await engine.act(st, { type: "action", action: "site_visit" });
    expect(st.trust.chen).toBe(1);
    await say("我愿意多去现场看看。", { trust_moves: [gesture] });
    expect(st.trust.chen).toBe(1);
  });

  it("时间在本轮用完、现场没去成:这句话本身的加分照样算", async () => {
    const { st, say } = atChen();
    st.minutesUsed = 356;
    await say("录的时候最常卡在哪?我想去现场看看。", { ...visitReq, acts: ["ask", "request_site_visit"], matched_triggers: t("P7@chen:L2", "act:site_visit") });
    expect(st.actionsDone.site_visit).toBeUndefined();
    expect(st.trust.chen).toBe(1);
  });

  it("同一句话里先拿到授权、再去现场:加分只算一次", async () => {
    const raw = parse(readFileSync(join(SCN_DIR, "scenario.yaml"), "utf8"));
    raw.flags.auth_ops.granted_by = "liu";
    raw.actions.site_visit.requires = ["auth_ops"];
    raw.actions.site_visit.effects.push("trust.liu+1");
    const s2 = parseScenario(raw, SCN_DIR);
    const { st, say } = atChen(s2);
    st.flags.auth_ops = false;
    st.currentRole = "liu";
    st.exchanges.liu = 3;
    st.traps.TR4 = { turn: 0 };
    await say("能让我去现场看看吗?", { acts: ["request_permission", "request_site_visit"], matched_triggers: t("perm:auth_ops", "act:site_visit"), trust_moves: [gesture] });
    expect(st.actionsDone.site_visit).toBeDefined();
    expect(st.trust.liu).toBe(1);
  });

  it("校验器:trust_move 不在 trust_moves.plus 里 → 报错", () => {
    const raw = parse(readFileSync(join(SCN_DIR, "scenario.yaml"), "utf8"));
    raw.actions.site_visit.trust_move = "肯去现埸看";
    const r = validateScenario(parseScenario(raw, SCN_DIR));
    expect(r.errors.some((e) => e.includes("trust_move"))).toBe(true);
  });
});
