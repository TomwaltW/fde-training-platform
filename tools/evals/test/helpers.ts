// 测试里起命令行子进程(pnpm playtest、pnpm session:export)用的环境变量:只给跑得起来的最少几个,不继承 process.env。
// 开发者 shell 里的模型 Key、DATABASE_URL、PGHOST/PGPASSWORD(pg 驱动会读)之类不会漏进子进程;
// 仓库根目录的 .env 由命令行的 --dotenv 避开(指到临时目录里的空文件),两样一起才能保证结果不随本机配置变。
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function cliEnv(vars: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...vars };
}

/** 在 dir 里写一个空的环境变量文件,传给 --dotenv。 */
export function emptyEnvFile(dir: string): string {
  const file = join(dir, "empty-env.txt");
  writeFileSync(file, "");
  return file;
}
