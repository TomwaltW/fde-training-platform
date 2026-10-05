import { describe, expect, it } from "vitest";
import { extractNumbers } from "../src/numbers.ts";

const values = (t: string) => extractNumbers(t).map((n) => n.value);

describe("extractNumbers", () => {
  it("口语中文数字", () => {
    expect(values("一共一万八")).toEqual([18000]);
    expect(values("上次那个才六万八")).toEqual([68000]);
    expect(values("两万五、三千五、一百二")).toEqual([25000, 3500, 120]);
    expect(values("十二个人,二十件")).toEqual([12, 20]);
    expect(values("一百零五")).toEqual([105]);
  });
  it("连写的两个数字在第二个数字处断开:一千八一天", () => {
    expect(values("工时费一千八一天")).toEqual([1800, 1]);
  });
  it("阿拉伯数字、千分位、万、百分数", () => {
    expect(values("Q3 直接损失约 49.8 万")).toEqual([498000]);
    expect(values("一共 1,512 个文件,31% 是 Excel")).toEqual([1512, 31]);
    expect(values("录入 2.74 万")).toEqual([27400]);
    expect(values("百分之三十一")).toEqual([31]);
    expect(values("四十九点八万")).toEqual([498000]);
  });
  it("不把普通词当数字", () => {
    expect(values("一下就好,统一一直这样,万一出事千万别,十分重要")).toEqual([]);
  });
  it("字母后面的数字是编号,跳过", () => {
    expect(values("Q3 的 LT2609-0387")).toEqual([]);
  });
});
