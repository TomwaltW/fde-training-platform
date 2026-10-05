// POST /api/sessions/:id/finish —— 收工并生成复盘(本人)。幂等:已经出过复盘的直接返回同一份。
import type { FinishResponse } from "@fde/contracts";
import { publicReport } from "@fde/engine";
import { requireUser } from "../../../../../lib/server/auth.ts";
import { handle, json, nowIso } from "../../../../../lib/server/http.ts";
import { FINISH_LOCK_WAIT_MS, assertOwner, loadSession, scenarioOf } from "../../../../../lib/server/sessions.ts";
import { getStore } from "../../../../../lib/server/store.ts";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireUser(req);
    const { id } = await ctx.params;
    const store = await getStore();
    const s0 = await loadSession(store, id);
    assertOwner(auth, s0);
    const { scn, engine } = scenarioOf(s0);
    const respond = (report: Parameters<typeof publicReport>[2]) => {
      const res: FinishResponse = { reportId: id, report: publicReport(scn, id, report) };
      return json(res);
    };

    const existing = await store.getReport(id);
    if (existing) return respond(existing.report);

    // 收工要等正在处理的请求做完(而不是立即 409),这样连点两次收工拿到的是同一份复盘
    return store.withSessionLock(
      id,
      async () => {
        const again = await store.getReport(id);
        if (again) return respond(again.report);
        const s = await loadSession(store, id);
        const report = await engine.finish(s.state);
        const now = nowIso();
        await store.saveSession(id, s.state, s.version, { endedAt: s.endedAt ?? now });
        await store.saveReport(id, report, now);
        return respond(report);
      },
      FINISH_LOCK_WAIT_MS,
    );
  });
}
