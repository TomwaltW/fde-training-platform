// 引擎对外的端口。引擎本身不依赖任何模型 SDK:线上用 @fde/llm 的网关实现 ChatFn,
// 测试和离线试玩用 offline/ 下的确定性实现。
import type { DebriefData } from "./debrief.ts";
import type { TurnPlan } from "./director.ts";
import type { JudgeOutput } from "./judge.ts";
import type { ActorPrompt } from "./prompts/actor.ts";
import type { LoadedScenario } from "./scenario/load.ts";
import type { GateOutput, SessionState } from "./types.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type Stage = "gate" | "actor" | "judge" | "debrief";

export interface ChatRequest {
  stage: Stage;
  messages: ChatMessage[];
  /** 要求模型只输出 JSON。 */
  json?: boolean;
  sessionId?: string;
}

export interface ChatResponse {
  text: string;
}

export type ChatFn = (req: ChatRequest) => Promise<ChatResponse>;

export interface GateInput {
  scn: LoadedScenario;
  st: SessionState;
  userText: string;
}

export interface GatePort {
  classify(input: GateInput): Promise<GateOutput>;
}

export interface ActorInput {
  scn: LoadedScenario;
  st: SessionState;
  plan: TurnPlan;
  userText: string | undefined;
  /** 第几次尝试(守卫不通过会收紧指令重试)。 */
  attempt: number;
  /** 上一次被守卫拦下的原因。 */
  previousFlags: string[];
  /** 引擎组装好的提示词(重试时已经收紧)。 */
  prompt: ActorPrompt;
}

export interface ActorPort {
  speak(input: ActorInput): Promise<string>;
}

export interface JudgePort {
  /** 返回裁判的原始输出(未校验);引擎负责校验。 */
  judge(input: { scn: LoadedScenario; st: SessionState }): Promise<unknown>;
}

export interface DebriefPort {
  write(input: { scn: LoadedScenario; st: SessionState; data: DebriefData }): Promise<string>;
}

export type { JudgeOutput };
