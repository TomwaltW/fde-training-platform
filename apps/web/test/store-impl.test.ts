// @fde/store 的补充测试:一致性测试之外、网页后端依赖的实现细节(落盘、共用锁、迁移记录、时间格式)。
// 放在这里而不是 packages/store/test,是为了让 `vitest run packages/store` 只跑那 27 个一致性测试。
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { SessionBusyError } from "@fde/contracts";
import { createMemoryStore, createPgStore } from "@fde/store";

const migrationsDir = resolve(import.meta.dirname, "../../../infra/db");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MemoryStore 落盘", () => {
  it("新实例能读回之前写的数据,目录里不留临时文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fde-t1-"));
    const file = join(dir, "nested", "db.json");
    const a = createMemoryStore({ file });
    const u = await a.createUser("x@example.com");
    const [code] = await a.createInvites(1, 2, "n");
    await a.redeemInvite(code!);
    await a.createAuthToken(u.id, "tok", "2099-01-01T00:00:00.000Z");

    const b = createMemoryStore({ file });
    expect((await b.getUserByEmail("x@example.com"))?.id).toBe(u.id);
    expect((await b.getUserByAuthToken("tok", "2026-10-05T00:00:00.000Z"))?.id).toBe(u.id);
    expect(await b.redeemInvite(code!)).toBe(true);
    expect(await b.redeemInvite(code!)).toBe(false);
    expect(readdirSync(join(dir, "nested"))).toEqual(["db.json"]);
  });

  it("文件损坏时启动失败,而不是悄悄清空", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fde-t1-")), "db.json");
    writeFileSync(file, "{ not json");
    expect(() => createMemoryStore({ file })).toThrow(/无法解析/);
  });

  it("读出来的是副本,改了不影响库里", async () => {
    const s = createMemoryStore();
    const u = await s.createUser("y@example.com");
    u.email = "hacked@example.com";
    expect((await s.getUser(u.id))?.email).toBe("y@example.com");
  });
});

describe("会话锁", () => {
  it("timeoutMs=0 时拿不到锁立即抛 SessionBusyError", async () => {
    const s = createMemoryStore();
    const hold = s.withSessionLock("t1-zero", () => sleep(50));
    const started = Date.now();
    await expect(s.withSessionLock("t1-zero", async () => "x", 0)).rejects.toBeInstanceOf(SessionBusyError);
    expect(Date.now() - started).toBeLessThan(40);
    await hold;
    expect(await s.withSessionLock("t1-zero", async () => "free", 0)).toBe("free");
  });

  it("两套实现共用一个进程内互斥", async () => {
    const mem = createMemoryStore();
    const pg = createPgStore({ query: async () => ({ rows: [] }) }, { migrationsDir });
    const hold = mem.withSessionLock("t1-shared", () => sleep(50));
    await expect(pg.withSessionLock("t1-shared", async () => "x", 0)).rejects.toBeInstanceOf(SessionBusyError);
    await hold;
  });

  it("等锁超时的请求不会在之后偷偷执行", async () => {
    const s = createMemoryStore();
    let ran = false;
    const hold = s.withSessionLock("t1-timeout", () => sleep(60));
    await expect(
      s.withSessionLock(
        "t1-timeout",
        async () => {
          ran = true;
        },
        10,
      ),
    ).rejects.toBeInstanceOf(SessionBusyError);
    await hold;
    await sleep(10);
    expect(ran).toBe(false);
  });
});

describe("PgStore(PGlite)", () => {
  const make = () => {
    const db = new PGlite();
    return { db, store: createPgStore({ query: (sql, params) => db.query(sql, params), exec: (sql) => db.exec(sql) }, { migrationsDir }) };
  };

  it("迁移按文件名记录一次,重复调用不重复执行", async () => {
    const { db, store } = make();
    await store.migrate();
    await store.migrate();
    const r = await db.query<{ name: string }>("select name from schema_migrations order by name");
    expect(r.rows.map((x) => x.name)).toEqual(readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort());
    await db.close();
  });

  it("没有 exec 时用 query 跑迁移脚本(pg.Pool 的情况)", async () => {
    const db = new PGlite();
    // PGlite 的 query 不能跑多条语句,这里把无参数的多语句转给 exec,模拟 pg.Pool 的简单查询协议
    const store = createPgStore(
      { query: async (sql, params) => (params?.length ? db.query(sql, params) : { rows: (await db.exec(sql)).at(-1)?.rows ?? [] }) as never },
      { migrationsDir },
    );
    await store.migrate();
    expect(await store.countUsers()).toBe(0);
    await db.close();
  });

  it("时间一律读回成 ISO 字符串", async () => {
    const { db, store } = make();
    await store.migrate();
    const u = await store.createUser("z@example.com");
    expect(u.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await store.setConsent(u.id, "2026-10-05T16:30:00+08:00");
    expect((await store.getUser(u.id))?.consentAt).toBe("2026-10-05T08:30:00.000Z");
    await db.close();
  });
});
