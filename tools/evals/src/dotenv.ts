// pnpm playtest、pnpm session:export 读环境变量文件:默认仓库根目录的 .env(没有就跳过,和 pnpm play、pnpm calibrate --live 一样);
// --dotenv <文件> 换成别的文件。测试靠它避开开发者自己的 .env(里面可能有真的 Key、DATABASE_URL),结果不随本机配置变。
// 已经设了的环境变量不会被文件覆盖,空字符串也算设了(命令行上临时给的优先)。
// 不叫 --env-file:Node 24 会把脚本后面的 --env-file 也当成自己的参数去找文件,找不到直接退出 9,轮不到这里报错。
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** 读进 process.env。--dotenv 给了却不是个文件时返回错误说明(调用方按参数错误退出 2),否则返回 undefined。 */
export function loadDotenv(repoRoot: string, cwd: string, arg: string | undefined): string | undefined {
  if (arg === undefined) {
    const file = join(repoRoot, ".env");
    if (existsSync(file)) process.loadEnvFile(file);
    return undefined;
  }
  const file = resolve(cwd, arg);
  if (!existsSync(file) || !statSync(file).isFile()) return `找不到 --dotenv 指定的文件:${file}`;
  process.loadEnvFile(file);
  return undefined;
}
