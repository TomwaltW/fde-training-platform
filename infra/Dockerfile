# FDE 训练平台应用镜像:Next.js standalone 产物 + 运行时要读的场景、模型配置和建表脚本。
#
# 构建上下文是仓库根目录(compose 里已经配好):
#   ./infra/compose.sh build app
# 国内拉镜像、装依赖慢:见 docs/deploy.md「镜像加速」。
#   NODE_IMAGE    换成自己 ACR 仓库里的同版本 Node 22 镜像
#   NPM_REGISTRY  换成 https://registry.npmmirror.com(corepack 下载 pnpm 和 pnpm 装依赖都走它)
# 故意不写 "# syntax=docker/dockerfile:1":那会多从 Docker Hub 拉一个前端镜像,国内容易卡住;
# 下面用到的 RUN --mount=type=cache 是 Docker 23+ 内置 BuildKit 就支持的。

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- 构建阶段
FROM ${NODE_IMAGE} AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_registry=${NPM_REGISTRY} \
    npm_config_store_dir=/pnpm/store \
    NEXT_TELEMETRY_DISABLED=1

# pnpm 版本由根 package.json 的 packageManager 字段固定(pnpm 10)
RUN corepack enable pnpm

WORKDIR /repo

# 工作区清单与锁文件。pnpm-workspace.yaml 里的每个项目(packages/*、apps/*、tools/evals)都要在,
# 否则 --frozen-lockfile 会因为锁文件对不上而失败。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools/evals ./tools/evals
# 运行时数据:场景(含资料文件)、模型配置、建表脚本。构建时也一并带上,避免页面预渲染时找不到。
COPY scenarios ./scenarios
COPY config ./config
COPY infra/db ./infra/db

# 依赖缓存在 BuildKit 缓存卷里,源码变了也不用重新下载
RUN --mount=type=cache,id=fde-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# next.config.ts 里 output: "standalone",outputFileTracingRoot 是仓库根目录,
# 所以产物是 apps/web/.next/standalone/{apps/web/server.js, node_modules, ...}
RUN pnpm build:web

# ---------------------------------------------------------------- 运行阶段
FROM ${NODE_IMAGE} AS runtime

# HOSTNAME=0.0.0.0:standalone 的 server.js 默认只听 HOSTNAME,容器里必须听所有网卡,
# 否则 Caddy 和健康检查都连不上。FDE_ROOT 指向下面放 scenarios/ config/ infra/db 的目录。
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    FDE_ROOT=/app

WORKDIR /app

# standalone 只带服务端代码和追踪到的 node_modules;静态资源和 public 要自己拷。
# .next 归 node 用户所有:Next 运行时会往 .next/cache 写图片优化缓存。
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# 协议与隐私政策 Markdown(/legal/[slug] 读取;server.js 启动时会 chdir 到 apps/web)
COPY --from=build /repo/apps/web/content ./apps/web/content
# 运行时要读的文件,只读即可
COPY --from=build /repo/scenarios ./scenarios
COPY --from=build /repo/config ./config
COPY --from=build /repo/infra/db ./infra/db

# 官方 Node 镜像自带的非 root 用户(uid 1000)
USER node

EXPOSE 3000

# 镜像里没有 curl,用 Node 22 自带的 fetch 请求 /api/site(不需要登录、不碰模型)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/site').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "apps/web/server.js"]
