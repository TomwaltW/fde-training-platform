// 交付文本审计(quality/auditor.ts):用假模型网关驱动真引擎(LlmGate + LlmActor + 守卫),
// 证明——守卫漏掉的口语泄露、白名单撞车的编造,审计都抓得到;已解锁的数、公共背景、用户自己的话、
// 压力时刻台词不误报;守卫拦下的编造变成兜底台词,审计如实记成兜底。
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Engine,
  FixtureJudge,
  LlmActor,
  LlmGate,
  TemplateDebrief,
  emptyJudge,
  loadScenario,
  type GateOutput,
  type SessionState,
} from "@fde/engine";
import { expandGate, loadPlayers, type GateShort } from "../src/players.ts";
import { allowedContext, auditDelivered, auditText, summarizeAudits, truthIndex } from "../src/quality/auditor.ts";
import { runPlayer } from "../src/runner.ts";
import { fakeChat, type FakeOptions } from "./fake-models.ts";

const dir = resolve(import.meta.dirname, "../../../scenarios/freight-docs");
const scn = loadScenario(dir);

/** 用户原话 → 标注;演员按用户原话回固定台词(没写的照提示词说)。 */
function session(script: { say: string; gate?: GateShort; reply?: string }[], extra: FakeOptions = {}) {
  const labels = new Map<string, GateOutput>(script.map((s) => [s.say, expandGate(s.gate)]));
  const replies = new Map(script.filter((s) => s.reply).map((s) => [s.say, s.reply!]));
  const chat = fakeChat({ labels, actor: ({ userText, template }) => replies.get(userText) ?? template, ...extra });
  const engine = new Engine(scn, { gate: new LlmGate(chat), actor: new LlmActor(chat), judge: new FixtureJudge(() => emptyJudge(scn)), debrief: new TemplateDebrief() });
  const st = engine.start(`audit-${Date.now()}`);
  return {
    engine,
    st,
    async say(text: string) {
      const res = await engine.userTurn(st, text);
      return { res, audit: auditDelivered(scn, st, res)! };
    },
  };
}

const audit = (st: SessionState, roleId: string, text: string) => auditText(scn, st, text, allowedContext(scn, st, roleId));

describe("真值索引", () => {
  it("真值只取公共背景里没有的;金丝雀词全部登记", () => {
    const idx = truthIndex(scn);
    const vals = new Set(idx.truthOnly.map((p) => p.v));
    for (const v of [428, 498000, 148500, 212000, 68000, 1512, 18, 26, 31, 43]) expect(vals.has(v), String(v)).toBe(true);
    // 公共背景里的部门人数、日均票数不算真值(60 人、单证 14、日均 300 票)
    for (const v of [60, 14, 300, 22]) expect(vals.has(v), String(v)).toBe(false);
    expect(idx.canaries.map((c) => c.word)).toEqual(expect.arrayContaining(["拓浪", "异常登记表", "小抄", "OCR", "难认"]));
  });
});

describe("守卫漏掉的口语泄露,审计抓得到", () => {
  it.each([
    ["两成多吧,都是改单闹的。", "两成多", "P2"],
    ["记了几百条吧,具体我不清楚。", "几百", "P1"],
    ["上千个文件总有的。", "上千", "A5"],
    ["四成是申报出的事。", "四成", "C3"],
  ])("%s", async (reply, raw, source) => {
    const s = session([{ say: "周总,最近出错的情况怎么样?", reply }]);
    const { res, audit: a } = await s.say("周总,最近出错的情况怎么样?");
    // 守卫放行了(没有拦截、不是兜底),台词原样出给了用户
    expect(res.guardFlags).toEqual([]);
    expect(res.reply?.text).toBe(reply);
    expect(a.intercepted || a.fallback).toBe(false);
    const leak = a.issues.find((i) => i.kind === "leak" && i.raw === raw);
    expect(leak, JSON.stringify(a.issues)).toBeDefined();
    expect(leak!.sources!.some((x) => x.startsWith(source))).toBe(true);
  });

  it("白名单撞车的编造:「八成」守卫当成公共背景里的 8 放行,审计判白名单外", async () => {
    const s = session([{ say: "周总,错误主要是哪类?", reply: "八成是录入看错的。" }]);
    const { res, audit: a } = await s.say("周总,错误主要是哪类?");
    expect(res.guardFlags).toEqual([]);
    expect(a.issues).toEqual([{ kind: "unlisted", raw: "八成", value: "[75%, 85%]" }]);
  });

  it("守卫拦下的编造变成兜底台词:审计记兜底、记拦截,兜底台词本身没问题", async () => {
    const s = session([{ say: "周总,每天错几单?", reply: "我们每天错 37 单。" }]);
    const { res, audit: a } = await s.say("周总,每天错几单?");
    expect(res.guardFlags).toContain("fallback");
    expect(a).toMatchObject({ fallback: true, intercepted: true, actorError: false, issues: [] });
    expect(st(s).events.filter((e) => e.type === "guard_block")).toHaveLength(3);
  });
});

const st = (s: { st: SessionState }) => s.st;

