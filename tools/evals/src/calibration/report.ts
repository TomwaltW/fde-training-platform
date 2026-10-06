// 把标定结果排成终端里的两张表(稳定性、一致性)和总结论。返回行数组,CLI 打印,测试直接断言。
import type { LoadedScenario } from "@fde/engine";
import { AGREEMENT_MIN, MAX_BAND_GAP, STABILITY_MAX_SPREAD, fmt, type AgreementCell } from "./metrics.ts";
import type { CalibrationResult, CaseResult } from "./run.ts";
import { checkItemCatalog } from "./scoring.ts";

// ---------------------------------------------------------------- 表格(中文按两格宽对齐)

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6);

export const displayWidth = (s: string) => [...s].reduce((w, ch) => w + (isWide(ch.codePointAt(0)!) ? 2 : 1), 0);
const padEnd = (s: string, w: number) => s + " ".repeat(Math.max(0, w - displayWidth(s)));

export function renderTable(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))));
  const line = (cells: string[]) => cells.map((c, i) => padEnd(c, widths[i]!)).join("  ").trimEnd();
  return [line(head), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)];
}

const pct = (r: number) => `${(Math.round(r * 1000) / 10).toFixed(1)}%`;
const short = (s: string, n = 28) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// ---------------------------------------------------------------- 稳定性

function stabilityRow(c: CaseResult): string[] {
  if (c.error || !c.stability) return [c.id, "—", "—", "", "✗ 出错"];
  const s = c.stability;
  return [
    c.id,
    s.totals.map(fmt).join(" / "),
    fmt(s.spread),
    s.changedDims.map((d) => d.id).join(" ") || "无",
    s.ok ? "✓ 通过" : "✗ 不过",
  ];
}

