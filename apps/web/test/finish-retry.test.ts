// 收工时裁判或复盘模型失败:裁判失败前两次不保存复盘(返回错误让玩家重试),第三次保存带说明的复盘;
// 复盘文稿模型失败时改用模板出稿。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CreateSessionResponse, FinishResponse, RequestCodeResponse } from "@fde/contracts";
import {
  Engine,
  FixtureJudge,
  HeuristicGate,
  JUDGE_FAILED_NOTICE,
  TemplateActor,
  TemplateDebrief,
  emptyJudge,
  type DebriefPort,
  type JudgePort,
} from "@fde/engine";
import * as requestCode from "../app/api/auth/request-code/route.ts";
import * as verify from "../app/api/auth/verify/route.ts";
import * as consent from "../app/api/me/consent/route.ts";
import * as report from "../app/api/reports/[id]/route.ts";
import * as actions from "../app/api/sessions/[id]/actions/route.ts";
import * as finish from "../app/api/sessions/[id]/finish/route.ts";
import * as turns from "../app/api/sessions/[id]/turns/route.ts";
import * as sessions from "../app/api/sessions/route.ts";
import { resetForTests, runtime } from "../lib/server/runtime.ts";
import { getScenario, withTemplateFallback } from "../lib/server/scenarios.ts";
import { Client, errorCode } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const KEYS = ["FDE_ROOT", "FDE_ENGINE_MODE", "FDE_DEV_LOGIN_CODES", "FDE_MEMORY_STORE_FILE", "ADMIN_EMAILS", "FDE_AUTH_SECRET", "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.DATABASE_URL;
});
afterAll(async () => {
  await resetForTests();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  Object.assign(process.env, {
    FDE_ROOT: ROOT,
    FDE_ENGINE_MODE: "offline",
    FDE_DEV_LOGIN_CODES: "1",
    // 每个用例一个新的纯内存库
    FDE_MEMORY_STORE_FILE: join(mkdtempSync(join(tmpdir(), "fde-finish-")), "store.json"),
    ADMIN_EMAILS: "admin@example.com",
    FDE_AUTH_SECRET: "test-secret",
  });
  await resetForTests();
});

/** 把场景的引擎换成指定的裁判和复盘实现。 */
function useEngine(judge: JudgePort, debrief: DebriefPort = new TemplateDebrief()) {
  const entry = getScenario("freight-docs")!;
  runtime().scenarios!.set("freight-docs", {
    scn: entry.scn,
    engine: new Engine(entry.scn, { gate: new HeuristicGate(), actor: new TemplateActor(), judge, debrief }),
  });
}

async function startPlayedSession(): Promise<{ c: Client; id: string }> {
  const c = new Client();
  const r1 = await c.post<RequestCodeResponse>(requestCode.POST, { body: { email: "admin@example.com" } });
  await c.post(verify.POST, { body: { email: "admin@example.com", code: r1.body.devCode } });
  await c.post(consent.POST, { body: {} });
  const s = await c.post<CreateSessionResponse>(sessions.POST, { body: { scenarioId: "freight-docs" } });
  const id = s.body.sessionId;
  expect((await c.post(turns.POST, { body: { text: "周总您好,为什么现在想做这件事?" }, params: { id } })).status).toBe(200);
  expect((await c.post(actions.POST, { body: { type: "end" }, params: { id } })).status).toBe(200);
  return { c, id };
}

describe("收工:裁判失败", () => {
  it("前两次返回错误且不保存复盘,第三次保存带说明的复盘,之后幂等", async () => {
    let calls = 0;
    useEngine({
      async judge() {
        calls++;
        throw new Error("timeout");
      },
    });
    const { c, id } = await startPlayedSession();
    for (let i = 1; i <= 2; i++) {
      const r = await c.post(finish.POST, { params: { id } });
      expect(r.status).toBe(500);
      expect(errorCode(r)).toBe("internal");
      expect((await c.get(report.GET, { params: { id } })).status).toBe(404);
    }
    const third = await c.post<FinishResponse>(finish.POST, { params: { id } });
    expect(third.status).toBe(200);
    expect(third.body.report.markdown.startsWith(JUDGE_FAILED_NOTICE)).toBe(true);
    expect(calls).toBe(3);
    const again = await c.post<FinishResponse>(finish.POST, { params: { id } });
    expect(again.body.report).toEqual(third.body.report);
    expect(calls).toBe(3);
  });

  it("裁判第二次恢复:正常保存,没有说明,失败计数清零", async () => {
    let calls = 0;
    const scn = getScenario("freight-docs")!.scn;
    useEngine({
      async judge() {
        calls++;
        if (calls === 1) throw new Error("timeout");
        return new FixtureJudge(() => emptyJudge(scn)).judge();
      },
    });
    const { c, id } = await startPlayedSession();
    expect((await c.post(finish.POST, { params: { id } })).status).toBe(500);
    const ok = await c.post<FinishResponse>(finish.POST, { params: { id } });
    expect(ok.status).toBe(200);
    expect(ok.body.report.markdown).not.toContain(JUDGE_FAILED_NOTICE);
    expect(runtime().finishJudgeFailures?.has(id)).toBe(false);
  });
});

describe("复盘文稿模型失败", () => {
  it("改用模板出稿,收工成功", async () => {
    const failing: DebriefPort = {
      async write() {
        throw new Error("DataInspectionFailed");
      },
    };
    const scn = getScenario("freight-docs")!.scn;
    useEngine(new FixtureJudge(() => emptyJudge(scn)), withTemplateFallback(failing));
    const { c, id } = await startPlayedSession();
    const r = await c.post<FinishResponse>(finish.POST, { params: { id } });
    expect(r.status).toBe(200);
    expect(r.body.report.markdown.length).toBeGreaterThan(100);
  });
});
