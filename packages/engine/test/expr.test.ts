import { describe, expect, it } from "vitest";
import { evalExpr, evalRequirement, isExpression, type Resolver } from "../src/expr.ts";

const r = (vars: Record<string, number | boolean | string>): Resolver => ({
  get: (n) => vars[n],
  call: (fn, args) => (fn === "only_talked_to" ? args.includes("zhou") : undefined),
});

describe("expr", () => {
  it("比较、逻辑、字面量", () => {
    const res = r({ phase: "kickoff", "exchanges.zhou": 2, auth_finance: false });
    expect(evalExpr("phase==kickoff and exchanges.zhou>=2", res)).toBe(true);
    expect(evalExpr("phase==report", res)).toBe(false);
    expect(evalExpr("not auth_finance", res)).toBe(true);
    expect(evalExpr("only_talked_to(zhou)", res)).toBe(true);
  });
  it("自然语言条件不是表达式(交给闸门)", () => {
    expect(isExpression("用户向周总问操作细节")).toBe(false);
    expect(isExpression("trust.chen>=1")).toBe(true);
  });
  it("未知标识符报错,而不是悄悄当成 false", () => {
    expect(() => evalExpr("auth_typo", r({}))).toThrow(/未知标识符/);
  });
  it("Requirement:数组=全部满足,any=任一满足", () => {
    const res = r({ "trust.liu": 0, auth_ops: true });
    expect(evalRequirement({ any: ["trust.liu>=1", "auth_ops"] }, res)).toBe(true);
    expect(evalRequirement(["trust.liu>=1", "auth_ops"], res)).toBe(false);
  });
});
