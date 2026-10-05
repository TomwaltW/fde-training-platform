// 标定用例的存放格式(方案 3.4.4 第 5 步):
//   scenarios/<场景>/evals/calibration/<caseId>/
//     session.json         引擎的 SessionState(命令行 .sessions/*.json,或网页导出的 { state: … })
//     human.yaml           人工逐维度打分与理由(见 human.ts)
//     judge-fixtures/*.json  可选;mock 模式下按文件名顺序作为"裁判的第 i 次输出"
//     transcript.md        可选;--init 生成的可读对话,方便标注,不参与计算
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  eventLogForJudge,
  judgmentForJudge,
  transcriptForJudge,
  type LoadedScenario,
  type SessionState,
} from "@fde/engine";
import { CalibrationInputError, dimSpecs, parseHuman, renderHumanTemplate, type HumanParse } from "./human.ts";

export const SESSION_FILE = "session.json";
export const HUMAN_FILE = "human.yaml";
export const FIXTURE_DIR = "judge-fixtures";
export const TRANSCRIPT_FILE = "transcript.md";

/** 用例 id 就是目录名:字母或数字开头,只含字母、数字、-、_(防止 --id 写出目录穿越)。 */
export const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface JudgeFixture {
  file: string;
  raw: unknown;
}

export interface CalibrationCase {
  id: string;
  dir: string;
  state: SessionState;
  human: HumanParse;
  fixtures: JudgeFixture[];
  /** 不致命的提醒(对局还没收工等)。 */
  warnings: string[];
}

// 只校验标定真正用到的骨架;其余字段原样保留,由引擎自己读
const SessionShape = z.looseObject({
  version: z.literal(1),
  sessionId: z.string(),
  scenarioId: z.string(),
  phase: z.string(),
  transcript: z.array(z.looseObject({ ref: z.string(), speaker: z.enum(["user", "npc", "system"]), text: z.string() })),
  turns: z.array(z.unknown()),
  events: z.array(z.unknown()),
  ledger: z.array(z.unknown()),
  facts: z.record(z.string(), z.unknown()),
  artifacts: z.record(z.string(), z.unknown()),
  experiments: z.record(z.string(), z.unknown()),
});

/** 读一份对局:接受 SessionState 本身,也接受外面包了一层 { state } 的(网页 / 数据库导出的 StoredSession)。 */
export function parseSession(raw: unknown, scn: LoadedScenario, file: string): SessionState {
  const inner =
    raw && typeof raw === "object" && !("transcript" in raw) && "state" in raw ? (raw as { state: unknown }).state : raw;
  const r = SessionShape.safeParse(inner);
  if (!r.success) {
    throw new CalibrationInputError(file, [
      "不是引擎的 SessionState(命令行 .sessions/*.json,或带 state 字段的网页导出)",
      ...r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`),
    ]);
  }
  if (r.data.scenarioId !== scn.data.meta.id) {
    throw new CalibrationInputError(file, [`这份对局属于场景 ${r.data.scenarioId},不是 ${scn.data.meta.id}`]);
  }
  return inner as SessionState;
}

export function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new CalibrationInputError(file, [`读不到文件:${(e as Error).message}`]);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CalibrationInputError(file, [`不是合法的 JSON:${(e as Error).message}`]);
  }
}

export function loadSessionFile(file: string, scn: LoadedScenario): SessionState {
  return parseSession(readJson(file), scn, file);
}

/** 标定集目录下的所有用例 id(按名字排序;没有目录时返回空)。 */
export function listCaseIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** judge-fixtures/*.json,按文件名的自然顺序(2.json 在 10.json 前面)。 */
export function loadFixtures(caseDir: string): JudgeFixture[] {
  const dir = join(caseDir, FIXTURE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((n) => ({ file: join(dir, n), raw: readJson(join(dir, n)) }));
}

/** 读一个用例目录。文件缺失或不合法抛 CalibrationInputError(带文件路径)。 */
export function loadCase(caseDir: string, id: string, scn: LoadedScenario): CalibrationCase {
  const sessionFile = join(caseDir, SESSION_FILE);
  const humanFile = join(caseDir, HUMAN_FILE);
  if (!existsSync(sessionFile)) throw new CalibrationInputError(sessionFile, ["缺少 session.json"]);
  if (!existsSync(humanFile)) throw new CalibrationInputError(humanFile, ["缺少 human.yaml(可以用 --init 生成模板)"]);
  const state = loadSessionFile(sessionFile, scn);
  const human = parseHuman(readFileSync(humanFile, "utf8"), dimSpecs(scn), humanFile);
  const warnings: string[] = [];
  if (state.phase !== "debrief") warnings.push(`对局还没收工(阶段 ${state.phase}),按当前状态算分`);
  return { id, dir: caseDir, state, human, fixtures: loadFixtures(caseDir), warnings };
}

/** 给标注人看的可读对话:和裁判看到的是同一份材料(事件日志、带编号的对话、判断)。 */
export function renderTranscript(scn: LoadedScenario, st: SessionState, caseId: string): string {
  return [
    `# 标定用例 ${caseId}`,
    "",
    `> 由 \`pnpm calibrate --init\` 从 session.json 生成,只是方便阅读,不参与计算。`,
    `> 场景 ${scn.data.meta.id} · 用户发言 ${st.transcript.filter((l) => l.speaker === "user").length} 次 · 用了 ${st.minutesUsed} 分钟`,
    "",
    "## 事件日志",
    "",
    "```",
    eventLogForJudge(scn, st),
    "```",
    "",
    "## 对话",
    "",
    "```",
    transcriptForJudge(scn, st),
    "```",
    "",
    "## 用户的判断",
    "",
    "```",
    judgmentForJudge(scn, st),
    "```",
    "",
  ].join("\n");
}

/**
 * --init:从一份对局建用例目录,写 session.json、待填的 human.yaml 和 transcript.md。已存在则拒绝覆盖。
 * 对局来自文件(sessionFile),或者直接给内存里的状态(state,--init-player 用)。
 */
export function initCase(
  opts: { scn: LoadedScenario; calibrationDir: string; caseId: string; today?: string } & (
    | { sessionFile: string }
    | { state: SessionState }
  ),
): { dir: string; files: string[] } {
  const { scn, calibrationDir, caseId } = opts;
  if (!CASE_ID.test(caseId)) {
    throw new CalibrationInputError("--id", [`用例 id「${caseId}」不合法:字母或数字开头,只能含字母、数字、-、_,最长 64 个字符`]);
  }
  const state = "state" in opts ? parseSession(opts.state, scn, "(内存中的对局)") : loadSessionFile(opts.sessionFile, scn);
  const dir = join(calibrationDir, caseId);
  if (existsSync(dir)) throw new CalibrationInputError(dir, ["用例目录已存在;换一个 --id,或先手动删掉旧目录"]);
  mkdirSync(dir, { recursive: true });
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const files = [join(dir, SESSION_FILE), join(dir, HUMAN_FILE), join(dir, TRANSCRIPT_FILE)];
  writeFileSync(files[0]!, `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(files[1]!, renderHumanTemplate(scn, state, caseId, today));
  writeFileSync(files[2]!, renderTranscript(scn, state, caseId));
  return { dir, files };
}
