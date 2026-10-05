import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "../src/index.ts";
import { runStoreConformance } from "./conformance.ts";

runStoreConformance("memory", async () => createMemoryStore());
runStoreConformance("memory (file)", async () => createMemoryStore({ file: join(mkdtempSync(join(tmpdir(), "fde-store-")), "db.json") }));
