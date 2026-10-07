// 交付文本审计的数字规整(quality/numerals.ts):阿拉伯数字、中文数字、口语约数都规整成区间。
import { describe, expect, it } from "vitest";
import { extractQuantities, isRound, placeValue, showQuantity } from "../src/quality/numerals.ts";

const one = (s: string) => {
  const qs = extractQuantities(s);
  expect(qs, `${s} 应该只抽出一个量:${qs.map((q) => q.raw).join("、")}`).toHaveLength(1);
  return qs[0]!;
};
const shown = (s: string) => showQuantity(one(s));

describe("精确数", () => {
  it.each([
    ["四百二十八条", "428"],
    ["六万八", "68000"],
    ["6.8万", "68000"],
    ["49.8万", "498000"],
    ["四十九点八万", "498000"],
    ["十四万八千五", "148500"],
    ["14.85 万", "148500"],
    ["一千五", "1500"],
    ["1,512 个文件", "1512"],
    ["一万八", "18000"],
    ["18%", "18%"],
    ["百分之十八", "18%"],
    ["一成八", "18%"],
    ["十八个点", "18%"],
  ])("%s → %s", (s, want) => {
    expect(shown(s)).toBe(want);
    expect(one(s).kind).toBe("exact");
  });
});

describe("口语约数", () => {
  it.each([
    ["四百多条", "[400, 500]"],
    ["400多条", "[400, 500]"],
    ["五十多万", "[500000, 600000]"],
    ["四十来万", "[400000, 500000]"],
    ["二十几万", "[200000, 300000]"],
    ["1万多块", "[10000, 20000]"],
    ["几十万", "[200000, 990000]"],
    ["大几十万", "[500000, 990000]"],
    ["十几个", "[11, 19]"],
    ["十多万", "[100000, 200000]"],
    ["上千条", "[1000, 9999]"],
    ["几百条", "[200, 999]"],
    ["三成", "[25%, 35%]"],
    ["两成多", "[20%, 30%]"],
    ["将近五十万", "[450000, 550000]"],
    ["五十万左右", "[450000, 550000]"],
    ["三百条左右", "[270, 330]"],
    ["小五十万", "[450000, 550000]"],
    ["三十出头", "[30, 40]"],
    ["百分之三十左右", "[27%, 33%]"],
  ])("%s → %s", (s, want) => {
    expect(shown(s)).toBe(want);
    expect(one(s).kind).toBe("approx");
  });

  it.each([
    ["百分之十几", "[11%, 19%]"],
    ["十几个点", "[11%, 19%]"],
    ["十几个百分点", "[11%, 19%]"],
    ["四十几个点", "[40%, 50%]"],
    ["二十多个点", "[20%, 30%]"],
    ["百分之二十几", "[20%, 30%]"],
    ["百分之三十多", "[30%, 40%]"],
    ["30多%", "[30%, 40%]"],
    ["三十多%", "[30%, 40%]"],
    ["三分之一", "[30%, 36.667%]"],
    ["四分之一", "[22.5%, 27.5%]"],
    ["一半", "[45%, 55%]"],
    ["差不多一半", "[45%, 55%]"],
    ["将近一半", "[40%, 50%]"],
    ["一多半", "[50%, 70%]"],
    ["一半多", "[50%, 70%]"],
    ["大半是改单", "[50%, 70%]"],
  ])("百分数的口语约数 %s → %s", (s, want) => {
    expect(shown(s)).toBe(want);
    expect(one(s)).toMatchObject({ percent: true, kind: "approx", unit: "%" });
  });

  it.each([
    ["近千个", "[900, 1000]"],
    ["千把块", "[1000, 1999]"],
    ["百把人", "[100, 199]"],
    ["近千万", "[9000000, 10000000]"],
  ])("数量级约数 %s → %s", (s, want) => {
    expect(shown(s)).toBe(want);
    expect(one(s).percent).toBe(false);
  });

  it("放宽过的精确数记下放宽前的数;四五百没跟量词也是两端", () => {
    expect(one("差不多四百三")).toMatchObject({ lo: 387, hi: 473, kind: "approx", center: 430 });
    expect(one("四百多").center).toBeUndefined();
    expect(one("四五百有没有")).toMatchObject({ lo: 400, hi: 500, kind: "range", raw: "四五百" });
    expect(one("两三百吧")).toMatchObject({ lo: 200, hi: 300, kind: "range" });
  });

  it("两端都说出来的约数是 range", () => {
    expect(one("五六十个人")).toMatchObject({ lo: 50, hi: 60, kind: "range", unit: "个" });
    expect(one("四五百条")).toMatchObject({ lo: 400, hi: 500, kind: "range" });
    expect(one("两三天")).toMatchObject({ lo: 2, hi: 3, kind: "range", unit: "天" });
    expect(one("七八成")).toMatchObject({ lo: 70, hi: 80, kind: "range", percent: true });
  });

  it("字面模式(给作者写的文字):约、三成都按字面取", () => {
    expect(extractQuantities("约 19800 票", { literal: true })[0]).toMatchObject({ lo: 19800, hi: 19800 });
    expect(extractQuantities("要把三成货量转走", { literal: true })[0]).toMatchObject({ lo: 30, hi: 30, percent: true });
    expect(extractQuantities("约 19800 票")[0]).toMatchObject({ lo: 17820, hi: 21780 });
  });
});

describe("不是数的不抽", () => {
  it.each(["几乎没有", "一成不变", "Q3 一共", "运单 LT2609-0387", "三天两头来改单", "他来了就走", "九成九是看错了", "多半是看错了", "忙了大半天", "最近千万别改单", "十分重要"])("%s", (s) => {
    expect(extractQuantities(s).filter((q) => q.lo >= 10 || q.percent)).toEqual([]);
  });

  it.each([
    "活干到一半,客户又改单了",
    "录到一半发现箱数对不上",
    "你这话只说对了一半",
    "一半一半吧",
    "说一半留一半",
    "我一大半时间都在核对",
    "大半时间在核对",
    "一半的时间在追客户",
    "到一半的时候停了",
  ])("不是在说占比的一半:%s", (s) => {
    expect(extractQuantities(s)).toEqual([]);
  });

  it.each(["改单占了一半", "改单占到一半", "错误率达到一半", "有一半是改单"])("说的是占比的一半照常认:%s", (s) => {
    expect(one(s)).toMatchObject({ lo: 45, hi: 55, percent: true, raw: "一半" });
  });

  it("钟点保留单位「点」,序数保留前面的「第」由审计去豁免", () => {
    expect(one("下午三点半")).toMatchObject({ lo: 3, unit: "点" });
    // "十一二点":十一点到十二点,两段都是钟点
    expect(extractQuantities("夜里十一二点还在改").map((q) => q.unit)).toEqual(["点", "点"]);
    expect(one("第三轮")).toMatchObject({ lo: 3, index: 1 });
  });
});

describe("辅助函数", () => {
  it("末位位值与整数约数", () => {
    expect(placeValue(400)).toBe(100);
    expect(placeValue(140000)).toBe(10000);
    expect(placeValue(428)).toBe(1);
    expect([30, 400, 430, 1500, 500000, 150000].every(isRound)).toBe(true);
    expect([428, 31, 19, 8, 1512].some(isRound)).toBe(false);
  });
});
