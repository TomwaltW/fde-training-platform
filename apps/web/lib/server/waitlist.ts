// 候补名单(第三轮 F1;方案 5.2 W0「候补表单」、W5–W7「邀请/分批开放候补名单」):
// 公开登记的限频、管理页的名单与合计、按登记顺序或勾选发邀请码(有 SMTP 就发邀请邮件)、CSV 导出。
import { WAITLIST_ROLES, type AdminWaitlistResponse, type InviteWaitlistResponse, type Store, type WaitlistEntry, type WaitlistRole, type WaitlistRow } from "@fde/contracts";
import { siteUrl } from "./env.ts";
import { visitorIdFrom } from "./events.ts";
import { HttpError, nowIso } from "./http.ts";
import { sendMail } from "./mail.ts";

// ---------------------------------------------------------------- 登记限频

/** 同一访客 10 分钟内最多提交 5 次。 */
export const JOIN_WINDOW_MS = 10 * 60 * 1000;
export const JOIN_MAX_PER_WINDOW = 5;

const LIMITS_KEY = Symbol.for("fde.web.waitlist-join-limits");

/** 桶 → 窗口内每次提交的时间(毫秒)。放在 globalThis 上,开发模式热更新不清零(同 runtime.ts)。 */
function joinLimits(): Map<string, number[]> {
  const g = globalThis as unknown as Record<symbol, Map<string, number[]> | undefined>;
  return (g[LIMITS_KEY] ??= new Map());
}

/** 限频的桶:访客 cookie fde_vid;没有就按 x-forwarded-for 的第一段;都没有的算同一个桶。 */
export function joinBucket(req: Request): string {
  const vid = visitorIdFrom(req);
  if (vid) return `vid:${vid}`;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip ? `ip:${ip}` : "unknown";
}

/** 占一次提交名额,超了抛 429。占位是同步完成的,并发请求不会超额。 */
export function claimJoinSlot(bucket: string, now = Date.now()): void {
  const map = joinLimits();
  const recent = (map.get(bucket) ?? []).filter((t) => now - t < JOIN_WINDOW_MS);
  if (recent.length >= JOIN_MAX_PER_WINDOW) {
    map.set(bucket, recent);
    const minutes = Math.max(1, Math.ceil((JOIN_WINDOW_MS - (now - recent[0]!)) / 60_000));
    throw new HttpError("rate_limited", `提交太频繁了,请 ${minutes} 分钟后再试`);
  }
  recent.push(now);
  map.set(bucket, recent);
  // 顺手清理过期的桶,避免表无限增长
  if (map.size > 5000) for (const [k, ts] of map) if (ts.every((t) => now - t >= JOIN_WINDOW_MS)) map.delete(k);
}

// ---------------------------------------------------------------- 管理页的名单

/** 没有来源(不是从带 ?from= 的链接来的)在来源统计里的名字。 */
export const DIRECT_SOURCE = "(直接访问)";

export type WaitlistStatusFilter = "all" | "pending" | "invited";
export const WAITLIST_STATUS_FILTERS: readonly WaitlistStatusFilter[] = ["all", "pending", "invited"];

function isRole(r: string | null): r is WaitlistRole {
  return r !== null && (WAITLIST_ROLES as readonly string[]).includes(r);
}

/** 存储里的条目 → 接口里的行(带上"这个邮箱是否已经是用户")。 */
export async function waitlistRows(store: Store, entries: WaitlistEntry[]): Promise<WaitlistRow[]> {
  const users = await Promise.all(entries.map((e) => store.getUserByEmail(e.email)));
  return entries.map((e, i) => ({
    email: e.email,
    role: isRole(e.role) ? e.role : null,
    note: e.note,
    source: e.source,
    createdAt: e.createdAt,
    invitedAt: e.invitedAt,
    inviteCode: e.inviteCode,
    registered: users[i] !== null,
  }));
}

/** 合计与来源统计总是按全部名单算;status 只筛选 rows。rows 按登记时间从早到晚。 */
export async function adminWaitlist(store: Store, status: WaitlistStatusFilter = "all"): Promise<AdminWaitlistResponse> {
  const all = await waitlistRows(store, await store.listWaitlist());
  const sources = new Map<string, number>();
  for (const r of all) {
    const k = r.source ?? DIRECT_SOURCE;
    sources.set(k, (sources.get(k) ?? 0) + 1);
  }
  const bySource = [...sources]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return {
    total: all.length,
    invited: all.filter((r) => r.invitedAt !== null).length,
    registered: all.filter((r) => r.registered).length,
    bySource,
    rows: status === "all" ? all : all.filter((r) => (r.invitedAt !== null) === (status === "invited")),
  };
}

