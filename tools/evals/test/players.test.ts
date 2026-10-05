// 所有脚本化玩家离线跑一遍:场景断言、步骤断言全部通过;
// 并检查方案 3.3.5 的核心不变量——演员上下文里没有它还没说过的事实,闸门提示词里没有任何事实内容。
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TemplateActor,
  buildGatePrompt,
  createSession,
  gateCatalog,
  publicView,
  levelRank,
  loadScenario,
  type ActorInput,
  type Level,
} from "@fde/engine";
import { loadPlayers } from "../src/players.ts";
import { checkExpectations, runPlayer } from "../src/runner.ts";

const dir = resolve(import.meta.dirname, "../../../scenarios/freight-docs");
const scn = loadScenario(dir);
const players = loadPlayers(resolve(dir, "evals/players"));
const specs = new Map((scn.data.evals ?? []).map((e) => [e.id, e.expect]));

/** 记录每次演员调用时的提示词和该角色当时"说过"的事实。 */
class SpyActor extends TemplateActor {
  calls: { role: string; prompt: string; told: Record<string, Level> }[] = [];
  override async speak(input: ActorInput) {
    const role = input.plan.role!;
    this.calls.push({
      role,
      prompt: input.prompt.messages.map((m) => m.content).join("\n"),
      told: structuredClone(input.st.roleTold[role] ?? {}),
    });
    return super.speak(input);
  }
}

describe("scripted players (offline)", () => {
  it("每个 scenario.yaml 里的 eval 都有对应的玩家", () => {
    expect([...specs.keys()].sort()).toEqual(players.map((p) => p.id).sort());
  });

  for (const p of players) {
    it(p.id, async () => {
      const spy = new SpyActor();
      const run = await runPlayer(scn, p, { kind: "offline", overrides: { actor: spy } });
      expect(run.crashed).toBeUndefined();
      const all = [...run.checks, ...checkExpectations(run, { ...(p.expect ?? {}), ...(specs.get(p.id) ?? {}) })];
      expect(all.filter((c) => !c.ok)).toEqual([]);

      // 不变量 3:给浏览器的视图(对话记录以外的部分)不含任何事实原文、印象、金丝雀词、压力时刻文字、授权名
      const view = publicView(scn, run.state!);
      const { transcript: _t, ...rest } = view;
      const blob = JSON.stringify(rest);
      for (const f of scn.data.facts) {
        expect(blob.includes(f.statement), `view 含 ${f.id} 原文`).toBe(false);
        for (const u of f.unlock) if ("say" in u && u.say) expect(blob.includes(u.say), `view 含 ${f.id} say`).toBe(false);
      }
      for (const tr of scn.data.traps) expect(blob.includes(tr.beat), `view 含 ${tr.id} beat`).toBe(false);
      for (const flag of Object.keys(scn.data.flags)) expect(blob.includes(flag), `view 含 flag ${flag}`).toBe(false);
      expect(blob).not.toMatch(/"trust"|"ledger"|"directive"|"guardFlags"|"facts"/);

      // 不变量 1:演员提示词里出现某条事实的原文(statement)或印象(say),那这个角色必须已经说到那一级
      for (const call of spy.calls) {
        for (const f of scn.data.facts) {
          const told = call.told[f.id];
          if (call.prompt.includes(f.statement)) {
            expect(told && levelRank(told) >= 2, `${call.role} 的提示词里出现了 ${f.id} 的原文`).toBe(true);
          }
          for (const u of f.unlock) {
            if ("say" in u && u.say && call.prompt.includes(u.say)) {
              expect(told, `${call.role} 的提示词里出现了 ${f.id} 的 say`).toBeDefined();
            }
          }
        }
      }
    });
  }

  it("不变量 2:闸门提示词的固定部分不含任何事实原文或印象;金丝雀词只出现在验证、动作的标题里", () => {
    const st = createSession(scn, { sessionId: "t" });
    const fixed = buildGatePrompt(scn, st, "你好")[0]!.content;
    for (const f of scn.data.facts) {
      expect(fixed.includes(f.statement), f.id).toBe(false);
      for (const u of f.unlock) if ("say" in u && u.say) expect(fixed.includes(u.say), `${f.id} say`).toBe(false);
    }
    // 验证和动作的标题是给用户看的按钮文字(拿到前提资料后才显示),可以含资料名;事实类触发器的描述不行
    const canaries = scn.data.facts.flatMap((f) => (f.canaries ?? []).map((w) => [f.id, w] as const));
    for (const t of gateCatalog(scn)) {
      if (t.id.startsWith("exp:") || t.id.startsWith("act:")) continue;
      for (const [fid, w] of canaries) expect(t.ask.includes(w), `${t.id} 含 ${fid} 的金丝雀词 ${w}`).toBe(false);
    }
  });
});

describe("runner(评审 C24、R10)", () => {
  it("C24:会话提前结束、后面还有步骤 → 失败", async () => {
    const run = await runPlayer(
      scn,
      {
        id: "EV_tmp",
        steps: [{ say: "收工", gate: { acts: ["end_session"] } }, { say: "还有一句", gate: { tags: ["open"] } }, { end: true }],
      },
      { kind: "offline" },
    );
    expect(run.checks.some((c) => !c.ok && c.detail.includes("没执行"))).toBe(true);
  });

  it("R10:脚本里写错触发器 id、按钮动作被拒绝 → 失败", async () => {
    const run = await runPlayer(
      scn,
      { id: "EV_tmp", steps: [{ say: "x", gate: { t: ["S9@zhou:L2"] } }, { experiment: "X3" }, { end: true }] },
      { kind: "offline" },
    );
    const bad = run.checks.filter((c) => !c.ok).map((c) => c.detail);
    expect(bad.some((d) => d.includes("未知触发器 S9@zhou:L2"))).toBe(true);
    expect(bad.some((d) => d.includes("被拒绝"))).toBe(true);
  });
});
