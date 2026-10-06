// --init-player:用脚本化玩家离线跑一局,拿它的对局当标定用例(方案 3.4.4 的"脚本化玩家 5 份")。
// 离线模式完全确定:闸门用脚本里的标准标注,演员用模板台词;对话读起来生硬,但流程完整、可复现。
// 示例用例 example-EV_good、example-EV_rush 就是这样生成的。
import { join } from "node:path";
import type { LoadedScenario, SessionState } from "@fde/engine";
import { loadPlayers } from "../players.ts";
import { runPlayer } from "../runner.ts";
import { CalibrationInputError } from "./human.ts";

export interface PlayerSession {
  state: SessionState;
  /** 脚本自身没通过的断言(说明脚本和引擎对不上,这局对话可能不是预期的样子)。 */
  failedChecks: string[];
}

export async function playerSession(scn: LoadedScenario, scnDir: string, playerId: string): Promise<PlayerSession> {
  const players = loadPlayers(join(scnDir, "evals/players"));
  const p = players.find((x) => x.id === playerId);
  if (!p) {
    throw new CalibrationInputError("--init-player", [`没有脚本化玩家 ${playerId}(现有:${players.map((x) => x.id).join("、")})`]);
  }
  const run = await runPlayer(scn, p, { kind: "offline" });
  if (run.crashed || !run.state) throw new Error(`脚本化玩家 ${playerId} 跑崩了:${run.crashed?.split("\n")[0] ?? "没有状态"}`);
  // 会话 id 固定下来,同一个脚本重新生成的 session.json 内容不变
  const state = run.state;
  state.sessionId = `calib-${playerId}`;
  return { state, failedChecks: run.checks.filter((c) => !c.ok).map((c) => `${c.name}:${c.detail}`) };
}
