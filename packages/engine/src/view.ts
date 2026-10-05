// 给浏览器看的视图。网页只能拿到这里的东西:真相、事实图谱、信任值、授权、压力时刻、导演指令、
// 守卫标记、承诺账本,一律不出现在这里(复盘里的真相通过 PublicReport 在收工后给出)。
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { AI_NOTICE } from "./debrief.ts";
import { evalRequirement } from "./expr.ts";
import type { SessionReport } from "./engine.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import { minutesLeft, stateResolver } from "./state.ts";
import type { Phase, SessionState, TurnResult } from "./types.ts";

export const AI_DIALOGUE_NOTICE = "对话内容由 AI 生成";

export interface PublicView {
  sessionId: string;
  scenario: { id: string; title: string; disclaimer: string };
  briefing: { youAre: string; company: string; goal: string; rulesShown: string[] };
  phase: Phase;
  minutesLeft: number;
  minutesTotal: number;
  currentRole: string;
  /** 只有已经出现的人(人物迷雾)。 */
  people: { id: string; name: string; title: string; current: boolean; exchanges: number }[];
  /** 只有已经拿到的资料。 */
  artifacts: { id: string; title: string; opened: boolean; reviewCostMin: number }[];
  /** 按钮动作(去现场)。available = 现在点了会成功。 */
  actions: { id: string; title: string; costMin: number; available: boolean; done: boolean }[];
  /** 只列出前提已满足或已经做过的验证;标题里有资料名,提前列出来等于剧透。 */
  experiments: { id: string; title: string; costMin: number; done: boolean }[];
  lockedExperiments: number;
  transcript: { ref: string; turn: number; speaker: "user" | "npc" | "system"; roleId?: string; roleName?: string; text: string }[];
  judgmentForm: { id: string; label: string }[];
  judgmentSubmitted: boolean;
  ended: boolean;
  aiNotice: string;
}

export interface PublicTurnResult {
  reply?: { roleId: string; roleName: string; text: string; ref: string };
  system: string[];
  unlockedArtifacts: { id: string; title: string }[];
  discovered: { id: string; name: string; title: string }[];
  /** 只有按钮动作有:是否成功。 */
  ok?: boolean;
}

export type ArtifactFileKind = "image" | "pdf" | "xlsx" | "other";

export interface ArtifactFile {
  /** 文件名(不含目录),下载接口用它定位。 */
  name: string;
  /** 绝对路径,只在服务端用,不要发给浏览器。 */
  path: string;
  kind: ArtifactFileKind;
  bytes: number;
}

export interface PublicArtifact {
  id: string;
  title: string;
  opened: boolean;
  files: { name: string; kind: ArtifactFileKind; bytes: number }[];
}

export interface PublicReport {
  sessionId: string;
  scenarioTitle: string;
  total: number;
  band: string;
  badges: string[];
  dimensions: { id: string; name: string; score: number; max: number; details: string[] }[];
  caps: string[];
  /** 复盘全文(含真相)。收工后才给。 */
  markdown: string;
  /** 分享卡:不含任何真相。 */
  shareCard: { title: string; total: number; badges: string[]; line: string };
  aiNotice: string;
}