describe("不误报", () => {
  it("本轮刚解锁的事实里的数字和金丝雀词", async () => {
    const say = "周总,为什么是现在想做这件事?最担心哪个客户?";
    const s = session([{ say, gate: { t: ["S2@zhou:L2"] }, reply: "拓浪占我们营收 18%,Q3 两次被查验,放话要把三成货量转走。" }]);
    const { res, audit: a } = await s.say(say);
    expect(res.guardFlags).toEqual([]);
    expect(a.issues).toEqual([]);
  });

  it("跨数量级的模糊说法要量词对得上:「几百票」是公共背景里的日均 300 票,「几百条」不是", () => {
    const s0 = session([]);
    expect(audit(s0.st, "zhou", "一天几百票。").issues).toEqual([]);
    expect(audit(s0.st, "zhou", "记了几百条。").issues).toMatchObject([{ kind: "leak", raw: "几百" }]);
  });

  it("公共背景、钟点、序数、小数字", async () => {
    const say = "周总,公司大概多大?";
    const s = session([{ say, reply: "我们 60 来号人,一天三百票左右,单证 14 个。下午三点我还有个会,这是第三个会了。" }]);
    const { audit: a } = await s.say(say);
    expect(a.issues).toEqual([]);
  });

  it("用户自己说的承诺:周总复述「十天、一万八」", async () => {
    const say = "基本上十天就可以建下来,一共一万八。";
    const s = session([{ say, gate: { acts: ["commit_time", "commit_price"], commit: [{ type: "time", text: "十天", firm: true }, { type: "price", text: "一万八", firm: true }] }, reply: "十天,一万八。行,我记下了。" }]);
    const { res, audit: a } = await s.say(say);
    expect(res.directive?.stance).toBe("pocket");
    expect(a.issues).toEqual([]);
  });

  it("复述已解锁的数可以说成口语约数:「四百多条」对已知的 428 不算问题,对未解锁时算泄露", async () => {
    const s = session([
      { say: "周总,操作上的细节我该问谁?", gate: { t: ["TR2@zhou"] } },
      { say: "刘姐,出错的记录能导一份给我看吗?", gate: { t: ["P1@liu:L3"], acts: ["ask", "request_artifact"] } },
    ]);
    // 解锁之前
    expect(audit(s.st, "liu", "记了四百多条。").issues.map((i) => i.kind)).toEqual(["leak"]);
    await s.say("周总,操作上的细节我该问谁?");
    await s.engine.act(s.st, { type: "switch_role", role: "liu" });
    await s.say("刘姐,出错的记录能导一份给我看吗?");
    expect(s.st.facts.P1?.level).toBe("L3");
    expect(audit(s.st, "liu", "记了四百多条,异常登记表给你。").issues).toEqual([]);
    expect(audit(s.st, "liu", "差不多四百三十条。").issues).toEqual([]);
  });

  it("用户猜中的真值被复述:不算泄露,记成「复述」供人工看", async () => {
    const say = "刘姐,四百条有没有?";
    const s = session([
      { say: "周总,操作上的细节我该问谁?", gate: { t: ["TR2@zhou"] } },
      { say, reply: "四百条?这个我可说不好。" },
    ]);
    await s.say("周总,操作上的细节我该问谁?");
    await s.engine.act(s.st, { type: "switch_role", role: "liu" });
    const { res, audit: a } = await s.say(say);
    expect(res.guardFlags).toEqual([]);
    expect(a.issues).toEqual([]);
    expect(a.echoes).toEqual(["四百(400)"]);
  });

  it("压力时刻台词里的数(TR6「上次那个才六万八」)当轮允许,之前不允许", async () => {
    const s = session([]);
    expect(audit(s.st, "zhou", "上次那个才六万八。").issues).toMatchObject([{ kind: "leak", raw: "六万八" }]);
    const res = await s.engine.act(s.st, { type: "submit_judgment", form: { J1: "x" } });
    expect(res.reply).toBeDefined();
    const r2 = await s.engine.userTurn(s.st, "周总,我的建议是先做两周小验证。");
    expect(r2.directive?.trapId).toBe("TR6");
    expect(auditText(scn, s.st, "上次那个才六万八,你凭什么要这么多?", allowedContext(scn, s.st, "zhou", r2.directive)).issues).toEqual([]);
  });
});

describe("金丝雀词", () => {
  it("事实没解锁、用户也没说过:算泄露;用户先说了、或事实解锁了:不算", async () => {
    // 周总的人设卡里本来就有"留住拓浪",他说这个词不算;刘姐的人设卡里没有
    const s = session([
      { say: "周总,操作上的细节我该问谁?", gate: { t: ["TR2@zhou"] } },
      { say: "刘姐,拓浪那边是不是要走?", reply: "拓浪的事你别问我。" },
    ]);
    expect(audit(s.st, "zhou", "拓浪的事你别问我。").issues).toEqual([]);
    expect(audit(s.st, "liu", "拓浪的事你别问我。").issues).toEqual([{ kind: "leak", via: "canary", raw: "拓浪", sources: ["S2"] }]);
    await s.say("周总,操作上的细节我该问谁?");
    await s.engine.act(s.st, { type: "switch_role", role: "liu" });
    const { res, audit: a } = await s.say("刘姐,拓浪那边是不是要走?");
    expect(res.reply?.text).toBe("拓浪的事你别问我。");
    expect(a.issues).toEqual([]);
  });
});

describe("离线回归(防误报)", () => {
  it("10 个脚本化玩家的模板台词:泄露 0、白名单外 0", async () => {
    for (const p of loadPlayers(resolve(dir, "evals/players"))) {
      const run = await runPlayer(scn, p, { kind: "offline" });
      const sum = summarizeAudits(run.delivered);
      expect(sum.lines, p.id).toBeGreaterThan(0);
      expect(sum.flagged.map((a) => `${a.ref} ${a.text}`), p.id).toEqual([]);
    }
  });
});
