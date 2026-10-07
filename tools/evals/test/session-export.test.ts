// pnpm session:export:按网页后端的约定找到库、只读打开、列出对局(账号脱敏)、导出 { state }、建标定用例。
// 不需要 PostgreSQL:内存库用临时文件;只读连接用 PGlite(WASM 版 PostgreSQL)验证;连不上库用本机一个没人监听的端口。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlClient, Store } from "@fde/contracts";
import { createSession, loadScenario, type SessionReport } from "@fde/engine";
import { createMemoryStore, createPgStore } from "@fde/store";
import { getStore } from "../../../apps/web/lib/server/store.ts";
import { resetForTests } from "../../../apps/web/lib/server/runtime.ts";
import { initCase, loadSessionFile, parseSession } from "../src/calibration/cases.ts";
import { exportDoc, exportWarnings, formatTime, maskEmail, maskPhone, maskUser, renderSessionRows, sessionRows } from "../src/sessions/export.ts";
import {
  SourceConfigError,
  checkPgUrl,
  describeTarget,
  errorText,
  makeReadOnly,
  openSessionSource,
  webStoreTarget,
  type SessionSource,
} from "../src/sessions/store.ts";
import { cliEnv, emptyEnvFile } from "./helpers.ts";

const root = resolve(import.meta.dirname, "../../..");
const scn = loadScenario(join(root, "scenarios/freight-docs"));
const cli = join(root, "tools/evals/src/session-export.ts");
const tsx = join(root, "node_modules/.bin/tsx");
const migrationsDir = join(root, "infra/db");

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "fde-session-export-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = (min: number) => new Date(Date.UTC(2026, 9, 7, 6, min)).toISOString(); // 北京时间 14:mm
const report = (total: number) =>
  ({
    score: { dimensions: [], rawTotal: total, total, caps: [], badges: [], band: "x" },
    judge: { claims: [], T: [], S: [], W: [], key_moments: [], npc_inconsistencies: [] },
    judgeIssues: [],
    debrief: {} as SessionReport["debrief"],
    markdown: `# 复盘 ${total}`,
  }) as SessionReport;

/**
 * 三局:alice 收工的一局(真模型,有复盘、两次模型调用)、alice 没收工的一局、手机号用户离线玩的一局。
 * 和网页一样只通过 Store 的接口写,返回各局 id(按开始时间从早到晚)。
 */
async function seed(s: Store): Promise<{ done: string; active: string; phone: string }> {
  const alice = await s.createUser("Alice@Example.com");
  const bob = await s.createUserByPhone("+8613812345678");
  const done = "11111111-1111-4111-8111-111111111111";
  const active = "22222222-2222-4222-8222-222222222222";
  const phone = "33333333-3333-4333-8333-333333333333";

  const st = createSession(scn, { sessionId: done });
  st.transcript.push({ ref: "U1", turn: 1, speaker: "user", roleId: "zhou", text: "周总好,为什么现在想做这件事?", phase: "kickoff" });
  st.turn = 1;
  st.phase = "debrief";
  await s.createSession({ id: done, userId: alice.id, scenarioId: "freight-docs", state: createSession(scn, { sessionId: done }), startedAt: T(1) });
  await s.saveSession(done, st, 1, { endedAt: T(40) });
  await s.saveReport(done, report(62), T(41));
  for (const [stage, cost] of [["gate", 0.001], ["judge", 0.4]] as const) {
    await s.logLlmCall({
      sessionId: done, at: T(2), stage, provider: "p", model: "m", tokensIn: 1, tokensOut: 1, cachedTokens: 0, costYuan: cost, latencyMs: 1, ok: true, error: null,
    });
  }

  await s.createSession({ id: active, userId: alice.id, scenarioId: "freight-docs", state: createSession(scn, { sessionId: active }), startedAt: T(50) });
  await s.createSession({ id: phone, userId: bob.id, scenarioId: "freight-docs", state: createSession(scn, { sessionId: phone }), startedAt: T(55) });
  return { done, active, phone };
}

// ---------------------------------------------------------------- 脱敏与格式

describe("脱敏与时间", () => {
  it("邮箱只留第一个字符和域名;手机号和网页日志一样打码;账号没了也有说法", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("a@x.com")).toBe("a***@x.com");
    expect(maskEmail("张三@example.cn")).toBe("张***@example.cn");
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskPhone("+8613812345678")).toBe("138****5678");
    expect(maskPhone("+1555")).toBe("***");
    expect(maskUser(null)).toBe("(已删除的用户)");
    expect(maskUser({ email: null, phone: "+8613812345678" })).toBe("138****5678");
  });

  it("时间固定按北京时间显示", () => {
    expect(formatTime("2026-10-07T16:30:00.000Z")).toBe("2026-10-08 00:30");
    expect(formatTime(null)).toBe("—");
  });
});

