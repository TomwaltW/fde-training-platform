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
  it.each(["几乎没有", "一成不变", "Q3 一共", "运单 LT2609-0387", "三天两头来改单", "他来了就走"])("%s", (s) => {
    expect(extractQuantities(s).filter((q) => q.lo >= 10 || q.percent)).toEqual([]);
  });

  it("钟点保留单位「点」,序数保留前面的「第」由审计去豁免", () => {
    expect(one("下午三点半")).toMatchObject({ lo: 3, unit: "点" });
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
