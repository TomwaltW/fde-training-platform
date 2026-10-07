// 按网页后端的约定找到对局存在哪里,只读打开(pnpm session:export、pnpm playtest 共用)。
// 约定照抄 apps/web/lib/server/store.ts 与 env.ts 的 fdeRoot(),两边改一边时另一边也要改:
//   有 DATABASE_URL → PostgreSQL;否则 → 内存库落盘文件 FDE_MEMORY_STORE_FILE,默认 <FDE_ROOT>/.data/dev-store.json。
// 不直接调网页的 getStore():它对 PostgreSQL 先跑 migrate(写库),fdeRoot() 又假定工作目录是 apps/web。
// `pnpm dev:web` 的工作目录是 apps/web,所以 FDE_ROOT 不设时是仓库根目录,相对路径(FDE_ROOT、FDE_MEMORY_STORE_FILE)
// 按 apps/web 解析——这里照做,两边才会指到同一个文件。
// 只读:内存库只在写方法里落盘,这里只拿读方法(SessionSource);PostgreSQL 的连接设成只读事务,也不跑 migrate。
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { SqlClient, Store } from "@fde/contracts";
import { createMemoryStore, createPgStore } from "@fde/store";

export type Env = Record<string, string | undefined>;

/** 导出要用的读方法。写方法拿不到,类型上就保证了不会改库。 */
export type SessionSource = Pick<Store, "listAllSessions" | "getSession" | "getUser" | "getReport" | "listLlmCalls">;

export type StoreTarget = { kind: "memory"; file: string } | { kind: "pg"; url: string };

/** 配置问题(文件不存在、路径不对):退出码 2。连不上库、文件坏了之类的运行时错误照常抛 Error。 */
export class SourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceConfigError";
  }
}

/** 网页后端 `pnpm dev:web` 的工作目录。 */
export const webDir = (repoRoot: string) => join(repoRoot, "apps/web");

const nonEmpty = (v: string | undefined) => (v?.trim() ? v : undefined);

/** 网页的 fdeRoot():FDE_ROOT(相对路径按 apps/web 解析),不设就是仓库根目录。 */
export function webFdeRoot(env: Env, repoRoot: string): string {
  const v = nonEmpty(env.FDE_ROOT);
  return v ? resolve(webDir(repoRoot), v) : repoRoot;
}

/** 内存库的默认落盘位置(不看 FDE_MEMORY_STORE_FILE)。 */
export const defaultStoreFile = (env: Env, repoRoot: string) => join(webFdeRoot(env, repoRoot), ".data/dev-store.json");

/**
 * 网页后端会用哪个库。和网页的一处不同:FDE_MEMORY_STORE_FILE 是空字符串时网页会退回纯内存(什么都不落盘,
 * 也就没有东西可导出),这里按没设处理、去读默认文件;pnpm playtest 会把这种情况改掉并提醒。
 */
export function webStoreTarget(env: Env, repoRoot: string): StoreTarget {
  const url = nonEmpty(env.DATABASE_URL);
  if (url) return { kind: "pg", url };
  const file = nonEmpty(env.FDE_MEMORY_STORE_FILE);
  return { kind: "memory", file: file ? resolve(webDir(repoRoot), file) : defaultStoreFile(env, repoRoot) };
}

/** 给人看的来源说明;PostgreSQL 只显示主机和库名,不显示用户名和密码。 */
export function describeTarget(t: StoreTarget): string {
  if (t.kind === "memory") return `内存库 ${t.file}`;
  try {
    const u = new URL(t.url);
    const db = u.pathname.replace(/^\//, "");
    return `PostgreSQL ${u.hostname}${u.port ? `:${u.port}` : ""}${db ? `/${db}` : ""}`;
  } catch {
    return "PostgreSQL(DATABASE_URL)";
  }
}

/** 把这个连接设成只读:之后的事务一律只读,误调写方法时数据库直接拒绝。 */
export async function makeReadOnly(sql: SqlClient): Promise<SqlClient> {
  await sql.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  return sql;
}

export interface OpenedSource {
  source: SessionSource;
  close(): Promise<void>;
}

/** 只读打开。内存库文件不存在抛 SourceConfigError;文件坏了、连不上数据库抛普通 Error。 */
export async function openSessionSource(t: StoreTarget, repoRoot: string): Promise<OpenedSource> {
  if (t.kind === "memory") {
    if (!isAbsolute(t.file)) throw new SourceConfigError(`内存库路径必须是绝对路径:${t.file}`);
    if (!existsSync(t.file)) {
      throw new SourceConfigError(
        `找不到内存库文件 ${t.file}:还没在这里玩过,或者网页用的是别的 FDE_MEMORY_STORE_FILE / FDE_ROOT / DATABASE_URL` +
          `(pnpm playtest 启动时会打印对局存在哪;也可以用 --store-file 直接指定文件)`,
      );
    }
    const store = createMemoryStore({ file: t.file });
    return { source: store, close: () => store.close() };
  }
  // 命令行只需要一条连接;连上之后先设只读,再交给 PgStore。和网页一样,用到 PostgreSQL 时才加载驱动
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: t.url });
  await client.connect();
  try {
    const sql = await makeReadOnly({
      async query<T>(text: string, params?: unknown[]) {
        const r = await client.query(text, params);
        return { rows: r.rows as T[] };
      },
    });
    const store = createPgStore(sql, { migrationsDir: join(repoRoot, "infra/db") });
    return { source: store, close: () => client.end() };
  } catch (e) {
    await client.end().catch(() => undefined);
    throw e;
  }
}
