// 输入预处理:长度上限、违禁词。线上还要叠加模型平台自带的输入输出审核(方案 2.2)。
// 违禁词表不进仓库,运行时从文件加载(每行一个词);这里只放几个占位词保证流程能测。
import { existsSync, readFileSync } from "node:fs";

export const MAX_INPUT_CHARS = 500;

export interface ModerationResult {
  ok: boolean;
  reason?: "empty" | "too_long" | "banned";
  detail?: string;
}

export class Moderation {
  private words: string[];
  constructor(words: string[] = DEFAULT_WORDS) {
    this.words = words.filter(Boolean);
  }

  static fromFile(path: string | undefined): Moderation {
    if (!path || !existsSync(path)) return new Moderation();
    const words = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((w) => w.trim())
      .filter((w) => w && !w.startsWith("#"));
    return new Moderation([...DEFAULT_WORDS, ...words]);
  }

  check(text: string): ModerationResult {
    const t = text.trim();
    if (!t) return { ok: false, reason: "empty" };
    if ([...t].length > MAX_INPUT_CHARS) return { ok: false, reason: "too_long", detail: `${[...t].length} 字` };
    const hit = this.words.find((w) => t.includes(w));
    if (hit) return { ok: false, reason: "banned", detail: hit };
    return { ok: true };
  }
}

const DEFAULT_WORDS = ["傻逼", "去死", "操你"];
