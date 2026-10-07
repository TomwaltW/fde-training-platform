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
    const plain = new Set(idx.truthOnly.filter((p) => !p.percent).map((p) => p.v));
    for (const v of [60, 14, 300, 22]) expect(plain.has(v), String(v)).toBe(false);
    // 按"值 + 是不是百分数"去重:单证 14 人盖不住 P2 的录入手误 14%、X5 的拓浪占全部异常 14%
    expect(idx.truthOnly.filter((p) => p.v === 14 && p.percent).map((p) => p.source).sort()).toEqual(["P2", "X5"]);
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

  it.each([
    ["图片也就十几个点。", "十几个点", "P3"],
    ["资料矛盾差不多三分之一。", "三分之一", "P2"],
    ["改单的有四分之一吧。", "四分之一", "P2"],
    ["上周近千个Excel。", "近千", "truth.intake_formats.xlsx"],
  ])("百分数、分数、近千这类说法守卫放行,审计算泄露:%s", async (reply, raw, source) => {
    const s = session([{ say: "周总,最近出错的情况怎么样?", reply }]);
    const { res, audit: a } = await s.say("周总,最近出错的情况怎么样?");
    expect(res.guardFlags).toEqual([]);
    expect(res.reply?.text).toBe(reply);
    const leak = a.issues.find((i) => i.kind === "leak" && i.raw === raw);
    expect(leak, JSON.stringify(a.issues)).toBeDefined();
    expect(leak!.sources!.some((x) => x.startsWith(source)), JSON.stringify(leak)).toBe(true);
  });

  it.each([
    ["HS 申报占百分之十几。", "百分之十几", "P3"],
    ["四十几个点是申报的。", "四十几个点", "C3"],
    ["二十多个点。", "二十多个点", "P2"],
    ["百分之二十几。", "百分之二十几", "P2"],
    ["百分之五十几是对不上。", "百分之五十几", "truth.diagnosis_items[1]"],
    ["30多%是改单。", "30多%", "S2"],
    ["将近一半是申报的。", "将近一半", "C3"],
    ["一半多都是单据对不上。", "一半多", "truth.diagnosis_items[1]"],
  ])("百分数的口语约数不丢百分号:%s", (text, raw, source) => {
    const s0 = session([]);
    const leak = audit(s0.st, "liu", text).issues.find((i) => i.kind === "leak" && i.raw === raw);
    expect(leak, text).toBeDefined();
    expect(leak!.sources!.some((x) => x.startsWith(source)), JSON.stringify(leak)).toBe(true);
  });

  it("公共背景里的人数盖不住同值的百分数:「百分之十四」「十四个点」对上录入手误 14%,算泄露;「单证十四个」不算", () => {
    const s0 = session([]);
    for (const text of ["百分之十四。", "十四个点。"]) {
      expect(audit(s0.st, "zhou", text).issues, text).toMatchObject([{ kind: "leak", via: "number", sources: expect.arrayContaining(["P2 14%"]) }]);
    }
    expect(audit(s0.st, "zhou", "单证十四个,跟单八个。").issues).toEqual([]);
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
    // 同一类量词算一个:公司约 60 人,"几十号人""几十个人"都是它
    expect(audit(s0.st, "zhou", "我们公司几十号人。").issues).toEqual([]);
    expect(audit(s0.st, "zhou", "几十个人吧。").issues).toEqual([]);
    // 复述用户自己的说法可以省量词
    const ctx = allowedContext(scn, s0.st, "liu");
    ctx.userTexts.push("几十万块有没有?");
    expect(auditText(scn, s0.st, "几十万?我可说不好。", ctx)).toEqual({ issues: [], echoes: ["几十万([200000, 990000])"] });
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

describe("约数只能单向解释:说得比已知的更细就不放行", () => {
  /** 刘姐已经出现、还没拿到 P1;用户先猜一句,再看角色(默认刘姐)的回答。 */
  async function afterGuess(guess: string, role = "liu") {
    const s = session([{ say: "周总,操作上的细节我该问谁?", gate: { t: ["TR2@zhou"] } }]);
    await s.say("周总,操作上的细节我该问谁?");
    await s.engine.act(s.st, { type: "switch_role", role: "liu" });
    const ctx = allowedContext(scn, s.st, role);
    ctx.userTexts.push(guess);
    return (text: string) => auditText(scn, s.st, text, ctx);
  }

  it.each([
    ["四百条有没有?你点个头就行。", "四百三十条。", "四百三十", "P1"],
    ["四百条有没有?", "差不多四百三。", "四百三", "P1"],
    ["四百条有没有?", "四百多条吧。", "四百多", "P1"],
    ["四百条有没有?", "四百出头。", "四百", "P1"],
    ["二十万有没有?", "二十一万。", "二十一万", "C3"],
    ["一百二十条有没有?", "对,一百三。", "一百三", "X2"],
    ["四五百有没有?", "四百三吧。", "四百三", "P1"],
  ])("用户猜「%s」,角色答「%s」:比用户说得细,算泄露", async (guess, reply, raw, source) => {
    const a = (await afterGuess(guess))(reply);
    const leak = a.issues.find((i) => i.kind === "leak" && i.raw.startsWith(raw));
    expect(leak, JSON.stringify(a)).toBeDefined();
    expect(leak!.sources!.some((x) => x.startsWith(source)), JSON.stringify(leak)).toBe(true);
    expect(a.echoes).toEqual([]);
  });

  // 精确数只认原样复述和往粗里取整:用户猜的整数离真值不到 0.5% 时,角色也不能借"复述"把真值的零头说出来
  it.each([
    ["wang", "损失有没有五十万?", "四十九万八。", "四十九万八", "C2"],
    ["wang", "损失有没有五十万?", "四十九万八千。", "四十九万八千", "C2"],
    ["wang", "损失有没有四十九万?", "四十九万八。", "四十九万八", "C2"],
    ["liu", "四百三十条有没有?", "四百二十八条。", "四百二十八", "P1"],
    ["liu", "四百二十九条有没有?", "四百二十八条。", "四百二十八", "P1"],
    ["wang", "改单是不是十四万八?", "十四万八千五。", "十四万八千五", "C3"],
    ["chen", "Excel 有九百四吗?", "九百三十七个。", "九百三十七", "truth.intake_formats.xlsx"],
  ])("%s:用户猜「%s」,角色答「%s」:比用户的数多出有效数字(或位值一样却不同),算泄露", async (role, guess, reply, raw, source) => {
    const a = (await afterGuess(guess, role))(reply);
    const leak = a.issues.find((i) => i.kind === "leak" && i.raw === raw);
    expect(leak, JSON.stringify(a)).toBeDefined();
    expect(leak!.sources!.some((x) => x.startsWith(source)), JSON.stringify(leak)).toBe(true);
    expect(a.echoes).toEqual([]);
  });

  it.each([
    ["liu", "四百二十八条有没有?", "四百三吧。"],
    ["wang", "损失有没有四十九万八?", "五十万吧,我得查查。"],
  ])("%s:用户猜「%s」,角色答「%s」:把用户的数往粗里取整,是复述", async (role, guess, reply) => {
    const a = (await afterGuess(guess, role))(reply);
    expect(a.issues).toEqual([]);
    expect(a.echoes).toHaveLength(1);
  });

  it.each([
    ["四百条有没有?", "四百条?这个我可说不好。"],
    ["四百条有没有?", "几百条吧,我没数过。"],
    ["四百条有没有?", "大概四百吧,我也说不准。"],
    ["四五百有没有?", "四百多吧。"],
  ])("用户猜「%s」,角色答「%s」:不比用户说得细,是复述", async (guess, reply) => {
    const a = (await afterGuess(guess))(reply);
    expect(a.issues).toEqual([]);
    expect(a.echoes).toHaveLength(1);
  });

  // 有方向的约数说的是 X 的哪一边:比用户的"四百""五十万"多告诉了一半信息,不能当复述放过
  it.each([
    ["liu", "四百条有没有?", "超过四百条吧。", "P1"],
    ["liu", "四百条有没有?", "至少四百条。", "P1"],
    ["wang", "损失有没有五十万?", "不到五十万。", "C2"],
    ["wang", "损失有没有五十万?", "将近五十万。", "C2"],
    ["wang", "损失有没有五十万?", "快五十万了。", "C2"],
    ["wang", "损失有没有五十万?", "小五十万吧。", "C2"],
  ])("%s:用户猜「%s」,角色答「%s」:有方向的说法不算复述,对上未解锁的真值算泄露", async (role, guess, reply, source) => {
    const a = (await afterGuess(guess, role))(reply);
    const leak = a.issues.find((i) => i.kind === "leak");
    expect(leak, JSON.stringify(a)).toBeDefined();
    expect(leak!.sources!.some((x) => x.startsWith(source)), JSON.stringify(leak)).toBe(true);
    expect(a.echoes).toEqual([]);
  });

  it.each([
    ["liu", "超过四百条有没有?", "超过四百条吧。"],
    ["liu", "四百多条有没有?", "超过四百条吧。"],
    ["wang", "损失是不是不到五十万?", "不到五十万。"],
    ["wang", "损失是不是将近五十万?", "不到五十万吧。"],
  ])("%s:用户猜「%s」,角色答「%s」:用户自己说了同一边(或更细),是复述", async (role, guess, reply) => {
    const a = (await afterGuess(guess, role))(reply);
    expect(a.issues).toEqual([]);
    expect(a.echoes).toHaveLength(1);
  });

  it("用户说「不到五十万」,角色答「将近五十万」:比用户说得细,算泄露", async () => {
    const a = (await afterGuess("损失是不是不到五十万?", "wang"))("将近五十万。");
    expect(a.issues).toMatchObject([{ kind: "leak", raw: "五十万", sources: expect.arrayContaining(["C2 498000"]) }]);
  });

  it("没人提过时「超过四百条」「不到五十万」照样对真值审;解锁之后不算问题", async () => {
    const s0 = session([]);
    expect(audit(s0.st, "liu", "超过四百条吧。").issues).toMatchObject([{ kind: "leak", raw: "四百", value: "[400, 500]" }]);
    expect(audit(s0.st, "wang", "不到五十万。").issues).toMatchObject([{ kind: "leak", raw: "五十万", value: "[400000, 500000]" }]);
    // 单边区间的另一头收住了:公共背景里没带量词的 22、14 解释不了"不到五十万"
    expect(audit(s0.st, "zhou", "不到五十万。").issues).toHaveLength(1);
    s0.st.facts.P1 = { level: "L3", turn: 1, source: "liu" };
    s0.st.facts.C2 = { level: "L2", turn: 1, source: "wang" };
    expect(audit(s0.st, "liu", "超过四百条吧。").issues).toEqual([]);
    expect(audit(s0.st, "wang", "不到五十万。").issues).toEqual([]);
    expect(audit(s0.st, "wang", "将近五十万。").issues).toEqual([]);
  });

  it("公共背景里的整数约数不能洗白更细的数:「日均约 300 票」放行「三百票」「三百多票」,不放行「三百二十」", () => {
    const s0 = session([]);
    expect(audit(s0.st, "zhou", "一天三百票吧。").issues).toEqual([]);
    expect(audit(s0.st, "zhou", "一天三百多票。").issues).toEqual([]);
    expect(audit(s0.st, "zhou", "一天三百个单子。").issues).toEqual([]);
    expect(audit(s0.st, "lin", "三百二十个 PDF 文件。").issues).toMatchObject([{ kind: "leak", raw: "三百二十", sources: ["truth.intake_formats.pdf 318"] }]);
    expect(audit(s0.st, "liu", "三百二十票。").issues).toMatchObject([{ kind: "leak", raw: "三百二十" }]);
  });

  it("约数和已知值比时量词要兼容:「三四百票」是日均票数,「三四百条」不是", () => {
    const s0 = session([]);
    expect(audit(s0.st, "zhou", "三四百票吧。").issues).toEqual([]);
    expect(audit(s0.st, "zhou", "三四百条吧。").issues).toMatchObject([{ kind: "leak", raw: "三四百" }]);
  });

  it("已知值的取整照样放行:拿到 P1 之后「四百」「四百三」都行;已知 14 人不放行「十」", async () => {
    const s = session([
      { say: "周总,操作上的细节我该问谁?", gate: { t: ["TR2@zhou"] } },
      { say: "刘姐,出错的记录能导一份给我看吗?", gate: { t: ["P1@liu:L3"], acts: ["ask", "request_artifact"] } },
    ]);
    await s.say("周总,操作上的细节我该问谁?");
    await s.engine.act(s.st, { type: "switch_role", role: "liu" });
    await s.say("刘姐,出错的记录能导一份给我看吗?");
    expect(audit(s.st, "liu", "四百条上下吧。").issues).toEqual([]);
    expect(audit(s.st, "liu", "四百三十条。").issues).toEqual([]);
    expect(audit(s.st, "liu", "单证就十个人。").issues).toMatchObject([{ kind: "unlisted", raw: "十" }]);
  });
});

describe("不该算数的不算", () => {
  it("年份、钟点范围、口头禅「九成九」", () => {
    const s0 = session([]);
    expect(audit(s0.st, "zhou", "今年是2026年,下个月就开大会。").issues).toEqual([]);
    expect(audit(s0.st, "chen", "夜里十一二点还在改单。").issues).toEqual([]);
    expect(audit(s0.st, "zhou", "九成九是看错了。").issues).toEqual([]);
    // 统计口径不是真值
    const vals = new Set(truthIndex(scn).truthOnly.map((p) => p.v));
    expect(vals.has(19800) || vals.has(2026)).toBe(false);
  });

  it("带量词的数不和量词对不上的真值比:「三十天」是编造,「三十票」才对得上验证 X4 的 30 票", () => {
    const s0 = session([]);
    expect(audit(s0.st, "zhou", "三十天。").issues).toEqual([{ kind: "unlisted", raw: "三十", value: "30" }]);
    expect(audit(s0.st, "zhou", "三十票。").issues).toMatchObject([{ kind: "leak", raw: "三十", sources: ["X4 30"] }]);
  });
});

describe("不是在说占比的「一半」「大半」不算数", () => {
  it("小陈讲时间怎么花(P6 已拿到)、干到一半、说对了一半、一半一半:不误报;说的是占比的照常审", () => {
    const s0 = session([]);
    s0.st.facts.P6 = { level: "L2", turn: 1, source: "chen" };
    for (const [role, text] of [
      ["chen", "我一大半时间都在核对,追客户补资料。"],
      ["chen", "大半时间在核对。"],
      ["chen", "活干到一半,客户又改单了。"],
      ["chen", "录到一半发现箱数对不上。"],
      ["zhou", "你这话只说对了一半。"],
      ["chen", "一半一半吧。"],
    ] as const) {
      expect(audit(s0.st, role, text).issues, text).toEqual([]);
    }
    expect(audit(s0.st, "chen", "一大半是客户资料对不上。").issues).toMatchObject([{ kind: "leak", raw: "一大半" }]);
    expect(audit(s0.st, "chen", "改单占了一半。").issues).toMatchObject([{ raw: "一半" }]);
  });

  it("「了一半」「到一半」只有干活的进度不算:超过了一半、错了一半照常审(T2 还没解锁)", () => {
    const s0 = session([]);
    expect(audit(s0.st, "chen", "超过了一半是改单和资料对不上。").issues).toMatchObject([
      { kind: "leak", raw: "超过了一半", sources: expect.arrayContaining(["truth.diagnosis_items[1].statement 57%"]) },
    ]);
    expect(audit(s0.st, "chen", "错了一半是改单。").issues).toMatchObject([{ raw: "一半" }]);
    expect(audit(s0.st, "chen", "单子改了一半。").issues).toMatchObject([{ raw: "一半" }]);
    for (const text of ["录了一半就下班了。", "说到一半他就走了。", "路才走了一半。"]) {
      expect(audit(s0.st, "chen", text).issues, text).toEqual([]);
    }
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
