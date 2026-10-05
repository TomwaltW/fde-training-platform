// T1 实现。T0 只放签名:两套实现都必须通过 packages/store/test/conformance.ts。
import type { SqlClient, Store } from "@fde/contracts";

export interface MemoryStoreOptions {
  /** 给出时把全部数据落盘成这个 JSON 文件(本地开发重启不丢);不给就纯内存。 */
  file?: string;
}

export function createMemoryStore(_opts: MemoryStoreOptions = {}): Store {
  throw new Error("NotImplemented: createMemoryStore(T1)");
}

export interface PgStoreOptions {
  /** 迁移脚本目录(infra/db),按文件名排序执行 *.sql,已执行的记在 schema_migrations。 */
  migrationsDir: string;
}

export function createPgStore(_client: SqlClient, _opts: PgStoreOptions): Store {
  throw new Error("NotImplemented: createPgStore(T1)");
}
