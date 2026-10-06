// 邀请码 + 验证码登录:邮箱收邮件验证码;第三轮起也可以用手机号收短信验证码(配置了阿里云短信,或开发模式)。
import { randomInt } from "node:crypto";
import type { RequestCodeResponse, User } from "@fde/contracts";
import { secretHash } from "./auth.ts";
import { devLoginCodes, isAdminEmail, smsConfig, smsDailyPerPhone, smsHourlyLimit, smsLoginEnabled } from "./env.ts";
import { recordEvent } from "./events.ts";
import { HttpError } from "./http.ts";
import { sendLoginCodeMail } from "./mail.ts";
import { maskPhone } from "./phone.ts";
import { LIMITS, allow, allowDistinct, wouldAllow } from "./ratelimit.ts";
import { runtime } from "./runtime.ts";
import { sendLoginSms } from "./sms.ts";
import { getStore } from "./store.ts";

export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_REQUEST_INTERVAL_MS = 60 * 1000;

/** 登录地址:统一小写的邮箱,或 "+86" 开头的手机号(都已经由 schemas.ts 规范化)。 */
export type LoginAddress = { kind: "email"; email: string } | { kind: "phone"; phone: string };

/** 请求体里的 email / phone(二选一,schemas.ts 已校验)转成登录地址;手机号登录没开时 400。 */
export function loginAddress(body: { email?: string | undefined; phone?: string | undefined }): LoginAddress {
  if (body.phone !== undefined) {
    if (!smsLoginEnabled()) throw new HttpError("bad_request", "暂不支持手机号登录");
    return { kind: "phone", phone: body.phone };
  }
  if (body.email !== undefined) return { kind: "email", email: body.email };
  throw new HttpError("bad_request", "邮箱和手机号填一个");
}

/** 验证码、限频都按这个键:邮箱本身或 "+86…"(两者不会重合:邮箱一定含 @)。 */
function addressKey(a: LoginAddress): string {
  return a.kind === "email" ? a.email : a.phone;
}

/** 写日志用:手机号一律脱敏。 */
function addressForLog(a: LoginAddress): string {
  return a.kind === "email" ? a.email : maskPhone(a.phone);
}

