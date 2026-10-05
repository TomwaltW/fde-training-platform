// 接口的公共部分:错误响应、JSON 响应、请求体校验、统一异常处理。
import { ERROR_STATUS, SessionBusyError, VersionConflictError, type ApiError, type ErrorCode } from "@fde/contracts";
import type { z } from "zod";

/** 路由里抛出,由 handle() 转成 ApiError 响应。 */
export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const MESSAGES = {
  unauthorized: "请先登录",
  forbidden: "没有权限",
  consent_required: "请先阅读并同意用户协议与隐私政策",
  session_busy: "上一个请求还在处理中,请稍等",
  session_ended: "这一局已经结束了",
  internal: "服务器出错了,请稍后再试",
} as const;

/** API 响应一律不缓存(都和登录用户有关)。 */
const NO_STORE = { "cache-control": "no-store" };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export function errorResponse(code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, ERROR_STATUS[code], headers);
}

/** 锁忙或版本冲突。按 name 兜底:打包后若契约模块被加载多份,instanceof 会失灵。 */
function isBusy(e: unknown): boolean {
  if (e instanceof SessionBusyError || e instanceof VersionConflictError) return true;
  const name = e instanceof Error ? e.name : "";
  return name === "SessionBusyError" || name === "VersionConflictError";
}

/** 统一异常处理:已知错误按错误码返回;其他异常记日志(带堆栈),响应里只给 500 internal。 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.code, e.message);
    if (isBusy(e)) return errorResponse("session_busy", MESSAGES.session_busy);
    console.error("[api] 未处理的异常", e);
    return errorResponse("internal", MESSAGES.internal);
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "请求体"}:${i.message}`)
    .join(";");
}

/** 读 JSON 请求体并校验;不合法抛 400 bad_request。 */
export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError("bad_request", "请求体不是合法的 JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError("bad_request", `请求格式不对:${describeIssues(r.error)}`);
  return r.data;
}

export function nowIso(): string {
  return new Date().toISOString();
}