function stabilitySection(res: CalibrationResult, scn: LoadedScenario, verbose: boolean): string[] {
  const out = [
    `一、裁判稳定性:同一对话跑 ${res.runs} 次,总分极差 ≤ ${STABILITY_MAX_SPREAD}(±${STABILITY_MAX_SPREAD / 2})为通过`,
    "",
    ...renderTable(["用例", "各次总分", "极差", "在变的维度", "结果"], res.cases.map(stabilityRow)),
    "",
    `通过 ${res.stability.passed}/${res.stability.total}`,
  ];
  const catalog = checkItemCatalog(scn);
  const dimName = new Map(res.dims.map((d) => [d.id, d.name]));
  for (const c of res.cases) {
    if (c.error) {
      out.push("", `✗ ${c.id} 出错:`, ...c.error.split("\n").map((l) => `    ${l}`));
      continue;
    }
    const s = c.stability!;
    const downgraded = c.runs.map((r, i) => ({ i, issues: r.issues })).filter((x) => x.issues.length);
    const showDetail = !s.ok || (verbose && (s.changedDims.length > 0 || s.changedItems.length > 0 || downgraded.length > 0));
    if (!showDetail) continue;
    out.push("", `${s.ok ? "·" : "✗"} ${c.id}  总分 ${s.totals.map(fmt).join(" / ")}${s.reason ? `:${s.reason}` : ""}`);
    if (s.changedDims.length) {
      out.push(`    在变的维度:${s.changedDims.map((d) => `${d.id} ${dimName.get(d.id) ?? ""} ${d.values.map(fmt).join(" / ")}`).join(";")}`);
    }
    for (const it of s.changedItems) {
      const info = catalog.get(it.id);
      out.push(`    在变的检查项 ${it.id}${info ? `(影响 ${info.dims.join("、")}:${short(info.text)})` : ""}:${it.values.join(" / ")}`);
    }
    // 检查项的判定是引擎校验之后的:有的变化来自裁判引用了不存在的编号、A 级没有资料支持而被降级
    if (verbose) for (const d of downgraded) out.push(`    第 ${d.i + 1} 次的校验问题:${d.issues.join(";")}`);
    if (!s.ok && s.changedItems.length) {
      out.push(`    → 这些检查项写得含糊:把对应检查项改成更具体的是非题(方案 3.4.2 第 6 条),改完重跑`);
      if (downgraded.length && !verbose) out.push(`      其中 ${downgraded.length} 次有判定被程序校验降级(引用编号不存在等),加 -v 看`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 一致性

function cell(c: AgreementCell | undefined): string {
  if (!c) return "—";
  return `${fmt(c.human)}|${fmt(c.judge)}${c.ok ? "" : " ✗"}`;
}

function agreementSection(res: CalibrationResult, scn: LoadedScenario, verbose: boolean): string[] {
  const a = res.agreement;
  const dims = res.dims;
  const compared = [...new Set(a.cells.map((c) => c.caseId))];
  const rows = compared.map((id) => {
    const mine = a.cells.filter((c) => c.caseId === id);
    return [id, ...dims.map((d) => cell(mine.find((c) => c.dim === d.id))), `${mine.filter((c) => c.ok).length}/${mine.length}`];
  });
  rows.push(["各维度一致", ...a.byDim.map((d) => `${d.agreed}/${d.total}`), `${a.agreed}/${a.total}`]);
  const out = [
    `二、与人工标注的一致性:各维度满分等分 5 档,相差不超过 ${MAX_BAND_GAP} 档算一致;所有用例 × 维度一致的比例 ≥ ${pct(AGREEMENT_MIN)} 为通过`,
    `    单元格 = 人工分|裁判分(裁判分取 ${res.runs} 次运行的中位数),✗ = 相差超过 ${MAX_BAND_GAP} 档`,
    "",
    ...renderTable(["用例", ...dims.map((d) => `${d.id}(${d.max})`), "一致"], rows),
    "",
    a.total ? `一致 ${a.agreed}/${a.total} = ${pct(a.ratio)}` : "没有可比较的用例(人工标注都还没填完,或用例都出错了)",
  ];
  for (const s of a.skipped) out.push(`  跳过 ${s.id}:${s.reason}`);

  // 差异明细:没过时按维度列出差异最大的用例;过了也列出超过 1 档的,方便逐条看
  const name = new Map(dims.map((d) => [d.id, d.name]));
  const caseById = new Map(res.cases.map((c) => [c.id, c]));
  // 每个检查项只挂在它的主维度下(T→D4、S→D5、W→D7)
  const catalog = [...checkItemCatalog(scn)];
  const list = a.byDim
    .map((d) => ({ ...d, show: d.worst.filter((c) => !a.ok || !c.ok || verbose) }))
    .filter((d) => d.show.length)
    .sort((x, y) => x.agreed / x.total - y.agreed / y.total);
  if (list.length) {
    out.push("", a.ok ? "差异明细:" : "差异最大的用例(按维度;逐条看是规则问题还是抽取问题):");
    for (const d of list) {
      out.push(`  ${d.dim} ${name.get(d.dim) ?? ""}:一致 ${d.agreed}/${d.total}`);
      for (const c of d.show) {
        const cr = caseById.get(c.caseId);
        const reason = cr?.human?.status === "ok" ? cr.human.human.dims[c.dim]?.reason : undefined;
        const run = cr?.runs[cr.judgeRun?.[c.dim] ?? 0];
        const details = run?.details[c.dim] ?? [];
        const items = catalog.filter(([, info]) => info.dims[0] === c.dim).map(([id]) => `${id} ${run?.items[id] ?? "(缺)"}`);
        out.push(
          `    ${c.ok ? "·" : "✗"} ${c.caseId}  人工 ${fmt(c.human)}(第 ${c.humanBand} 档)vs 裁判 ${fmt(c.judge)}(第 ${c.judgeBand} 档),差 ${c.gap} 档`,
        );
        if (reason) out.push(`        人工理由:${reason}`);
        out.push(`        算分依据:${details.join(";") || "无"}`);
        if (items.length) out.push(`        裁判判定:${items.join("、")}`);
      }
    }
    if (!a.ok) {
      out.push(
        "",
        "  → 规则问题(人工和算分依据对不上,但裁判抽取的证据没错):改 scenario.yaml 的 rubric;",
        "    抽取问题(裁判判错了命中/是非):改裁判提示词或把检查项写得更具体。改完重跑。",
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- 总结论

export function renderReport(res: CalibrationResult, scn: LoadedScenario, opts: { verbose?: boolean } = {}): string[] {
  const verbose = opts.verbose ?? false;
  const out = [
    `标定:场景 ${res.scenario} · 模式 ${res.mode} · 每个用例跑 ${res.runs} 次 · 用例 ${res.cases.length} 份`,
    ...res.warnings.map((w) => `  ! ${w}`),
    ...res.cases.flatMap((c) => c.warnings.map((w) => `  ! ${c.id}:${w}`)),
    "",
    ...stabilitySection(res, scn, verbose),
    "",
    ...agreementSection(res, scn, verbose),
    "",
  ];
  const errors = res.cases.filter((c) => c.error).length;
  const st = res.stability;
  const ag = res.agreement;
  out.push(
    `结论:稳定性 ${st.ok ? "✓" : "✗"} ${st.passed}/${st.total} · 一致性 ${ag.ok ? "✓" : "✗"} ${ag.total ? `${pct(ag.ratio)}(${ag.agreed}/${ag.total},门槛 ${pct(AGREEMENT_MIN)})` : "无数据"}` +
      `${errors ? ` · ${errors} 个用例出错` : ""} → ${res.ok ? "达标" : "不达标"}`,
  );
  return out;
}
