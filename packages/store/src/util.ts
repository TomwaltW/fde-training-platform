// 两套实现共用的小工具。
import { randomInt } from "node:crypto";

/** 邀请码字符集:大写字母和数字,去掉易混的 0 O 1 I。 */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_LENGTH = 8;

export function randomInviteCode(): string {
  let s = "";
  for (let i = 0; i < INVITE_LENGTH; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return s;
}

/** 兑换码:12 位(字符集同邀请码),每 4 位一组。 */
export function randomRedeemCode(): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 任意时间表示(ISO 字符串、Date、数据库返回值)统一成 ISO 8601(UTC)。 */
export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" || typeof v === "number") return new Date(v).toISOString();
  throw new Error(`无法识别的时间值:${String(v)}`);
}

export function toIsoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : toIso(v);
}

/** 时间比较用毫秒数,避免 ISO 字符串格式差异(时区后缀、毫秒位数)导致比较出错。 */
export function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`无法识别的时间:${iso}`);
  return t;
}

/** 深拷贝成"存进去再读出来"的样子(和 JSONB 的行为一致:undefined 字段消失)。 */
export function jsonClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
