// 人工标注 human.yaml(方案 3.4.4 第 2 步):作者不看裁判结果,先逐维度打分并写理由。
// 手写的文件,用 zod 严格校验:拼错的键、超出满分的分数、有分没理由都直接报错。
// score 写 null 表示还没填(--init 生成的模板就是这样),这份用例暂不参加一致性统计。
import { parse } from "yaml";
import { z } from "zod";
import type { LoadedScenario, SessionState } from "@fde/engine";
import { BAND_COUNT, bandRange, fmt } from "./metrics.ts";

export interface DimSpec {
  id: string;
  name: string;
  max: number;
}

export const dimSpecs = (scn: LoadedScenario): DimSpec[] =>
  scn.data.rubric.dimensions.map((d) => ({ id: d.id, name: d.name, max: d.max }));

export interface HumanAnnotation {
  annotator: string;
  date: string;
  note?: string;
  dims: Record<string, { score: number; reason: string }>;
}

export type HumanParse =
  | { status: "ok"; human: HumanAnnotation }
  /** 模板还没填完:pending 列出还空着的字段(annotator、D1…)。 */
  | { status: "draft"; pending: string[] };

/** 文件内容不合法(结构、分数越界、有分没理由)。 */
export class CalibrationInputError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`${file}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CalibrationInputError";
  }
}

// YAML 里没加引号的日期可能被解析成 Date,统一转回 YYYY-MM-DD
const DateStr = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.string({ error: "日期必填,格式 YYYY-MM-DD" }).regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD"),
);

function dimEntry(d: DimSpec) {
  return z
    .strictObject(
      {
        score: z
          .number({ error: "分数必须是数字(还没打分就写 null)" })
          .min(0, "分数不能小于 0")
          .max(d.max, `${d.id} ${d.name}的满分是 ${d.max},分数不能超过它`)
          .nullable(),
        reason: z.string({ error: "理由必须是文字" }).default(""),
      },
      { error: (iss) => (iss.input === undefined ? "缺少这个维度" : "应写成 {score, reason}") },
    )
    .superRefine((v, ctx) => {
      if (v.score !== null && !v.reason.trim()) ctx.addIssue({ code: "custom", message: "打了分就要写理由", path: ["reason"] });
    });
}

export function humanSchema(dims: DimSpec[]) {
  const ids = dims.map((d) => d.id).join(" ");
  return z.strictObject(
    {
      annotator: z.string({ error: "annotator 必填(标注人;模板里还没填就留空字符串)" }),
      date: DateStr,
      note: z.string().optional(),
      dims: z.strictObject(Object.fromEntries(dims.map((d) => [d.id, dimEntry(d)])), {
        error: `dims 应该按维度写:${ids} 各一项`,
      }),
    },
    { error: "human.yaml 应该是一个对象(annotator、date、dims)" },
  );
}

/** 解析并校验 human.yaml 的内容。不合法抛 CalibrationInputError;没填完返回 draft。 */
export function parseHuman(text: string, dims: DimSpec[], file = "human.yaml"): HumanParse {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new CalibrationInputError(file, [`不是合法的 YAML:${(e as Error).message.split("\n")[0]}`]);
  }
  const r = humanSchema(dims).safeParse(raw);
  if (!r.success) {
    throw new CalibrationInputError(
      file,
      r.error.issues.map((i) => {
        const at = i.path.join(".") || "(根)";
        // 严格模式下多出来的键:点名是哪个,并提示合法的维度
        if (i.code === "unrecognized_keys") {
          const hint = at === "dims" ? `(只认 ${dims.map((d) => d.id).join(" ")})` : "";
          return `${at}: 不认识的字段 ${i.keys.join("、")}${hint}`;
        }
        return `${at}: ${i.message}`;
      }),
    );
  }
  const v = r.data;
  const entries = dims.map((d) => [d.id, (v.dims as Record<string, { score: number | null; reason: string }>)[d.id]!] as const);
  const pending = [
    ...(v.annotator.trim() ? [] : ["annotator"]),
    ...entries.filter(([, e]) => e.score === null).map(([id]) => id),
  ];
  if (pending.length) return { status: "draft", pending };
  return {
    status: "ok",
    human: {
      annotator: v.annotator.trim(),
      date: v.date,
      ...(v.note !== undefined && { note: v.note }),
      dims: Object.fromEntries(entries.map(([id, e]) => [id, { score: e.score!, reason: e.reason.trim() }])),
    },
  };
}

// ---------------------------------------------------------------- 模板

/** --init 生成的待填模板。所有分数是 null;能被 parseHuman 读回(状态为 draft)。 */
export function renderHumanTemplate(scn: LoadedScenario, st: SessionState, caseId: string, today: string): string {
  const dims = dimSpecs(scn);
  const users = st.transcript.filter((l) => l.speaker === "user").length;
  const opened = Object.entries(st.artifacts)
    .filter(([, a]) => a.openedTurn !== undefined)
    .map(([id]) => id);
  const lines = [
    `# 标定用例 ${caseId} 的人工标注(方案 3.4.4 第 2 步)。`,
    `# 先别看裁判结果:读完同目录的 transcript.md(或 session.json),逐维度打分并写一句理由。`,
    `# 分数可以带一位小数,不能超过该维度满分。每个维度的满分等分成 ${BAND_COUNT} 档,`,
    `# 与裁判相差不超过 1 档算一致。把 score 的 null 换成分数、reason 写理由、annotator 写你的名字。`,
    `#`,
    `# 对局概况:用户发言 ${users} 次 · 用了 ${st.minutesUsed} 分钟 · 阶段 ${st.phase}` +
      `${st.endedReason ? `(${st.endedReason})` : ""} · ${st.judgment ? "提交了判断" : "没提交判断"}` +
      ` · 打开过资料 ${opened.join("、") || "无"}`,
    `annotator: ""`,
    `date: "${today}"`,
    `# note: 可选,整体印象`,
    `dims:`,
  ];
  for (const d of dims) {
    const bands = Array.from({ length: BAND_COUNT }, (_, b) => bandRange(d.max, b).map(fmt).join("–")).join(" / ");
    lines.push(`  # ${d.name},满分 ${d.max}。档位 0–${BAND_COUNT - 1}:${bands}`);
    lines.push(`  ${d.id}:`, `    score: null`, `    reason: ""`);
  }
  return `${lines.join("\n")}\n`;
}
