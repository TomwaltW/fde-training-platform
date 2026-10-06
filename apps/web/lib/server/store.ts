// 持久化选择:有 DATABASE_URL 用 PostgreSQL(启动时 migrate),否则用内存库(落盘到 JSON 文件)。
import { join } from "node:path";
import type { SqlClient, Store } from "@fde/contracts";
import { createMemoryStore, createPgStore } from "@fde/store";
import { fdeRoot } from "./env.ts";
import { runtime } from "./runtime.ts";

async function createStore(): Promise<{ store: Store; close?: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    // 只有用到 PostgreSQL 时才加载驱动
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    pool.on("error", (e) => console.error("[store] PostgreSQL 连接出错", e));
    const client: SqlClient = {
      async query<T>(sql: string, params?: unknown[]) {
        const r = await pool.query(sql, params);
        return { rows: r.rows as T[] };
      },
    };
    const store = createPgStore(client, { migrationsDir: join(fdeRoot(), "infra/db") });
    try {
      await store.migrate();
    } catch (e) {
      await pool.end().catch(() => undefined);
      throw e;
    }
    return { store, close: () => pool.end() };
  }
  const file = process.env.FDE_MEMORY_STORE_FILE ?? join(fdeRoot(), ".data/dev-store.json");
  return { store: createMemoryStore({ file }) };
}

export function getStore(): Promise<Store> {
  const rt = runtime();
  if (!rt.store) {
    rt.store = createStore().then(
      ({ store, close }) => {
        rt.closeStore = close;
        return store;
      },
      (e: unknown) => {
        // 创建失败(比如数据库连不上)不缓存,下次请求再试
        rt.store = undefined;
        throw e;
      },
    );
  }
  return rt.store;
}
