// 第一关发布前自查脚本(docs/gate1/01-首条内容.md 第 7 节)的回归测试。
// 脚本从文档里现取(文档就是脚本的唯一来源),用 python3 跑没装 PyYAML 时的正则路径:
// - canaries 写成块状列表、列表中间夹着空行或注释行时,也要把金丝雀词读全(以前读到一半就停,还照常退出 0);
// - 千分位只认半角逗号:全角逗号(79，100)是两个数,不能先被 NFKC 变成半角再合并成 79100。
// 测试里不抄任何金丝雀词和隐藏数字,要用的都从 scenario.yaml 现取。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const SCENARIO = "scenarios/freight-docs/scenario.yaml";

/** 文档第 7 节那段 bash 里 `<<'EOF'` 和 `EOF` 之间的 Python 脚本。 */
function selfcheckScript(): string {
  const blocks = [...read("docs/gate1/01-首条内容.md").matchAll(/<<'EOF'\n([\s\S]*?)\nEOF\n/g)];
  expect(blocks).toHaveLength(1);
  return blocks[0]![1]!;
}

/** scenario.yaml 里所有 canaries 的词(用 yaml 包解析,和脚本的正则路径互相独立)。 */
function canariesOf(text: string): string[] {
  const out: string[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (k === "canaries") out.push(...(Array.isArray(v) ? v : [v]).map(String));
        walk(v);
      }
    }
  };
  walk(parse(text));
  return out;
}

/** 把每个 `canaries: [a, b]` 改写成块状列表,每一项后面跟一个空行和一个注释行。 */
function toBlockWithGaps(text: string): { text: string; keys: number } {
  let keys = 0;
  const out = text.replace(/^([ \t]*)canaries:[ \t]*\[(.*)\][ \t]*$/gm, (_m, ind: string, items: string) => {
    keys += 1;
    const lines = items.split(",").map((x) => x.trim()).flatMap((x) => [`${ind}  - ${x}`, "", `${ind}  # 注`]);
    return [`${ind}canaries:`, ...lines].join("\n");
  });
  return { text: out, keys };
}

const hasPython = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasPython)("第一关自查脚本(正则路径,没装 PyYAML)", () => {
  let dir = "";
  const scenario = read(SCENARIO);
  const canaries = canariesOf(scenario);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fde-gate1-selfcheck-"));
    writeFileSync(join(dir, "selfcheck.py"), selfcheckScript());
    // 和脚本放在同一目录:sys.path[0] 就是这里,import yaml 先拿到这个桩,强制走正则路径
    writeFileSync(join(dir, "yaml.py"), "raise ImportError('测试里强制走正则路径')\n");
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** 跑一次脚本,返回退出码和五行输出。 */
  function run(draft: string, yamlText = scenario) {
    const draftPath = join(dir, "草稿.txt");
    const yamlPath = join(dir, "scenario.yaml");
    writeFileSync(draftPath, draft);
    writeFileSync(yamlPath, yamlText);
    const r = spawnSync("python3", [join(dir, "selfcheck.py"), draftPath, yamlPath], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: dir },
    });
    const lines = r.stdout.split("\n");
    const line = (n: string) => lines.find((l) => l.startsWith(`${n} `)) ?? "";
    /** 第 1–3 行冒号后面列表里的各项('79' 之类)。 */
    const items = (n: string) => [...line(n).slice(line(n).indexOf("):") + 2).matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    return { status: r.status, stderr: r.stderr, head: lines[0] ?? "", items, line };
  }

  it("canaries 是块状列表、列表中间有空行和注释行时,金丝雀词照样读全", () => {
    expect(canaries.length).toBeGreaterThan(0);
    const variant = toBlockWithGaps(scenario);
    expect(variant.keys).toBe((scenario.match(/(?<![\w-])canaries\s*:/g) ?? []).length);
    expect(canariesOf(variant.text)).toEqual(canaries); // 改写后的 YAML 语义不变

    const r = run(canaries.join("\n"), variant.text);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.head).toContain("正则");
    expect(r.head).toContain(`金丝雀词 ${canaries.length} 个`);
    expect(r.items("1")).toEqual(canaries);
  });

  it("全角逗号隔开的两个数不当千分位合并", () => {
    const r = run("我这局拿了 79，100 分满分\n");
    expect(r.status).toBe(0);
    expect(r.head).toContain("正则");
    const nums = [...r.items("2"), ...r.items("3")].sort();
    expect(nums).toEqual(["100", "79"]);
  });

  it("半角千分位逗号照样合并(全角数字也一样),18000 按公开数字放行", () => {
    const r = run("一共 18,000,写成全角是 １８,０００\n");
    expect(r.status).toBe(0);
    expect(r.items("2")).toEqual([]);
    expect(r.items("3")).toEqual([]);
    expect(r.line("2")).toContain("未命中");
    expect(r.line("3")).toContain("无");
  });
});
