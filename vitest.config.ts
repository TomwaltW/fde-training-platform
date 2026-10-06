import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "tools/evals/test/**/*.test.ts",
      "apps/web/test/**/*.test.ts",
      "infra/test/**/*.test.ts",
    ],
    // PGlite(WASM 版 PostgreSQL)每个用例都要冷启动一次,机器忙的时候 5 秒的默认超时不够
    testTimeout: 30_000,
  },
});
