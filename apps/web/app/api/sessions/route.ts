// POST /api/sessions —— 开局;GET /api/sessions —— 本人的对局(按开始时间倒序)。
import { randomUUID } from "node:crypto";
import type { CreateSessionResponse, SessionsResponse } from "@fde/contracts";
import { publicView } from "@fde/engine";
import { requireUser } from "../../../lib/server/auth.ts";
import { dailySessionLimit } from "../../../lib/server/env.ts";
import { recordEvent, visitorIdFrom } from "../../../lib/server/events.ts";
import { HttpError, MESSAGES, handle, json, nowIso, readJson } from "../../../lib/server/http.ts";
import { getScenario } from "../../../lib/server/scenarios.ts";
import { CreateSessionSchema } from "../../../lib/server/schemas.ts";
import { sessionSummaries, startOfDayUtc8 } from "../../../lib/server/sessions.ts";
import { getStore } from "../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireUser(req);
    const body = await readJson(req, CreateSessionSchema);
    if (!user.consentAt) throw new HttpError("consent_required", MESSAGES.consent_required);
    const entry = getScenario(body.scenarioId);
    if (!entry) throw new HttpError("not_found", "没有这个场景");
    const store = await getStore();
    const limit = dailySessionLimit();
    // 同一用户的开局串行执行,避免并发请求同时通过限额检查
    const created = await store.withSessionLock(
      `create-session:${user.id}`,
      async () => {
        const today = await store.countSessionsSince(user.id, startOfDayUtc8());
        if (today >= limit) throw new HttpError("rate_limited", `今天的 ${limit} 局已经用完了,明天再来`);
        const id = randomUUID();
        const state = entry.engine.start(id);
        await store.createSession({ id, userId: user.id, scenarioId: entry.scn.data.meta.id, state, startedAt: nowIso() });
        return { id, state };
      },
      10_000,
    );
    await recordEvent({
      type: "session_created",
      userId: user.id,
      sessionId: created.id,
      visitorId: visitorIdFrom(req),
      props: { scenarioId: entry.scn.data.meta.id },
    });
    const res: CreateSessionResponse = { sessionId: created.id, view: publicView(entry.scn, created.state) };
    return json(res, 201);
  });
}

export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireUser(req);
    const store = await getStore();
    const res: SessionsResponse = { sessions: await sessionSummaries(store, await store.listSessions(user.id)) };
    return json(res);
  });
}
