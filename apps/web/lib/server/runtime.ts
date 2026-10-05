// 服务端单例的容器:存储、场景与引擎、模型网关、验证码请求频率。
// 放在 globalThis 上,开发模式热更新重新执行模块时不会重复创建;测试里用 resetForTests() 清空。
import type { Store } from "@fde/contracts";
import type { Engine, LoadedScenario } from "@fde/engine";
import type { Transporter } from "nodemailer";

export interface ScenarioEntry {
  scn: LoadedScenario;
  engine: Engine;
}

export interface ServerRuntime {
  /** 正在创建或已创建的存储(PgStore 要先 migrate,所以是 Promise)。 */
  store?: Promise<Store>;
  /** 关闭存储底层连接(pg.Pool.end)。 */
  closeStore?: () => Promise<void>;
  /** 场景 id → 场景与引擎(每个场景一个 Engine,进程内复用)。 */
  scenarios?: Map<string, ScenarioEntry>;
  /** 邮箱 → 上次请求验证码的时间(毫秒),用于 60 秒限频。 */
  codeRequests: Map<string, number>;
  /** 发信器,按 SMTP_URL 缓存。 */
  mailer?: { url: string; transport: Transporter };
}

const KEY = Symbol.for("fde.web.server-runtime");

export function runtime(): ServerRuntime {
  const g = globalThis as unknown as Record<symbol, ServerRuntime | undefined>;
  return (g[KEY] ??= { codeRequests: new Map() });
}

/** 测试用:关闭并丢弃所有单例,下次访问时按当前环境变量重新创建。 */
export async function resetForTests(): Promise<void> {
  const rt = runtime();
  const store = rt.store;
  const closeStore = rt.closeStore;
  rt.store = undefined;
  rt.closeStore = undefined;
  rt.scenarios = undefined;
  rt.mailer = undefined;
  rt.codeRequests.clear();
  if (store) await (await store.catch(() => undefined))?.close();
  if (closeStore) await closeStore();
}
