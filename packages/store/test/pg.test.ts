import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPgStore } from "../src/index.ts";
import { runStoreConformance } from "./conformance.ts";

const migrationsDir = resolve(import.meta.dirname, "../../../infra/db");

runStoreConformance("pg (PGlite)", async () => {
  const db = new PGlite();
  const store = createPgStore({ query: (sql, params) => db.query(sql, params), exec: (sql) => db.exec(sql) }, { migrationsDir });
  return store;
});
