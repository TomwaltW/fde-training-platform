// 阿里云短信(Dysmsapi SendSms,RPC 风格)发登录验证码。不引 SDK:签名就是一次 HMAC-SHA1,Node 自带的 crypto 和 fetch 够用。
// 签名规则(阿里云 POP「RPC 签名机制」):
//   1. 公共参数 + 接口参数按参数名排序,名和值都按 POP 规则编码后用 = 和 & 连起来(规范化请求字符串);
//   2. StringToSign = "GET&" + 编码("/") + "&" + 编码(规范化请求字符串);
//   3. Signature = Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign)),作为 Signature 参数一起发出。
// 出错时的信息里只有阿里云返回的 Code 和(脱敏后的)Message,不会带上 AccessKey Secret、签名后的地址和完整手机号。
import { createHmac, randomUUID } from "node:crypto";
import type { SmsConfig } from "./env.ts";
import { maskPhone } from "./phone.ts";

export const SMS_API_VERSION = "2017-05-25";
export const SMS_REGION = "cn-hangzhou";
/** 阿里云接口 10 秒没响应就放弃。 */
export const SMS_TIMEOUT_MS = 10_000;

/**
 * POP 规则的百分号编码:只有 A–Z a–z 0–9 - _ . ~ 不编码,其余按 UTF-8 编成 %XY(大写)。
 * encodeURIComponent 不编码 ! ' ( ) *,这里补上;另外按规则把 + 换成 %20、%7E 换回 ~
 * (encodeURIComponent 本身不会产生这两种,留着是为了和规则逐条对应)。
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~")
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/** 规范化请求字符串:按参数名排序,编码后用 = 和 & 连接。 */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k]!)}`)
    .join("&");
}

/** RPC 签名(GET 请求)。 */
export function rpcSignature(params: Record<string, string>, accessKeySecret: string): string {
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonicalQuery(params))}`;
  return createHmac("sha1", `${accessKeySecret}&`).update(stringToSign, "utf8").digest("base64");
}

/** 时间戳:UTC 的 YYYY-MM-DDTHH:mm:ssZ(不带毫秒)。 */
export function rpcTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** "+8613812345678" → "13812345678"(阿里云国内短信的 PhoneNumbers 不带国家码)。 */
function nationalNumber(phone: string): string {
  return phone.replace(/^\+86/, "");
}

/** SendSms 的全部参数(不含 Signature)。 */
export function sendSmsParams(
  cfg: Pick<SmsConfig, "accessKeyId" | "signName" | "templateCode">,
  phone: string,
  code: string,
  opts: { now?: Date; nonce?: string } = {},
): Record<string, string> {
  return {
    AccessKeyId: cfg.accessKeyId,
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: nationalNumber(phone),
    RegionId: SMS_REGION,
    SignName: cfg.signName,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: opts.nonce ?? randomUUID(),
    SignatureVersion: "1.0",
    TemplateCode: cfg.templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: rpcTimestamp(opts.now ?? new Date()),
    Version: SMS_API_VERSION,
  };
}

/** 带签名的完整请求地址。 */
export function signedSendSmsUrl(cfg: SmsConfig, phone: string, code: string, opts: { now?: Date; nonce?: string } = {}): string {
  const params = sendSmsParams(cfg, phone, code, opts);
  const signature = rpcSignature(params, cfg.accessKeySecret);
  return `${cfg.endpoint.replace(/\/+$/, "")}/?Signature=${percentEncode(signature)}&${canonicalQuery(params)}`;
}

/** 短信没发出去。code 是阿里云返回的 Code(如 isv.BUSINESS_LIMIT_CONTROL),请求本身失败时是 TIMEOUT / NETWORK / HTTP_<状态码>。 */
export class SmsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SmsError";
  }
}

/** 阿里云的 Message 可能把收到的请求原样带回来(比如签名不对时),里面有手机号;脱敏、截短后再放进错误信息。 */
function scrub(text: string, cfg: SmsConfig, phone: string): string {
  const national = nationalNumber(phone);
  return text.split(cfg.accessKeySecret).join("***").split(national).join(maskPhone(phone)).slice(0, 300);
}

interface SendSmsResult {
  Code?: unknown;
  Message?: unknown;
  RequestId?: unknown;
  BizId?: unknown;
}

/**
 * 发一条登录验证码短信。阿里云返回 Code 为 "OK" 才算成功,否则抛 SmsError(信息里带 Code 和 Message)。
 * timeoutMs 只给测试用。返回阿里云的 BizId(查发送回执用)。
 */
export async function sendLoginSms(cfg: SmsConfig, phone: string, code: string, opts: { now?: Date; nonce?: string; timeoutMs?: number } = {}): Promise<string | null> {
  const url = signedSendSmsUrl(cfg, phone, code, opts);
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? SMS_TIMEOUT_MS), cache: "no-store" });
  } catch (e) {
    // 不把原始异常带出去:有的运行时会在信息里放请求地址(含签名和手机号)
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw timeout ? new SmsError("TIMEOUT", `阿里云短信接口 ${Math.round((opts.timeoutMs ?? SMS_TIMEOUT_MS) / 1000)} 秒内没有响应`) : new SmsError("NETWORK", "连不上阿里云短信接口");
  }
  const raw = await res.text().catch(() => "");
  let data: SendSmsResult | null = null;
  try {
    data = JSON.parse(raw) as SendSmsResult;
  } catch {
    data = null;
  }
  const apiCode = typeof data?.Code === "string" ? data.Code : null;
  if (apiCode === "OK" && res.ok) return typeof data?.BizId === "string" ? data.BizId : null;
  const message = typeof data?.Message === "string" ? data.Message : raw ? raw.slice(0, 200) : "(响应为空)";
  const requestId = typeof data?.RequestId === "string" ? `,RequestId ${data.RequestId}` : "";
  throw new SmsError(apiCode ?? `HTTP_${res.status}`, scrub(`阿里云短信发送失败:${apiCode ?? `HTTP ${res.status}`} ${message}${requestId}`, cfg, phone));
}
