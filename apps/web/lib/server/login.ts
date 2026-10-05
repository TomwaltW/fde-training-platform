// 邀请码 + 邮箱验证码登录。
import { randomInt } from "node:crypto";
import type { RequestCodeResponse, User } from "@fde/contracts";
import { secretHash } from "./auth.ts";
import { devLoginCodes, isAdminEmail } from "./env.ts";
import { HttpError } from "./http.ts";
import { sendLoginCodeMail } from "./mail.ts";
import { runtime } from "./runtime.ts";
import { getStore } from "./store.ts";

export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_REQUEST_INTERVAL_MS = 60 * 1000;

/** 同一邮箱 60 秒内只能请求一次。占位是同步完成的,并发的第二个请求一定会被挡住。 */
function claimRequestSlot(email: string, now: number): () => void {
  const map = runtime().codeRequests;
  const last = map.get(email);
  if (last !== undefined && now - last < CODE_REQUEST_INTERVAL_MS) {
    const wait = Math.ceil((CODE_REQUEST_INTERVAL_MS - (now - last)) / 1000);
    throw new HttpError("rate_limited", `验证码请求太频繁,请 ${wait} 秒后再试`);
  }
  // 顺手清理过期记录,避免表无限增长
  if (map.size > 1000) for (const [k, t] of map) if (now - t >= CODE_REQUEST_INTERVAL_MS) map.delete(k);
  map.set(email, now);
  // 请求失败(邀请码无效、发信失败)时退回名额,不让用户白等 60 秒
  return () => {
    if (map.get(email) === now) map.delete(email);
  };
}

const INVITE_INVALID = "邀请码无效或已用完";

/**
 * 请求验证码时:新邮箱必须带一个还能用的邀请码(只核对,不消耗);老用户不需要。
 * 例外:ADMIN_EMAILS 里的邮箱首次登录不需要邀请码(否则没有人能生成第一批邀请码)。
 */
async function assertMayRequest(email: string, inviteCode: string | null | undefined): Promise<void> {
  const store = await getStore();
  if (await store.getUserByEmail(email)) return;
  if (isAdminEmail(email)) return;
  if (!inviteCode || !(await store.inviteAvailable(inviteCode))) throw new HttpError("invite_invalid", INVITE_INVALID);
}

/**
 * 验证码校验通过后:老用户直接返回;新用户此时才消耗邀请码并建用户(consentAt=null)。
 * 这样输错邮箱、没收到验证码都不会白白用掉一次性邀请码,也不会给没验证过的邮箱建账号。
 */
async function findOrCreateVerifiedUser(email: string, inviteCode: string | null | undefined): Promise<User> {
  const store = await getStore();
  const existing = await store.getUserByEmail(email);
  if (existing) return existing;
  if (!isAdminEmail(email)) {
    if (!inviteCode || !(await store.redeemInvite(inviteCode))) throw new HttpError("invite_invalid", "邀请码已经用完了,请向发给你邀请码的人再要一个");
  }
  try {
    return await store.createUser(email);
  } catch (e) {
    // 同一个新邮箱的并发请求:另一个请求已经建好了用户
    const again = await store.getUserByEmail(email);
    if (again) return again;
    throw e;
  }
}

export async function requestLoginCode(email: string, inviteCode: string | null | undefined): Promise<RequestCodeResponse> {
  const now = Date.now();
  const release = claimRequestSlot(email, now);
  try {
    await assertMayRequest(email, inviteCode);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const store = await getStore();
    await store.saveLoginCode(email, secretHash(code), new Date(now + LOGIN_CODE_TTL_MS).toISOString());
    const sent = await sendLoginCodeMail(email, code);
    const res: RequestCodeResponse = { ok: true };
    if (devLoginCodes()) {
      console.log(`[auth] ${email} 的登录验证码:${code}`);
      res.devCode = code;
    } else if (!sent) {
      console.warn(`[auth] 没有配置 SMTP_URL,${email} 的验证码没有发出`);
    }
    return res;
  } catch (e) {
    release();
    throw e;
  }
}

/** 校验验证码;失败抛 400 code_invalid。成功返回用户(新用户此时才消耗邀请码、建用户;邀请码用完了抛 400 invite_invalid)。 */
export async function verifyLoginCode(email: string, code: string, inviteCode?: string | null): Promise<User> {
  const store = await getStore();
  const ok = await store.verifyLoginCode(email, secretHash(code), new Date().toISOString());
  if (!ok) throw new HttpError("code_invalid", "验证码错误或已过期");
  return findOrCreateVerifiedUser(email, inviteCode);
}
