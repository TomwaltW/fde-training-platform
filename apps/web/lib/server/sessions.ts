// 对局的读取、权限和"加锁 → 引擎 → 乐观锁写回"流程(spec 3.2 会话处理流程)。
import type { SessionSummary, Store, StoredSession, TurnResponse } from "@fde/contracts";
import { publicTurnResult, publicView, type Engine, type SessionState, type TurnResult } from "@fde/engine";
import type { AuthContext } from "./auth.ts";
import { HttpError, MESSAGES, nowIso } from "./http.ts";
import { getScenario, scenarioTitle, type ScenarioEntry } from "./scenarios.ts";

/** 收工可能要几十秒(裁判 + 复盘);重复点收工时等前一个做完,直接拿到同一份复盘。 */
export const FINISH_LOCK_WAIT_MS = 180_000;

export async function loadSession(store: Store, id: string): Promise<StoredSession> {
  const s = await store.getSession(id);
  if (!s) throw new HttpError("not_found", "找不到这一局");
  return s;
}

/** 本人或管理员可以看。别人的对局统一 403 forbidden(测试里固定)。 */
export function assertCanView(auth: AuthContext, s: StoredSession) {
  if (s.userId !== auth.user.id && !auth.isAdmin) throw new HttpError("forbidden", MESSAGES.forbidden);
}

/** 只有本人可以操作(说话、动作、收工、反馈)。 */
export function assertOwner(auth: AuthContext, s: StoredSession) {
  if (s.userId !== auth.user.id) throw new HttpError("forbidden", MESSAGES.forbidden);
}

export function scenarioOf(s: StoredSession): ScenarioEntry {
  const entry = getScenario(s.scenarioId);
  // 场景被下线了:对局数据还在,但没法继续
  if (!entry) throw new Error(`对局 ${s.id} 的场景 ${s.scenarioId} 没有加载`);
  return entry;
}

export function isEnded(s: StoredSession): boolean {
  return s.status === "ended" || s.state.phase === "debrief";
}

/**
 * 说话、做动作:拿不到锁立即 409 session_busy;锁内重新读最新状态,引擎处理后按版本号写回
 * (版本冲突同样 409 session_busy)。引擎中途出错时状态不写回,下次从库里的版本重来。
 */
export async function playStep(
  store: Store,
  auth: AuthContext,
  id: string,
  step: (engine: Engine, state: SessionState) => Promise<TurnResult>,
): Promise<TurnResponse> {
  const before = await loadSession(store, id);
  assertOwner(auth, before);
  if (isEnded(before)) throw new HttpError("session_ended", MESSAGES.session_ended);
  return store.withSessionLock(
    id,
    async () => {
      const s = await loadSession(store, id);
      if (isEnded(s)) throw new HttpError("session_ended", MESSAGES.session_ended);
      const { scn, engine } = scenarioOf(s);
      const r = await step(engine, s.state);
      const ended = s.state.phase === "debrief";
      await store.saveSession(id, s.state, s.version, ended ? { endedAt: nowIso() } : undefined);
      return { result: publicTurnResult(scn, r), view: publicView(scn, s.state) };
    },
    0,
  );
}

export async function sessionSummaries(store: Store, sessions: StoredSession[]): Promise<SessionSummary[]> {
  return Promise.all(
    sessions.map(async (s) => {
      const report = await store.getReport(s.id);
      return {
        id: s.id,
        scenarioId: s.scenarioId,
        title: scenarioTitle(s.scenarioId),
        phase: s.state.phase,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        total: report ? report.report.score.total : null,
      };
    }),
  );
}

/** UTC+8 自然日的零点(返回 UTC 的 ISO 字符串)。 */
export function startOfDayUtc8(now: Date = new Date()): string {
  const OFFSET = 8 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + OFFSET);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnight - OFFSET).toISOString();
}
