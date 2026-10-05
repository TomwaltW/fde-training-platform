// 基于模型的四个端口。模型调用通过 ChatFn 注入(线上由 @fde/llm 网关提供)。
import type { DebriefData } from "./debrief.ts";
import { AI_NOTICE, buildDebriefPrompt } from "./debrief.ts";
import { buildJudgePrompt } from "./judge.ts";
import type { ActorInput, ActorPort, ChatFn, DebriefPort, GateInput, GatePort, JudgePort } from "./ports.ts";
import { buildGatePrompt, extractJson, normalizeGateOutput } from "./prompts/gate.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import type { GateOutput, SessionState } from "./types.ts";
import { gateOutput } from "./offline/heuristic-gate.ts";

export class LlmGate implements GatePort {
  constructor(private chat: ChatFn) {}
  async classify({ scn, st, userText }: GateInput): Promise<GateOutput> {
    const messages = buildGatePrompt(scn, st, userText);
    for (let i = 0; i < 2; i++) {
      try {
        const res = await this.chat({ stage: "gate", messages, json: true, sessionId: st.sessionId });
        return normalizeGateOutput(scn, extractJson(res.text));
      } catch (e) {
        if (i === 1) console.warn(`[gate] 输出无法解析,按普通提问处理:${(e as Error).message}`);
      }
    }
    // 闸门失败时宁可什么都不解锁,也不猜
    return gateOutput({ acts: ["ask"], summary: userText.slice(0, 40) });
  }
}

/** 去掉模型常见的多余包装:引号、"周总:"前缀、首尾空白。 */
export function cleanActorReply(text: string, roleName: string): string {
  let t = text.trim();
  t = t.replace(new RegExp(`^(${roleName}|我)\\s*[::]\\s*`), "");
  t = t.replace(/^["“「](.*)["”」]$/s, "$1");
  return t.trim();
}

export class LlmActor implements ActorPort {
  constructor(private chat: ChatFn) {}
  async speak({ scn, st, plan, prompt }: ActorInput): Promise<string> {
    const res = await this.chat({ stage: "actor", messages: prompt.messages, sessionId: st.sessionId });
    return cleanActorReply(res.text, scn.role(plan.role!).name);
  }
}

export class LlmJudge implements JudgePort {
  constructor(private chat: ChatFn) {}
  async judge({ scn, st }: { scn: LoadedScenario; st: SessionState }): Promise<unknown> {
    const res = await this.chat({ stage: "judge", messages: buildJudgePrompt(scn, st), json: true, sessionId: st.sessionId });
    return extractJson(res.text);
  }
}

export class LlmDebrief implements DebriefPort {
  constructor(private chat: ChatFn) {}
  async write({ st, data }: { scn: LoadedScenario; st: SessionState; data: DebriefData }): Promise<string> {
    const res = await this.chat({ stage: "debrief", messages: buildDebriefPrompt(data, st), sessionId: st.sessionId });
    const text = res.text.trim();
    return text.includes(AI_NOTICE) ? text : `${text}\n\n${AI_NOTICE}`;
  }
}