/** 同一地址 60 秒内只能请求一次(邮箱和手机号共用)。占位是同步完成的,并发的第二个请求一定会被挡住。 */
function claimRequestSlot(key: string, now: number): () => void {
  const map = runtime().codeRequests;
  const last = map.get(key);
  if (last !== undefined && now - last < CODE_REQUEST_INTERVAL_MS) {
    const wait = Math.ceil((CODE_REQUEST_INTERVAL_MS - (now - last)) / 1000);
    throw new HttpError("rate_limited", `验证码请求太频繁,请 ${wait} 秒后再试`);
  }
  // 顺手清理过期记录,避免表无限增长
  if (map.size > 1000) for (const [k, t] of map) if (now - t >= CODE_REQUEST_INTERVAL_MS) map.delete(k);
  map.set(key, now);
  // 请求失败(邀请码无效、发信或发短信失败)时退回名额,不让用户白等 60 秒
  return () => {
    if (map.get(key) === now) map.delete(key);
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 北京时间(UTC+8)的日期 YYYY-MM-DD:同一手机号的每日条数按这个自然日算。 */
function beijingDate(now: number): string {
  return new Date(now + 8 * HOUR_MS).toISOString().slice(0, 10);
}

/**
 * 短信的两道防刷(进程内计数,单实例部署够用):同一手机号每个北京时间自然日 SMS_DAILY_PER_PHONE 条,
 * 全站每小时(滑动窗口)SMS_HOURLY_LIMIT 条。先查单个手机号:已经用完当天条数的号码不会再占全站名额。
 * 记的是"发出去的请求",发送失败不退(阿里云那边可能已经计了它自己的流控)。
 */
function takeSmsQuota(phone: string, now: number): void {
  // 键里带上日期:过了北京时间零点自动换一个桶
  const dayKey = `${phone}|${beijingDate(now)}`;
  // 两道额度先都只看不记,都没超才一起记:全站额度满了时不能白白扣掉这个号码当天的条数(没发出短信)
  if (!wouldAllow("sms:phone-day", dayKey, smsDailyPerPhone(), DAY_MS, now)) {
    throw new HttpError("rate_limited", "这个手机号今天收验证码的次数用完了,明天再试,或者改用邮箱登录");
  }
  if (!wouldAllow("sms:site-hour", "all", smsHourlyLimit(), HOUR_MS, now)) {
    throw new HttpError("rate_limited", "短信验证码发送太频繁,请过一会儿再试,或者改用邮箱登录");
  }
  allow("sms:phone-day", dayKey, smsDailyPerPhone(), DAY_MS, now);
  allow("sms:site-hour", "all", smsHourlyLimit(), HOUR_MS, now);
}

const INVITE_INVALID = "邀请码无效或已用完";

async function findUser(a: LoginAddress): Promise<User | null> {
  const store = await getStore();
  return a.kind === "email" ? store.getUserByEmail(a.email) : store.getUserByPhone(a.phone);
}

/** 管理员豁免只看邮箱(ADMIN_EMAILS);手机号没有豁免。 */
function exemptFromInvite(a: LoginAddress): boolean {
  return a.kind === "email" && isAdminEmail(a.email);
}

/**
 * 请求验证码时:新地址必须带一个还能用的邀请码(只核对,不消耗);老用户不需要。
 * 例外:ADMIN_EMAILS 里的邮箱首次登录不需要邀请码(否则没有人能生成第一批邀请码)。
 */
async function assertMayRequest(a: LoginAddress, inviteCode: string | null | undefined): Promise<void> {
  if (await findUser(a)) return;
  if (exemptFromInvite(a)) return;
  const store = await getStore();
  if (!inviteCode || !((await store.inviteAvailable(inviteCode)) || (await unusedRedeemCode(inviteCode)))) {
    throw new HttpError("invite_invalid", INVITE_INVALID);
  }
  // 邀请码在验证通过时才消耗;这之前同一个码每小时最多给几个新地址发验证码,免得被拿来批量发信
  const { limit, windowMs } = LIMITS.requestCodePerInvite;
  if (!allowDistinct("request-code:invite", inviteCode, addressKey(a), limit, windowMs)) {
    throw new HttpError("rate_limited", "这个邀请码请求验证码太频繁了,请过一会儿再试");
  }
}

/**
 * 验证码校验通过后:老用户直接返回;新用户此时才消耗邀请码并建用户(consentAt=null)。
 * 这样输错地址、没收到验证码都不会白白用掉一次性邀请码,也不会给没验证过的地址建账号。
 */
async function findOrCreateVerifiedUser(a: LoginAddress, inviteCode: string | null | undefined): Promise<User> {
  const existing = await findUser(a);
  if (existing) return existing;
  const store = await getStore();
  /** 用兑换码代替邀请码注册时,建好用户后把这个码兑换给他。 */
  let redeemAfter: string | null = null;
  if (!exemptFromInvite(a)) {
    if (!inviteCode) throw new HttpError("invite_invalid", INVITE_INVALID);
    if (!(await store.redeemInvite(inviteCode))) {
      if (!(await unusedRedeemCode(inviteCode))) throw new HttpError("invite_invalid", "邀请码已经用完了,请向发给你邀请码的人再要一个");
      redeemAfter = inviteCode;
    }
  }
  let user: User;
  try {
    user = a.kind === "email" ? await store.createUser(a.email) : await store.createUserByPhone(a.phone);
  } catch (e) {
    // 同一个新地址的并发请求:另一个请求已经建好了用户
    const again = await findUser(a);
    if (again) return again;
    throw e;
  }
  if (redeemAfter) {
    const row = await store.redeemCode(redeemAfter, user.id, new Date().toISOString());
    if (row) await recordEvent({ type: "code_redeemed", userId: user.id, props: { productId: row.productId, atSignup: true } });
    // 极少数情况:验证这几百毫秒里码被别人抢先兑换了。账号照样建好(他确实拿着一个有效的码来的),记一笔日志
    else console.warn(`[auth] ${addressForLog(a)} 用兑换码注册时,这个码刚被别人兑换`);
  }
  return user;
}

/**
 * 买了兑换码、还没有账号的人(方案 7.3:在第三方平台买码)没有邀请码:第一次登录时可以用一个还没兑换的兑换码
 * 代替邀请码,注册成功的同时把这个码兑换给他。邀请码(8 位)和兑换码(12 位)长度不同,不会混。
 */
async function unusedRedeemCode(code: string): Promise<boolean> {
  const r = await (await getStore()).getRedeemCode(code);
  return r !== null && r.redeemedAt === null;
}

/** 把验证码发出去。返回是否真的发出(没配置 SMTP 时邮件不发)。手机号:配置了短信就发,没配置(只可能是开发模式)不发。 */
async function deliverCode(a: LoginAddress, code: string): Promise<boolean> {
  if (a.kind === "email") return sendLoginCodeMail(a.email, code);
  const cfg = smsConfig();
  if (!cfg) return false;
  try {
    await sendLoginSms(cfg, a.phone, code);
    return true;
  } catch (e) {
    // sms.ts 的错误信息里只有阿里云的 Code 和脱敏后的 Message;这里再只记脱敏的手机号
    console.error(`[auth] 给 ${maskPhone(a.phone)} 发验证码短信失败:${e instanceof Error ? e.message : "未知错误"}`);
    throw new HttpError("internal", "验证码短信没有发出去,请稍后再试,或者改用邮箱登录");
  }
}

export async function requestLoginCode(a: LoginAddress, inviteCode: string | null | undefined): Promise<RequestCodeResponse> {
  const now = Date.now();
  const key = addressKey(a);
  const release = claimRequestSlot(key, now);
  try {
    await assertMayRequest(a, inviteCode);
    if (a.kind === "phone") takeSmsQuota(a.phone, now);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const store = await getStore();
    await store.saveLoginCode(key, secretHash(code), new Date(now + LOGIN_CODE_TTL_MS).toISOString());
    const sent = await deliverCode(a, code);
    const res: RequestCodeResponse = { ok: true };
    if (devLoginCodes()) {
      console.log(`[auth] ${addressForLog(a)} 的登录验证码:${code}`);
      res.devCode = code;
    } else if (!sent) {
      console.warn(`[auth] 没有配置 ${a.kind === "email" ? "SMTP_URL" : "阿里云短信"},${addressForLog(a)} 的验证码没有发出`);
    }
    return res;
  } catch (e) {
    release();
    throw e;
  }
}

/** 校验验证码;失败抛 400 code_invalid。成功返回用户(新用户此时才消耗邀请码、建用户;邀请码用完了抛 400 invite_invalid)。 */
export async function verifyLoginCode(a: LoginAddress, code: string, inviteCode?: string | null): Promise<User> {
  const store = await getStore();
  const ok = await store.verifyLoginCode(addressKey(a), secretHash(code), new Date().toISOString());
  if (!ok) throw new HttpError("code_invalid", "验证码错误或已过期");
  return findOrCreateVerifiedUser(a, inviteCode);
}
