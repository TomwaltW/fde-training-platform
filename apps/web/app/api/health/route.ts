// GET /api/health —— 就绪检查(Docker HEALTHCHECK 用,不需要登录)。真的连一次库(首次会执行迁移),
// 生产环境再确认 FDE_AUTH_SECRET 已设置;任何一项不行都返回 500,容器显示 unhealthy。
// 只返回 ok 或笼统的错误,具体原因写进服务端日志,不对外暴露。
import { authSecret, isProduction } from "../../../lib/server/env.ts";
import { errorResponse, json } from "../../../lib/server/http.ts";
import { getStore } from "../../../lib/server/store.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (isProduction()) authSecret();
    const store = await getStore();
    await store.countUsers();
    return json({ ok: true });
  } catch (e) {
    console.error("[health] 就绪检查失败", e);
    return errorResponse("internal", "服务还没就绪");
  }
}