// ---------------------------------------------------------------- 按网页的约定选库

describe("选库:和网页后端一样", () => {
  it("有 DATABASE_URL 用 PostgreSQL;否则内存库文件,相对路径按 apps/web 解析(pnpm dev:web 的工作目录)", () => {
    expect(webStoreTarget({ DATABASE_URL: "postgres://u:secret@db:5432/fde" }, root)).toEqual({ kind: "pg", url: "postgres://u:secret@db:5432/fde" });
    expect(webStoreTarget({ DATABASE_URL: "" }, root)).toEqual({ kind: "memory", file: join(root, ".data/dev-store.json") });
    expect(webStoreTarget({ FDE_MEMORY_STORE_FILE: "/abs/x.json" }, root)).toEqual({ kind: "memory", file: "/abs/x.json" });
    expect(webStoreTarget({ FDE_MEMORY_STORE_FILE: ".data/x.json" }, root)).toEqual({ kind: "memory", file: join(root, "apps/web/.data/x.json") });
    expect(webStoreTarget({ FDE_ROOT: "/srv/fde" }, root)).toEqual({ kind: "memory", file: "/srv/fde/.data/dev-store.json" });
    expect(webStoreTarget({ FDE_ROOT: "../.." }, root)).toEqual({ kind: "memory", file: join(root, ".data/dev-store.json") });
    // 网页遇到空字符串会退回纯内存(不落盘);这里按没设处理
    expect(webStoreTarget({ FDE_MEMORY_STORE_FILE: "" }, root)).toEqual({ kind: "memory", file: join(root, ".data/dev-store.json") });
  });

  it("来源说明不带用户名和密码", () => {
    expect(describeTarget({ kind: "pg", url: "postgres://fde:secret@db:5432/fde" })).toBe("PostgreSQL db:5432/fde");
    expect(describeTarget({ kind: "pg", url: "not a url" })).toBe("PostgreSQL(DATABASE_URL)");
    expect(describeTarget({ kind: "memory", file: "/x/dev-store.json" })).toBe("内存库 /x/dev-store.json");
  });

  it("DATABASE_URL 写错了是配置错误;驱动认的 socket 写法、主机留空的写法照样放行", async () => {
    for (const ok of [
      "postgres://fde:secret@db:5432/fde",
      "postgresql://fde@[::1]/fde",
      "postgres://fde@/fde?host=/var/run/postgresql",
      "/var/run/postgresql fde",
      "socket:/var/run/postgresql?db=fde",
    ]) {
      expect(() => checkPgUrl(ok), ok).not.toThrow();
    }
    // 端口不是数字(驱动会抛 Invalid URL);不是绝对地址的串(驱动会去连一台叫 base 的主机);libpq 的 key=value 写法
    for (const bad of ["postgres://fde:secret@db:notaport/fde", "not a url", "host=localhost dbname=fde"]) {
      expect(() => checkPgUrl(bad), bad).toThrow(SourceConfigError);
    }
    const open = openSessionSource({ kind: "pg", url: "postgres://fde:secret@db:notaport/fde" }, root);
    await expect(open).rejects.toBeInstanceOf(SourceConfigError);
    await expect(open).rejects.toThrow(/^DATABASE_URL 不是合法的连接串/);
    await expect(open).rejects.not.toThrow(/secret/);
  });

  it("读库失败的原因:localhost 连不上时 Node 抛的 AggregateError 没有 message,逐条列出里面的错误", () => {
    const refused = (addr: string) => Object.assign(new Error(`connect ECONNREFUSED ${addr}`), { code: "ECONNREFUSED" });
    const agg = Object.assign(new AggregateError([refused("::1:5432"), refused("127.0.0.1:5432")]), { code: "ECONNREFUSED" });
    expect(agg.message).toBe("");
    expect(errorText(agg)).toBe("connect ECONNREFUSED ::1:5432;connect ECONNREFUSED 127.0.0.1:5432(数据库没启动,或者 DATABASE_URL 的主机、端口不对)");
    expect(errorText(refused("127.0.0.1:5432"))).toBe("connect ECONNREFUSED 127.0.0.1:5432(数据库没启动,或者 DATABASE_URL 的主机、端口不对)");
    expect(errorText(new Error("无法解析 x.json"))).toBe("无法解析 x.json");
    expect(errorText(Object.assign(new Error(""), { code: "ETIMEDOUT" }))).toBe("ETIMEDOUT");
    expect(errorText(new TypeError(""))).toBe("TypeError");
    expect(errorText("boom")).toBe("boom");
  });

  it("和网页的 getStore() 写的是同一个文件:FDE_ROOT 默认位置、FDE_MEMORY_STORE_FILE 绝对路径", async () => {
    const keys = ["FDE_ROOT", "FDE_MEMORY_STORE_FILE", "DATABASE_URL"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const env of [{ FDE_ROOT: tmp() }, { FDE_MEMORY_STORE_FILE: join(tmp(), "nested/store.json") }]) {
        for (const k of keys) delete process.env[k];
        Object.assign(process.env, env);
        await resetForTests();
        const web = await getStore();
        const u = await web.createUser("web@example.com");
        await web.createSession({ id: "web-1", userId: u.id, scenarioId: "freight-docs", state: createSession(scn, { sessionId: "web-1" }), startedAt: T(1) });

        const target = webStoreTarget(process.env, root);
        const { source, close } = await openSessionSource(target, root);
        expect((await source.listAllSessions(10)).map((s) => s.id)).toEqual(["web-1"]);
        expect(maskUser(await source.getUser(u.id))).toBe("w***@example.com");
        await close();
      }
    } finally {
      await resetForTests();
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("只读打开", () => {
  it("内存库:文件不存在、路径不是绝对路径是配置错误;文件坏了是读库失败", async () => {
    const dir = tmp();
    await expect(openSessionSource({ kind: "memory", file: join(dir, "nope.json") }, root)).rejects.toBeInstanceOf(SourceConfigError);
    await expect(openSessionSource({ kind: "memory", file: "rel.json" }, root)).rejects.toBeInstanceOf(SourceConfigError);
    writeFileSync(join(dir, "bad.json"), "{");
    const bad = openSessionSource({ kind: "memory", file: join(dir, "bad.json") }, root);
    await expect(bad).rejects.toThrow("无法解析");
    await expect(bad).rejects.not.toBeInstanceOf(SourceConfigError);
  });

  it("内存库:读完之后文件一个字节都没变", async () => {
    const file = join(tmp(), "store.json");
    await seed(createMemoryStore({ file }));
    const before = readFileSync(file, "utf8");
    const { source, close } = await openSessionSource({ kind: "memory", file }, root);
    await sessionRows(source, await source.listAllSessions(10));
    await close();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("PostgreSQL:连接设成只读之后,读得到对局,写入被数据库拒绝", async () => {
    const db = new PGlite();
    const sql: SqlClient = { query: (q, params) => db.query(q, params), exec: (q) => db.exec(q) };
    const writable = createPgStore(sql, { migrationsDir });
    await writable.migrate();
    const ids = await seed(writable);

    const ro = createPgStore(await makeReadOnly(sql), { migrationsDir });
    const rows = await sessionRows(ro, await ro.listAllSessions(10));
    expect(rows.map((r) => r.id)).toEqual([ids.phone, ids.active, ids.done]);
    expect(rows[2]).toMatchObject({ total: 62, calls: 2, user: "a***@example.com" });
    await expect(ro.createInvites(1, 1)).rejects.toThrow(/read-only/);
    await db.close();
  });
});

// ---------------------------------------------------------------- 列表与导出(两种内存库各跑一遍,写法同 packages/store 的一致性测试)

function runExportSuite(name: string, make: () => Promise<Store>) {
  describe(`列表与导出:${name}`, () => {
    it("列表:新的在前,轮数、总分、模型调用、脱敏账号都对", async () => {
      const s = await make();
      const ids = await seed(s);
      const src: SessionSource = s;
      const rows = await sessionRows(src, await src.listAllSessions(10));
      expect(rows.map((r) => r.id)).toEqual([ids.phone, ids.active, ids.done]);
      expect(rows[2]).toMatchObject({ status: "ended", phase: "debrief", turns: 1, total: 62, calls: 2, user: "a***@example.com", endedAt: T(40) });
      expect(rows[2]!.costYuan).toBeCloseTo(0.401, 6);
      expect(rows[1]).toMatchObject({ status: "active", turns: 0, total: null, calls: 0, user: "a***@example.com" });
      expect(rows[0]).toMatchObject({ user: "138****5678", calls: 0 });

      const text = renderSessionRows(rows).join("\n");
      expect(text).toMatch(new RegExp(`${ids.done}\\s+freight-docs\\s+已收工\\s+1\\s+2026-10-07 14:01\\s+2026-10-07 14:40\\s+62\\s+2 次 ¥0\\.40\\s+a\\*\\*\\*@example\\.com`));
      expect(text).toContain("进行中(kickoff)");
      expect(text).not.toContain("alice@example.com");
      expect(text).not.toContain("13812345678");
    });

    it("导出:{ state } 形状被标定工具接受,不带账号;和 calibrate --init 建出的用例一样", async () => {
      const s = await make();
      const ids = await seed(s);
      const stored = (await s.getSession(ids.done))!;
      const doc = exportDoc(stored);
      expect(Object.keys(doc).sort()).toEqual(["endedAt", "id", "scenarioId", "startedAt", "state", "status"]);
      expect(JSON.stringify(doc)).not.toContain(stored.userId);
      expect(parseSession(doc, scn, "(导出)")).toEqual(stored.state);

      // 先写文件再 --init,和直接把 state 交给 initCase,得到的 session.json 完全一样
      const dir = tmp();
      const file = join(dir, "export.json");
      writeFileSync(file, JSON.stringify(doc));
      const a = initCase({ scn, calibrationDir: join(dir, "calib"), sessionFile: file, caseId: "from-file", today: "2026-10-07" });
      const b = initCase({ scn, calibrationDir: join(dir, "calib"), state: stored.state, caseId: "from-store", today: "2026-10-07" });
      expect(readFileSync(a.files[0]!, "utf8")).toBe(readFileSync(b.files[0]!, "utf8"));
      expect(loadSessionFile(b.files[0]!, scn)).toEqual(stored.state);
    });

    it("提醒:没收工、没有模型调用(离线模式)", async () => {
      const s = await make();
      const ids = await seed(s);
      expect(exportWarnings((await s.getSession(ids.done))!, 2)).toEqual([]);
      const w = exportWarnings((await s.getSession(ids.active))!, 0);
      expect(w).toHaveLength(2);
      expect(w[0]).toContain("还没收工(阶段 kickoff,0 轮)");
      expect(w[1]).toContain("离线模式");
    });
  });
}

runExportSuite("memory", async () => createMemoryStore());
runExportSuite("memory (file)", async () => createMemoryStore({ file: join(tmp(), "db.json") }));

// ---------------------------------------------------------------- 命令行

describe("命令行", () => {
  // 子进程不继承 process.env(shell 里的 DATABASE_URL、PGHOST 之类漏不进来);要读库的用 --store-file,不读 .env;
  // 要走 DATABASE_URL 的用 --dotenv 指一个空文件,仓库根目录的 .env 也不读
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(tsx, [cli, ...args], { cwd: root, encoding: "utf8", env: cliEnv({ INIT_CWD: root, ...env }) });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  /** 本机一个刚刚还空着、现在没人监听的端口。 */
  const closedPort = () =>
    new Promise<number>((done, fail) => {
      const srv = createServer();
      srv.once("error", fail);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as { port: number };
        srv.close(() => done(port));
      });
    });
  const fixture = async () => {
    const file = join(tmp(), "dev-store.json");
    const ids = await seed(createMemoryStore({ file }));
    return { file, ids };
  };

  it("参数错误:退出码 2", () => {
    expect(run(["--help"]).code).toBe(0);
    expect(run([])).toMatchObject({ code: 2 });
    expect(run([]).err).toContain("--list 和 --id 必须给一个");
    expect(run(["--list", "--id", "x"]).code).toBe(2);
    expect(run(["--list", "--out", "x.json"]).err).toContain("只和 --id 一起用");
    expect(run(["--list", "--limit", "0"]).err).toContain("--limit 必须是正整数");
    expect(run(["--id", "x", "--dir", "y"]).err).toContain("只和 --calibrate 一起用");
    expect(run(["--id", "x", "--calibrate", "../evil"]).err).toContain("用例 id「../evil」不合法");
    expect(run(["--id", "x", "--calibrate", "ok", "--scenario", "scenarios/nope"])).toMatchObject({ code: 2 });
    expect(run(["--bogus"]).err).toContain("参数错误");
    expect(run(["--list", "--store-file", "x.json", "--dotenv", "y.txt"]).err).toContain("--dotenv 不和 --store-file 一起用");
    const noFile = run(["--list", "--dotenv", join(tmp(), "nope.txt")]);
    expect(noFile.code).toBe(2);
    expect(noFile.err).toContain("找不到 --dotenv 指定的文件");
  }, 60_000);

  it("DATABASE_URL 写错了:退出码 2,不打印连接串;连不上库:退出码 1,说清楚连的哪里、被拒了", async () => {
    const dotenv = emptyEnvFile(tmp());
    for (const url of ["postgres://fde:secret@db:notaport/fde", "not a url"]) {
      const bad = run(["--list", "--dotenv", dotenv], { DATABASE_URL: url });
      expect(bad.code, url).toBe(2);
      expect(bad.err).toContain("DATABASE_URL 不是合法的连接串");
      expect(bad.err).not.toContain("secret");
      expect(bad.err).not.toContain("读库失败");
    }

    // localhost 会先后试 ::1 和 127.0.0.1,两个都被拒时是 message 为空的 AggregateError;只有一个地址的机器上是普通 Error。两种都要有原因
    const port = await closedPort();
    const refused = run(["--list", "--dotenv", dotenv], { DATABASE_URL: `postgres://fde:secret@localhost:${port}/fde` });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`对局来源:PostgreSQL localhost:${port}/fde`);
    expect(refused.err).toMatch(new RegExp(`读库失败:connect ECONNREFUSED \\S+:${port}`));
    expect(refused.err).toContain("数据库没启动,或者 DATABASE_URL 的主机、端口不对");
    expect(refused.err).not.toContain("secret");
  }, 60_000);

  it("--list:打印来源和表格,账号脱敏;库文件不存在退出码 2,文件坏了退出码 1", async () => {
    const { file, ids } = await fixture();
    const r = run(["--list", "--store-file", file]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`对局来源:内存库 ${file}`);
    expect(r.out).toContain(ids.done);
    expect(r.out).toContain("a***@example.com");
    expect(r.out).not.toContain("alice@example.com");
    expect(r.out).toContain("共 3 局");
    expect(run(["--list", "--limit", "2", "--store-file", file]).out).toContain("只显示最新 2 局");

    const missing = run(["--list", "--store-file", join(tmp(), "nope.json")]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("找不到内存库文件");
    const badFile = join(tmp(), "bad.json");
    writeFileSync(badFile, "{");
    const bad = run(["--list", "--store-file", badFile]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("读库失败");
  }, 60_000);

  it("--id:标准输出或 --out 写出 { state };没有这局退出码 2", async () => {
    const { file, ids } = await fixture();
    const r = run(["--id", ids.done, "--store-file", file]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { id: string; state: { sessionId: string } };
    expect(doc.id).toBe(ids.done);
    expect(doc.state.sessionId).toBe(ids.done);
    expect(r.out).not.toContain("userId");

    const out = join(tmp(), "sub/beta-01.json");
    const w = run(["--id", ids.active, "--store-file", file, "--out", out]);
    expect(w.code).toBe(0);
    expect(w.out).toBe("");
    expect(w.err).toContain("还没收工");
    expect(w.err).toContain("离线模式");
    expect(JSON.parse(readFileSync(out, "utf8")).state.sessionId).toBe(ids.active);

    const none = run(["--id", "no-such-session", "--store-file", file]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("没有这局:no-such-session");
  }, 60_000);

  it("--calibrate:建好标定用例;同名用例已存在时退出码 2,不覆盖", async () => {
    const { file, ids } = await fixture();
    const dir = tmp();
    const r = run(["--id", ids.done, "--calibrate", "beta-01", "--store-file", file, "--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("已建标定用例 beta-01");
    for (const f of ["session.json", "human.yaml", "transcript.md"]) expect(existsSync(join(dir, "beta-01", f))).toBe(true);
    expect(loadSessionFile(join(dir, "beta-01/session.json"), scn).sessionId).toBe(ids.done);
    expect(readFileSync(join(dir, "beta-01/transcript.md"), "utf8")).toContain("周总好,为什么现在想做这件事?");

    const again = run(["--id", ids.done, "--calibrate", "beta-01", "--store-file", file, "--dir", dir]);
    expect(again.code).toBe(2);
    expect(again.err).toContain("用例目录已存在");

    // 用例目录写不进去(这里 --dir 是个普通文件):退出码 1,说的是建用例失败,不是读库失败
    const notDir = join(tmp(), "not-a-dir");
    writeFileSync(notDir, "");
    const blocked = run(["--id", ids.done, "--calibrate", "beta-02", "--store-file", file, "--dir", notDir]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("建用例失败");
    expect(blocked.err).not.toContain("读库失败");
  }, 60_000);
});