// ---------------------------------------------------------------- 发邀请码

/** 邀请邮件里的登录链接:登录页按 ?invite= 和 ?email= 预填(F4)。 */
export function inviteLink(inviteCode: string, email: string): string {
  return `${siteUrl()}/login?invite=${encodeURIComponent(inviteCode)}&email=${encodeURIComponent(email)}`;
}

export function inviteMail(email: string, inviteCode: string): { to: string; subject: string; text: string } {
  return {
    to: email,
    subject: `FDE 训练场邀请码:${inviteCode}`,
    text: [
      "你好,",
      "",
      "你之前登记了 FDE 训练场的候补名单,现在给你留了一个位置。",
      "",
      `邀请码:${inviteCode}(只能用一次)`,
      "",
      "打开下面的链接登录,邀请码和邮箱已经帮你填好:",
      inviteLink(inviteCode, email),
      "",
      "登录不用设密码,用这个邮箱收验证码就行。",
      "",
      "如果你没有登记过,忽略这封邮件即可。",
    ].join("\n"),
  };
}

/** 发一封邀请邮件;没配置 SMTP 返回 false。发送失败只打日志、返回 false,不影响其他人。 */
async function mailInvite(email: string, inviteCode: string): Promise<boolean> {
  try {
    return await sendMail(inviteMail(email, inviteCode));
  } catch (e) {
    console.error(`[waitlist] 给 ${email} 的邀请邮件发送失败`, e);
    return false;
  }
}

/** 同时最多发几封邮件(一次邀请几十人时别逐封等,也别一下子开几十个 SMTP 连接)。 */
const MAIL_CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * count:按登记时间取最早的 count 个还没邀请的;emails:只处理在名单里且还没邀请的(其他的跳过,不报错)。
 * 每人一个只能用一次的邀请码(备注「候补:<邮箱>」)并记到名单上,然后有 SMTP 就发邀请邮件。
 */
export async function inviteFromWaitlist(store: Store, body: { count?: number | undefined; emails?: string[] | undefined }): Promise<InviteWaitlistResponse> {
  let targets = await store.listWaitlist(body.count !== undefined ? { invited: false, limit: body.count } : { invited: false });
  if (body.emails) {
    const wanted = new Set(body.emails.map((e) => e.trim().toLowerCase()));
    targets = targets.filter((e) => wanted.has(e.email));
  }
  const issued: { email: string; inviteCode: string }[] = [];
  for (const { email } of targets) {
    const [inviteCode] = await store.createInvites(1, 1, `候补:${email}`);
    if (!inviteCode) throw new Error(`没能给 ${email} 生成邀请码`);
    await store.markWaitlistInvited(email, inviteCode, nowIso());
    issued.push({ email, inviteCode });
  }
  const mailed = await mapLimit(issued, MAIL_CONCURRENCY, (x) => mailInvite(x.email, x.inviteCode));
  return { invited: issued.map((x, i) => ({ ...x, mailed: mailed[i]! })) };
}

// ---------------------------------------------------------------- CSV 导出

export const CSV_COLUMNS = ["email", "role", "note", "source", "created_at", "invited_at", "invite_code", "registered"] as const;

/** 一个单元格:= + - @ 开头的前面加 '(防止 Excel 当公式执行);含逗号、引号、换行的加引号,引号写两遍(RFC 4180)。 */
export function csvCell(value: string | null): string {
  let v = value ?? "";
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** UTF-8 带 BOM(Excel 直接打开不乱码),行尾 CRLF。 */
export function waitlistCsv(rows: WaitlistRow[]): string {
  const lines = [
    CSV_COLUMNS.join(","),
    ...rows.map((r) => [r.email, r.role, r.note, r.source, r.createdAt, r.invitedAt, r.inviteCode, r.registered ? "true" : "false"].map(csvCell).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** waitlist-YYYYMMDD.csv,日期按北京时间。 */
export function waitlistCsvFilename(now = new Date()): string {
  const d = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  return `waitlist-${d}.csv`;
}
