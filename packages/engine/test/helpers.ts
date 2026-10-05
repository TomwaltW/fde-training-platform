import { resolve } from "node:path";
import { loadScenario } from "../src/index.ts";

export const ROOT = resolve(import.meta.dirname, "../../..");
export const SCN_DIR = resolve(ROOT, "scenarios/freight-docs");
export const scn = loadScenario(SCN_DIR);
