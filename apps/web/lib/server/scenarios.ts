// 场景与引擎:启动后第一次用到时加载 <FDE_ROOT>/scenarios/*/scenario.yaml,每个场景一个 Engine,进程内复用。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioSummary, StoredLlmCall } from "@fde/contracts";
import {
  Engine,
  FixtureJudge,
  HeuristicGate,
  LlmActor,
  LlmDebrief,
  LlmGate,
  LlmJudge,
  Moderation,
  TemplateActor,
  TemplateDebrief,
  emptyJudge,
  loadScenario,
  type ChatFn,
  type EngineDeps,
  type LoadedScenario,
} from "@fde/engine";
import { createGateway, loadModelsConfig, type LlmCallLog } from "@fde/llm";
import { engineMode, fdeRoot } from "./env.ts";
import { runtime, type ScenarioEntry } from "./runtime.ts";
import { getStore } from "./store.ts";

export type { ScenarioEntry };

function toStoredCall(l: LlmCallLog): StoredLlmCall {
  return {
    sessionId: l.sessionId ?? null,
    at: l.at,
    stage: l.stage,
    provider: l.provider,
    model: l.model,
    tokensIn: l.tokensIn,
    tokensOut: l.tokensOut,
    cachedTokens: l.cachedTokens,
    costYuan: l.costYuan,
    latencyMs: l.latencyMs,
    ok: l.ok,
    error: l.error ?? null,
  };
}

/** live 模式的模型网关:每次调用写一条 llm_calls(写失败只记日志,不影响对局)。 */
function createChat(root: string): ChatFn {
  const cfg = loadModelsConfig(process.env.FDE_MODELS_CONFIG ?? join(root, "config/models.yaml"));
  return createGateway(cfg, {
    onCall: (log) => {
      void getStore()
        .then((s) => s.logLlmCall(toStoredCall(log)))
        .catch((e: unknown) => console.error("[llm] 调用日志写入失败", e));
    },
  });
}

function engineDeps(scn: LoadedScenario, chat: ChatFn | undefined): EngineDeps {
  const moderation = Moderation.fromFile(process.env.FDE_BANNED_WORDS);
  if (!chat) {
    // 离线:关键词闸门 + 模板演员 + 空裁判 + 模板复盘,不调模型
    return {
      gate: new HeuristicGate(),
      actor: new TemplateActor(),
      judge: new FixtureJudge(() => emptyJudge(scn)),
      debrief: new TemplateDebrief(),
      moderation,
    };
  }
  return { gate: new LlmGate(chat), actor: new LlmActor(chat), judge: new LlmJudge(chat), debrief: new LlmDebrief(chat), moderation };
}

function loadAll(): Map<string, ScenarioEntry> {
  const root = fdeRoot();
  const dir = join(root, "scenarios");
  const out = new Map<string, ScenarioEntry>();
  if (!existsSync(dir)) {
    console.error(`[scenarios] 找不到场景目录 ${dir}(检查 FDE_ROOT)`);
    return out;
  }
  const chat = engineMode() === "live" ? createChat(root) : undefined;
  for (const name of readdirSync(dir).sort()) {
    const scnDir = join(dir, name);
    if (!existsSync(join(scnDir, "scenario.yaml"))) continue;
    try {
      const scn = loadScenario(scnDir);
      out.set(scn.data.meta.id, { scn, engine: new Engine(scn, engineDeps(scn, chat)) });
    } catch (e) {
      // 一个场景坏了不影响其他场景
      console.error(`[scenarios] 加载 ${scnDir} 失败`, e);
    }
  }
  return out;
}

export function scenarios(): Map<string, ScenarioEntry> {
  const rt = runtime();
  return (rt.scenarios ??= loadAll());
}

export function getScenario(id: string): ScenarioEntry | undefined {
  return scenarios().get(id);
}

export function scenarioTitle(id: string): string {
  return getScenario(id)?.scn.data.meta.title ?? id;
}

export function scenarioSummary(scn: LoadedScenario): ScenarioSummary {
  const d = scn.data;
  const speaker = scn.role(d.briefing.opening.speaker);
  return {
    id: d.meta.id,
    title: d.meta.title,
    difficulty: d.meta.difficulty,
    estMinutes: d.meta.est_minutes,
    skillFocus: d.meta.skill_focus,
    disclaimer: d.meta.disclaimer,
    opening: { speakerName: speaker.name, speakerTitle: speaker.title, text: d.briefing.opening.text },
  };
}
