import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseScenario, ScenarioLoadError, validateScenario } from "../src/index.ts";
import { SCN_DIR, scn } from "./helpers.ts";

const raw = () => parse(readFileSync(join(SCN_DIR, "scenario.yaml"), "utf8"));

describe("scenario schema", () => {
  it("场景一通过结构校验和语义校验", () => {
    const r = validateScenario(scn);
    expect(r.errors).toEqual([]);
  });

  it("花括号里没加引号的逗号会被截成两段——严格模式必须报错(方案 3.5.1)", () => {
    const yaml = `{role: liu, level: L1, ask: 问主要错在哪, say: 一多半是客户资料乱, 老改单}`;
    const rule = parse(yaml);
    expect(Object.keys(rule)).toContain("老改单"); // YAML 本身不报错,悄悄多出一个键
    const data = raw();
    data.facts[0].unlock.push(rule);
    expect(() => parseScenario(data, SCN_DIR)).toThrow(ScenarioLoadError);
  });

  it("引用了不存在的角色会被校验器抓到", () => {
    const data = raw();
    data.traps[0].by = "nobody";
    const r = validateScenario(parseScenario(data, SCN_DIR));
    expect(r.errors.some((e) => e.includes("nobody"))).toBe(true);
  });

  it("合计数不自洽会被校验器抓到", () => {
    const data = raw();
    data.truth.error_categories[0].count += 1;
    const r = validateScenario(parseScenario(data, SCN_DIR));
    expect(r.errors.some((e) => e.includes("异常件数合计"))).toBe(true);
  });

  it("参考路径超过预算 90% 会报错", () => {
    const data = raw();
    data.budget.expert_path_minutes = 340;
    const r = validateScenario(parseScenario(data, SCN_DIR));
    expect(r.errors.some((e) => e.includes("参考路径"))).toBe(true);
  });
});