export function publicView(scn: LoadedScenario, st: SessionState): PublicView {
  const d = scn.data;
  const resolver = stateResolver(st, scn);
  const discovering = st.phase === "kickoff" || st.phase === "discovery";
  const can = (req: Parameters<typeof evalRequirement>[0]) => {
    try {
      return evalRequirement(req, resolver);
    } catch {
      return false;
    }
  };
  const experiments = d.experiments.filter((x) => st.experiments[x.id] || can(x.requires));
  return {
    sessionId: st.sessionId,
    scenario: { id: d.meta.id, title: d.meta.title, disclaimer: d.meta.disclaimer },
    briefing: { youAre: d.briefing.you_are, company: d.briefing.company, goal: d.briefing.goal, rulesShown: d.briefing.rules_shown },
    phase: st.phase,
    minutesLeft: Math.max(0, minutesLeft(st, scn)),
    minutesTotal: d.budget.discovery_minutes,
    currentRole: st.currentRole,
    people: st.discovered.map((id) => {
      const r = scn.role(id);
      return { id, name: r.name, title: r.title, current: id === st.currentRole, exchanges: st.exchanges[id] ?? 0 };
    }),
    artifacts: Object.entries(st.artifacts).map(([id, a]) => {
      const art = scn.artifact(id);
      return { id, title: art.title, opened: a.openedTurn !== undefined, reviewCostMin: art.review_cost_min };
    }),
    actions: Object.entries(d.actions).map(([id, a]) => ({
      id,
      title: a.title,
      costMin: a.cost_min,
      done: Boolean(st.actionsDone[id]),
      available: discovering && !st.actionsDone[id] && can(a.requires),
    })),
    experiments: experiments.map((x) => ({ id: x.id, title: x.title, costMin: d.budget.experiment_min, done: Boolean(st.experiments[x.id]) })),
    lockedExperiments: d.experiments.length - experiments.length,
    transcript: st.transcript.map((l) => ({
      ref: l.ref,
      turn: l.turn,
      speaker: l.speaker,
      ...(l.roleId && { roleId: l.roleId, roleName: scn.roles.get(l.roleId)?.name ?? l.roleId }),
      text: l.text,
    })),
    judgmentForm: d.judgment_form.map((f) => ({ id: f.id, label: f.label })),
    judgmentSubmitted: st.judgment !== undefined,
    ended: st.phase === "debrief",
    aiNotice: AI_DIALOGUE_NOTICE,
  };
}

export function publicTurnResult(scn: LoadedScenario, r: TurnResult): PublicTurnResult {
  const out: PublicTurnResult = {
    system: r.system,
    unlockedArtifacts: r.unlockedArtifacts.map((id) => ({ id, title: scn.artifacts.get(id)?.title ?? id })),
    discovered: r.discovered.map((id) => ({ id, name: scn.roles.get(id)?.name ?? id, title: scn.roles.get(id)?.title ?? "" })),
  };
  if (r.reply) out.reply = { ...r.reply, roleName: scn.roles.get(r.reply.roleId)?.name ?? r.reply.roleId };
  if (r.ok !== undefined) out.ok = r.ok;
  return out;
}

export function publicReport(scn: LoadedScenario, sessionId: string, r: SessionReport): PublicReport {
  return {
    sessionId,
    scenarioTitle: scn.data.meta.title,
    total: r.score.total,
    band: r.score.band,
    badges: r.score.badges,
    dimensions: r.score.dimensions.map((d) => ({ id: d.id, name: d.name, score: d.score, max: d.max, details: d.details })),
    caps: r.score.caps.map((c) => c.label),
    markdown: r.markdown,
    shareCard: { title: scn.data.meta.title, ...r.debrief.shareCard },
    aiNotice: AI_NOTICE,
  };
}

const KIND: Record<string, ArtifactFileKind> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".pdf": "pdf",
  ".xlsx": "xlsx",
};

/**
 * 一份资料对应的文件。按 scenario.yaml 里 artifacts[].files 解析:
 * 精确路径("artifacts/A3/cheatsheet.png")或目录通配("artifacts/A1/*")。
 * 只返回实际存在的普通文件,按文件名排序;以 "." 开头的文件不算。
 */
export function artifactFiles(scn: LoadedScenario, artifactId: string): ArtifactFile[] {
  const art = scn.artifacts.get(artifactId);
  if (!art) return [];
  const pattern = art.files;
  const toFile = (p: string): ArtifactFile => ({
    name: basename(p),
    path: p,
    kind: KIND[extname(p).toLowerCase()] ?? "other",
    bytes: statSync(p).size,
  });
  if (pattern.endsWith("/*")) {
    const dir = join(scn.dir, dirname(pattern));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile())
      .sort()
      .map(toFile);
  }
  const p = join(scn.dir, pattern);
  return existsSync(p) && statSync(p).isFile() ? [toFile(p)] : [];
}

export function publicArtifact(scn: LoadedScenario, st: SessionState, artifactId: string): PublicArtifact | undefined {
  const rec = st.artifacts[artifactId];
  const art = scn.artifacts.get(artifactId);
  if (!rec || !art) return undefined;
  return {
    id: artifactId,
    title: art.title,
    opened: rec.openedTurn !== undefined,
    files: artifactFiles(scn, artifactId).map(({ name, kind, bytes }) => ({ name, kind, bytes })),
  };
}
