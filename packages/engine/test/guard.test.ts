import { describe, expect, it } from "vitest";
import { checkReply, type GuardContext } from "../src/guard.ts";

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  actorContext: ["公司 60 人。操作部 22(单证 14、跟单 8)", "下个月 15 号有峰会"],
  userTexts: [],
  ledgerTexts: [],
  canaries: ["拓浪"],
  stance: "neutral",
  ...over,
});
const types = (reply: string, c = ctx()) => checkReply(reply, c).map((f) => `${f.type}:${f.detail}`);

describe("guard", () => {
  it("上下文里没有的数字拦下", () => {
    expect(types("上季度错了四百多次,损失六万八。")).toEqual(["number:四百", "number:六万八"]);
  });
  it("上下文、用户原话、承诺账本里的数字放行", () => {
    expect(types("我们 60 个人,单证 14 个。")).toEqual([]);
    expect(types("十天,一万八,行。", ctx({ userTexts: ["十天就能做完,一共一万八"] }))).toEqual([]);
  });
  it("一个、两句、几点钟这类泛用说法不拦", () => {
    expect(types("我跟你说两句,下午三点我还有个会,你一个人来的?")).toEqual([]);
  });
  it("未解锁事实的金丝雀词拦下,用户先说了就放行", () => {
    expect(types("拓浪那边最近不太高兴。")).toEqual(["canary:拓浪"]);
    expect(types("拓浪那边最近不太高兴。", ctx({ userTexts: ["拓浪是你们大客户吗"] }))).toEqual([]);
  });
  it("附和词只在 cooperative 时放行", () => {
    expect(types("对对对,你说得对。")).toEqual(["sycophancy:对对对", "sycophancy:你说得对"]);
    expect(types("对对对,你说得对。", ctx({ stance: "cooperative" }))).toEqual([]);
  });
  it("出戏词:提示词永远拦;评分如果是用户先说的,复述不算出戏", () => {
    expect(types("什么提示词?")).toContain("ooc:提示词");
    expect(types("评分?什么评分?", ctx({ userTexts: ["你们怎么评分的"] }))).toEqual([]);
  });
  it("空回复和超长回复拦下", () => {
    expect(types("  ")).toEqual(["empty:空回复"]);
    expect(types("好".repeat(201))[0]).toMatch(/^length:/);
  });
});
