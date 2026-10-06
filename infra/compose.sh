#!/usr/bin/env bash
# docker compose 的包装:在任何目录下都能用,自动带上仓库根目录的 .env。
#
# 为什么需要它:compose 默认在 compose 文件所在目录(infra/)找 .env 做 ${POSTGRES_PASSWORD} 这类变量替换,
# 而我们的 .env 放在仓库根目录(和本地开发共用一份)。直接 docker compose -f infra/docker-compose.yml
# 会读不到密码。
#
# 用法(参数原样传给 docker compose):
#   ./infra/compose.sh up -d --build
#   ./infra/compose.sh ps
#   ./infra/compose.sh logs -f --tail=200 app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/infra/docker-compose.yml"

if [[ -f "$ENV_FILE" ]]; then
  exec docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
fi

# 没有 .env:只允许做不需要密码的事(比如 config 检查语法),起服务前必须先填好 .env
case "${1:-}" in
  up | create | run | start | restart)
    echo "找不到 $ENV_FILE。先执行:cp .env.example .env,按 docs/deploy.md 填好再启动。" >&2
    exit 1
    ;;
esac
exec docker compose -f "$COMPOSE_FILE" "$@"
