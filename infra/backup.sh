#!/usr/bin/env bash
# 每日数据库备份(方案 2.2):pg_dump | gzip → 本地目录;配置了 OSS_* 时用 ossutil 上传到 OSS;本地保留 14 天。
#
# 用法:
#   ./infra/backup.sh                 # 手动备份一次(升级前建议先跑)
#   BACKUP_DIR=/data/backup ./infra/backup.sh
#
# crontab 示例(root 执行 crontab -e;ECS 默认时区是北京时间,下面是每天 03:17)。
# cron 的默认 PATH 里没有 /usr/local/bin(ossutil 一般装在那里),所以先写一行 PATH:
#   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
#   17 3 * * * /opt/fde/infra/backup.sh >> /var/log/fde-backup.log 2>&1
#
# 依赖:docker compose(经 infra/compose.sh)、gzip;上传 OSS 需要 ossutil 2.0(安装见 docs/deploy.md)。
# OSS 相关变量从仓库根目录 .env 读取(也可以直接在环境变量里给):
#   OSS_BUCKET OSS_ENDPOINT OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET
# 恢复步骤见 docs/deploy.md「从备份恢复」。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
COMPOSE="$ROOT/infra/compose.sh"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/.data/backups}"   # .data/ 已在 .gitignore 和 .dockerignore 里
KEEP_DAYS="${KEEP_DAYS:-14}"
OSSUTIL_BIN="${OSSUTIL_BIN:-ossutil}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# 从 .env 取一个变量的值:环境变量里已有就用环境变量;只认 KEY=value 行,去掉两边的引号。
# 不直接 source .env:里面的值(比如带空格的 MAIL_FROM)不一定是合法的 shell 语法。
env_get() {
  local key="$1" line value
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return
  fi
  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# 备份文件里有全部用户数据:目录和文件只给当前用户读写
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 防止上一次还没跑完(比如 OSS 上传很慢)又被 cron 拉起一次
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_DIR/.lock"
  if ! flock -n 9; then
    log "上一次备份还在进行,跳过本次"
    exit 0
  fi
fi

stamp="$(date '+%Y%m%d-%H%M%S')"
name="fde-${stamp}.sql.gz"
target="$BACKUP_DIR/$name"
tmp="$target.partial"
trap 'rm -f "$tmp"' EXIT
# cron 日志里要能看出是失败了、失败在哪一行
trap 'log "备份失败(backup.sh 第 $LINENO 行,退出码 $?)"' ERR

# 1) 导出。在 postgres 容器里用本地 socket 连接(官方镜像对本地连接免密),
#    用户名和库名取容器自己的环境变量,宿主机上不用知道密码。
#    --clean --if-exists:恢复时先删再建,可以直接灌回正在用的库。
log "开始导出数据库 → $target"
"$COMPOSE" exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' \
  | gzip -9 > "$tmp"

# 2) 校验压缩包完整、内容是 pg_dump 的输出,再改成正式文件名
#    (只看开头几 KB;head 提前退出会让 gzip 收到 SIGPIPE,所以这一段不受 pipefail 影响)
gzip -t "$tmp"
head_text="$(gzip -dc "$tmp" 2>/dev/null | head -c 4096 || true)"
if [[ "$head_text" != *"PostgreSQL database dump"* ]]; then
  log "导出内容不像 pg_dump 的输出,放弃本次备份"
  exit 1
fi
mv "$tmp" "$target"
log "导出完成:$(du -h "$target" | cut -f1)"

# 3) 上传 OSS(四个变量都配了才上传)
OSS_BUCKET="$(env_get OSS_BUCKET)"
OSS_ENDPOINT="$(env_get OSS_ENDPOINT)"
OSS_ACCESS_KEY_ID="$(env_get OSS_ACCESS_KEY_ID)"
OSS_ACCESS_KEY_SECRET="$(env_get OSS_ACCESS_KEY_SECRET)"

if [[ -n "$OSS_BUCKET" && -n "$OSS_ENDPOINT" && -n "$OSS_ACCESS_KEY_ID" && -n "$OSS_ACCESS_KEY_SECRET" ]]; then
  if ! command -v "$OSSUTIL_BIN" >/dev/null 2>&1; then
    log "已配置 OSS 但找不到 $OSSUTIL_BIN(ossutil 2.0),本地备份已保留,上传失败"
    exit 1
  fi
  # AccessKey 走环境变量传给 ossutil 2.0,不出现在命令行里(避免被 ps 看到)
  export OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET
  # 地域 ID 从 endpoint 推出来:oss-cn-hangzhou(-internal).aliyuncs.com → cn-hangzhou
  region="${OSS_ENDPOINT#*://}"
  region="${region%%.*}"
  region="${region#oss-}"
  region="${region%-internal}"
  dest="oss://${OSS_BUCKET}/db/${name}"
  log "上传到 $dest"
  "$OSSUTIL_BIN" cp "$target" "$dest" -e "$OSS_ENDPOINT" --region "$region" -f
  log "上传完成"
else
  log "没有配置完整的 OSS_*,只保留本地备份"
fi

# 4) 本地只保留最近 14 天(OSS 上的保留期用 Bucket 的生命周期规则管理)
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fde-*.sql.gz' -mtime +"$((KEEP_DAYS - 1))" -print -delete \
  | sed 's/^/删除过期备份:/' || true

log "备份结束"
