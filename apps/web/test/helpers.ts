// 测试工具:直接调用路由函数(不起服务),用一个带 cookie 的小客户端模拟浏览器。
import type { ApiError, ErrorCode } from "@fde/contracts";

type Params = Record<string, string>;
type Handler = (req: Request, ctx: { params: Promise<never> }) => Promise<Response>;

export interface CallResult<T> {
  status: number;
  body: T;
  res: Response;
}

export interface CallOptions {
  path?: string;
  body?: unknown;
  /** 原样作为请求体发送(测试非法 JSON)。 */
  rawBody?: string;
  params?: Params;
}

export class Client {
  cookie: string | undefined;

  constructor(cookie?: string) {
    this.cookie = cookie;
  }

  async call<T = unknown>(method: string, handler: unknown, opts: CallOptions = {}): Promise<CallResult<T>> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) body = JSON.stringify(opts.body);
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`http://localhost${opts.path ?? "/api/test"}`, { method, headers, body });
    const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) as Promise<never> });
    // 登录接口会写 cookie;退出登录时 Max-Age=0 清掉
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = /^fde_session=([^;]*)/.exec(setCookie);
      if (m) this.cookie = m[1] && !/Max-Age=0\b/.test(setCookie) ? `fde_session=${m[1]}` : undefined;
    }
    const type = res.headers.get("content-type") ?? "";
    const parsed = type.includes("application/json") ? ((await res.clone().json()) as T) : (undefined as T);
    return { status: res.status, body: parsed, res };
  }

  get<T = unknown>(handler: unknown, opts: CallOptions = {}) {
    return this.call<T>("GET", handler, opts);
  }

  post<T = unknown>(handler: unknown, opts: CallOptions = {}) {
    return this.call<T>("POST", handler, opts);
  }

  del<T = unknown>(handler: unknown, opts: CallOptions = {}) {
    return this.call<T>("DELETE", handler, opts);
  }
}

/** 断言是某个错误码的 ApiError。 */
export function errorCode(r: CallResult<unknown>): ErrorCode | undefined {
  return (r.body as ApiError | undefined)?.error?.code;
}
