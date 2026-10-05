// Next.js 启动时执行一次(只在 Node 运行时)。生产环境在这里先连库并执行 infra/db/ 的迁移,
// 而不是等第一个请求:部署后马上就能在库里看到表,连不上库也会立刻在日志里看到。
// 失败只记日志、不阻止启动——/api/health 会一直报不健康,容器状态能看出来。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const { getStore } = await import("./lib/server/store.ts");
  try {
    await getStore();
    console.log("[startup] 存储已就绪(迁移已执行)");
  } catch (e) {
    console.error("[startup] 存储初始化失败,稍后的请求会重试", e);
  }
}
