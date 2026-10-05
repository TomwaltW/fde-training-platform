import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // monorepo:把工作区根目录作为追踪根,standalone 产物才会带上 packages/*
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  // 引擎等工作区包直接以 TypeScript 源码发布
  transpilePackages: ["@fde/engine", "@fde/llm", "@fde/contracts", "@fde/store"],
  serverExternalPackages: ["pg", "@electric-sql/pglite", "nodemailer"],
  poweredByHeader: false,
};

export default config;
