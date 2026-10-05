# 部署文档:阿里云 ECS + Docker Compose

本文把 FDE 训练平台部署到一台阿里云 ECS 上(方案 2.2):**app(Next.js)+ PostgreSQL 16 + Caddy**,每天把数据库 `pg_dump` 备份到 OSS。所有命令都在仓库根目录执行(下文假设是 `/opt/fde`)。阿里云 ECS 默认用 root 登录,下文命令按 root 写;用普通用户时,在 docker 相关命令前加 `sudo` 或把用户加入 docker 组。

```text
            用户浏览器
                │ HTTPS 443(HTTP 80 自动跳转)
┌───────────────▼──────────────── ECS ─────────────────────────────┐
│  caddy:2      自动证书、压缩、安全头、访问日志(/data/logs)       │
│     │ reverse_proxy app:3000                                    │
│  app          Next.js standalone(infra/Dockerfile),非 root 运行 │
│     │ DATABASE_URL                                              │
│  postgres:16  数据卷 pgdata;不映射到宿主机端口                   │
└──────────────────────────────────────────────────────────────────┘
      infra/backup.sh(cron 每天)── pg_dump | gzip ──→ 本地 14 天 + OSS
```

相关文件:

| 文件 | 作用 |
|---|---|
| `infra/Dockerfile` | 应用镜像(多阶段;Node 22 + pnpm 10;只带 standalone 产物和运行时要读的 scenarios/ config/ infra/db) |
| `infra/docker-compose.yml` | 三个服务 |
| `infra/compose.sh` | `docker compose` 的包装,自动带上仓库根目录的 `.env`;**下文所有 compose 命令都用它** |
| `infra/Caddyfile` | 反代、HTTPS、安全头、访问日志 |
| `infra/backup.sh` | 每日备份 |
| `.env.example` | 环境变量模板(与 docs/dev-spec-2026-10-05.md 3.2 节的变量表一致) |
| `docs/compliance-checklist.md` | 合规清单(方案 8.2 的 11 项) |

---

## 1. 前置:这些手续先办

按方案 5.2,合规手续有几周的前置时间,**和开发并行,第一天就启动**:

1. **公司主体**。ICP 备案、短信签名、以后的小程序类目都要求企业资质。域名的实名认证主体要和备案主体一致。
2. **ICP 备案先办**。内地服务器上的网站必须先备案才能用域名访问(方案 8.2 第 1 条):
   - 阿里云备案需要用本账号下的 ECS 生成"备案服务码"(对实例的计费方式和剩余时长有要求,以备案控制台为准),所以**先买 ECS(第 2 节),马上提交备案**。
   - 云厂商初审 1–2 个工作日,管局审核 1–20 个工作日。
   - 备案通过后 30 日内办理公安联网备案。
   - 备案下来之前,未备案的域名在这台服务器上无法通过 80/443 正常访问,也申请不到 HTTPS 证书;这段时间只能用 SSH 隧道自测(第 6 节)。
3. **短信签名暂缓,先用邮箱验证码**。国内短信签名要企业资质并实名报备(5–10 个工作日),本轮不做短信;登录用"邀请码 + 邮箱验证码",邮件走**阿里云邮件推送**:
   - 在邮件推送控制台添加发信域名(建议用子域名,如 `mail.example.com`),按提示添加 SPF、MX、DKIM 等解析记录并验证。
   - 创建发信地址(如 `noreply@mail.example.com`),设置 SMTP 密码。
   - 同时用公司主体提交短信签名,为以后切换手机号登录做准备。
4. **模型平台账号**。开通阿里云百炼和 DeepSeek,创建 API Key;记下所用模型的生成式人工智能服务备案号,上线后要在页脚公示(第 11 节)。
5. **法律文稿**。`apps/web/content/legal/` 下的用户协议、隐私政策、AI 生成内容标识说明是草稿,补全【待填写】并请专业人士审核后再上线。

## 2. 买 ECS

| 项 | 建议 |
|---|---|
| 地域 | 任一内地地域;运营主体在浙江就选华东1(杭州)。备份用的 OSS Bucket 建在同一地域,走内网不花流量 |
| 规格 | 2 vCPU 4 GiB(方案 7.4 的 ¥199/年 企业专享档)。2 GiB 也能跑,但构建镜像时要加 swap |
| 镜像 | Ubuntu 24.04 64 位(下文命令以它为准);Alibaba Cloud Linux 3 也可以 |
| 系统盘 | ESSD 40 GiB |
| 带宽 | 固定带宽 3–5 Mbps |
| 安全组入方向 | TCP 22(只放行你自己的 IP)、TCP 80、TCP 443、UDP 443(HTTP/3,可选)。**不要**放行 3000 和 5432 |

登录服务器后:

```bash
# 时区:阿里云的系统镜像默认是 Asia/Shanghai,cron 按它执行
timedatectl

# 内存小于 4 GiB 时加 4 GiB swap,否则 next build 可能被 OOM 杀掉
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. 装 Docker(国内源)与镜像加速

### 3.1 用阿里云的 Docker CE 源安装

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git openssl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker

docker compose version   # 需要 v2.24 及以上(compose 文件里用了 env_file 的 required 写法)
```

- ECS 在 VPC 里时,可以把上面的 `mirrors.aliyun.com` 换成内网地址 `mirrors.cloud.aliyuncs.com`,不走公网流量。
- Alibaba Cloud Linux 3:按阿里云帮助中心《安装 Docker》一文,用 `dnf` 添加 `https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo` 后安装同名软件包。

### 3.2 镜像加速(国内拉镜像慢)

构建和启动要从 Docker Hub 拉三个基础镜像:`node:22-bookworm-slim`、`postgres:16`、`caddy:2`。国内直连 Docker Hub 往往很慢甚至失败,按顺序试:

**方法一:配置镜像加速器。** 在阿里云"容器镜像服务 ACR"控制台 → 镜像工具 → 镜像加速器,复制你账号专属的加速器地址(形如 `https://xxxx.mirror.aliyuncs.com`,只能在阿里云的服务器上用),写进 Docker 配置:

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": ["https://<你的加速器ID>.mirror.aliyuncs.com"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
docker info | grep -A1 "Registry Mirrors"
docker pull node:22-bookworm-slim   # 试一下
```

**方法二:加速器拉不到时,用自己的 ACR 仓库中转。** 在一台能访问 Docker Hub 的机器上拉取后推到 ACR 个人版(注意服务器是 x86_64,在 Apple 芯片的 Mac 上要加 `--platform linux/amd64`):

```bash
docker pull --platform linux/amd64 node:22-bookworm-slim
docker tag node:22-bookworm-slim registry.cn-hangzhou.aliyuncs.com/<命名空间>/node:22-bookworm-slim
docker push registry.cn-hangzhou.aliyuncs.com/<命名空间>/node:22-bookworm-slim
# postgres:16、caddy:2 同理
```

然后在 `.env` 里把基础镜像换成 ACR 地址(这三个变量 `.env.example` 里有,默认注释掉):

```bash
NODE_IMAGE=registry.cn-hangzhou.aliyuncs.com/<命名空间>/node:22-bookworm-slim
POSTGRES_IMAGE=registry.cn-hangzhou.aliyuncs.com/<命名空间>/postgres:16
CADDY_IMAGE=registry.cn-hangzhou.aliyuncs.com/<命名空间>/caddy:2
```

**npm 依赖也慢**:在 `.env` 里设 `NPM_REGISTRY=https://registry.npmmirror.com`。构建时 corepack 下载 pnpm、pnpm 安装依赖都会走这个源(见 `infra/Dockerfile`)。

## 4. 拉代码

```bash
sudo mkdir -p /opt/fde && sudo chown "$USER" /opt/fde
git clone <仓库地址> /opt/fde
cd /opt/fde
```

- 私有仓库:在服务器上生成 SSH key(`ssh-keygen -t ed25519`),把公钥加为仓库的只读 Deploy key。
- 服务器上访问 GitHub 很慢时:在本地打包上传 `git archive --format=tar.gz -o fde.tar.gz HEAD && scp fde.tar.gz <服务器>:/opt/`,或者把仓库同步到阿里云云效 Codeup / Gitee 再拉。用压缩包部署时没有 git 历史,升级与回滚(第 9 节)改成按压缩包版本管理。

## 5. 填 .env

```bash
cp .env.example .env
chmod 600 .env
# 生成两个随机密钥直接写进去
sed -i "s/^FDE_AUTH_SECRET=.*/FDE_AUTH_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
vim .env
```

`.env` 的写法约定(模板开头也写了):**没注释掉的行必须填**;`# 变量名=` 开头的是可选项,需要时去掉 `# ` 再填;**可选项不要留成空值**(空字符串也算设置了,会盖掉默认值)。`.env` 同时给两处用:compose 做 `${POSTGRES_PASSWORD}` 这类变量替换,以及作为 app 容器的环境变量。

把 `.env` 另外存一份到密码管理器:`FDE_AUTH_SECRET` 和 `POSTGRES_PASSWORD` 丢了,用备份恢复时会很麻烦。

### 5.1 变量表

与第一轮 spec 3.2、第三轮 spec 第 5 节的环境变量表一致;"生产怎么填"一列是 Docker 部署时的建议。

| 变量 | 默认 | 生产怎么填 | 说明 |
|---|---|---|---|
| `FDE_ROOT` | `path.resolve(process.cwd(), "../..")` | 不填 | 仓库根目录(含 scenarios/ config/ infra/db);镜像里固定为 `/app` |
| `FDE_ENGINE_MODE` | 有 `DASHSCOPE_API_KEY` 就 live,否则 offline | 不填 | `offline` 不调模型,只用来调试 |
| `DATABASE_URL` | 无 | 不填 | compose 用 `POSTGRES_*` 拼好并覆盖;本地开发不填就用内存库 |
| `FDE_MEMORY_STORE_FILE` | `<FDE_ROOT>/.data/dev-store.json` | 不填 | 只在没有 `DATABASE_URL` 时用 |
| `DASHSCOPE_API_KEY` | 无 | **必填** | 百炼:闸门、演员、复盘 |
| `DEEPSEEK_API_KEY` | 无 | **必填** | DeepSeek:裁判 |
| `FDE_MODELS_CONFIG` | `<FDE_ROOT>/config/models.yaml` | 不填 | 换配置文件时写容器内路径 |
| `FDE_BANNED_WORDS` | 无 | `/app/config/banned_words.txt` | 违禁词表,见 5.2 |
| `FDE_AUTH_SECRET` | 开发默认值 | **必填**,`openssl rand -hex 32` | 验证码、登录 token 哈希的 pepper;上线后不要改 |
| `FDE_DEV_LOGIN_CODES` | 无 | **不要设** | `1` 时接口直接返回验证码,只用于开发和测试 |
| `SMTP_URL` | 无 | **必填** | 见 5.3 |
| `MAIL_FROM` | 无 | **必填** | 如 `"FDE 训练平台 <noreply@mail.example.com>"` |
| `ADMIN_EMAILS` | 无 | **必填** | 管理员邮箱,逗号分隔 |
| `FDE_DAILY_SESSION_LIMIT` | `3` | 不填 | 每人每天(北京时间)开局数 |
| `SITE_MODEL_DISCLOSURE` | 无 | 上线前填 | 页脚公示的模型名称与备案号(第 11 节) |
| `SITE_ICP_NUMBER` | 无 | 备案通过后填 | ICP 备案号(第 11 节) |
| `SITE_PUBLIC_SECURITY_NUMBER` | 无 | 公安备案后填 | 公安联网备案号 |
| `FDE_COOKIE_SECURE` | 生产 `1`,否则 `0` | 不填 | 全站 HTTPS,保持默认 |
| `PORT` | `3000` | 不填 | compose 固定为 3000,Caddy 反代到 `app:3000` |
| `DOMAIN` | 无 | **必填** | 已备案的域名,不带 `https://`;不填时 Caddy 用 `localhost` 自签证书 |
| `OSS_BUCKET` | 无 | 建议填 | 备份 Bucket;四个 `OSS_*` 都填了才上传 |
| `OSS_ENDPOINT` | 无 | 建议填 | 如 `oss-cn-hangzhou-internal.aliyuncs.com`(同地域内网) |
| `OSS_ACCESS_KEY_ID` | 无 | 建议填 | 只有该 Bucket 写权限的 RAM 子账号(第 8 节) |
| `OSS_ACCESS_KEY_SECRET` | 无 | 建议填 | 同上 |
| `ALIYUN_SMS_ACCESS_KEY_ID` | 无 | 短信签名审核通过后填 | 只有短信发送权限的 RAM 子账号;四个 `ALIYUN_SMS_*` 都填了才开放手机号登录(见 docs/sms.md) |
| `ALIYUN_SMS_ACCESS_KEY_SECRET` | 无 | 同上 | 同上 |
| `ALIYUN_SMS_SIGN_NAME` | 无 | 同上 | 审核通过的短信签名 |
| `ALIYUN_SMS_TEMPLATE_CODE` | 无 | 同上 | 审核通过的验证码模板,内容里用 `${code}` |
| `ALIYUN_SMS_ENDPOINT` | `https://dysmsapi.aliyuncs.com` | 不填 | 短信接口地址 |
| `SMS_HOURLY_LIMIT` | `100` | 不填 | 全站每小时最多发多少条短信(防刷) |
| `SMS_DAILY_PER_PHONE` | `10` | 不填 | 同一手机号每天最多几条 |
| `FDE_DEV_SMS_LOGIN` | 无 | **不要设** | 开发模式下不配短信也开放手机号登录 |
| `SITE_URL` | `https://<DOMAIN>` | 不填 | 邀请邮件里的站点链接 |
| `WAITLIST_OPEN` | 开 | 不填 | `0` 时关闭候补名单登记 |
| `FDE_PRODUCTS_CONFIG` | `<FDE_ROOT>/config/products.yaml` | 不填 | 商品、免费场景与预售开关 |
| `FDE_GATES_CONFIG` | `<FDE_ROOT>/config/gates.yaml` | 不填 | 方案 6.3 的指标门槛 |

只给 compose 用的(应用不读):

| 变量 | 默认 | 说明 |
|---|---|---|
| `POSTGRES_PASSWORD` | 无 | **必填**;只用字母数字(会拼进 `DATABASE_URL`);只在第一次初始化数据卷时生效 |
| `POSTGRES_USER` / `POSTGRES_DB` | `fde` / `fde` | 一般不改 |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | 国内改成 `https://registry.npmmirror.com` |
| `NODE_IMAGE` / `POSTGRES_IMAGE` / `CADDY_IMAGE` | `node:22-bookworm-slim` / `postgres:16` / `caddy:2` | 拉不动时换成 ACR 地址(3.2 节) |

### 5.2 违禁词表

违禁词表不进仓库。在服务器上创建 `config/banned_words.txt`(每行一个词,`#` 开头的行是注释),它会在构建时被拷进镜像:

```bash
vim config/banned_words.txt
echo "config/banned_words.txt" >> .git/info/exclude   # 不让 git 显示为未跟踪文件
# .env 里:FDE_BANNED_WORDS=/app/config/banned_words.txt
```

注意:路径写错或文件不存在时,引擎**不会报错**,只用内置的几个占位词。上线后在对局里输入一个词表里的词,确认被拦截。改词表后要重新构建:`./infra/compose.sh up -d --build app`。

### 5.3 SMTP_URL(阿里云邮件推送)

```bash
SMTP_URL=smtps://noreply%40mail.example.com:<SMTP密码>@smtpdm.aliyun.com:465
MAIL_FROM="FDE 训练平台 <noreply@mail.example.com>"
```

- 用户名是完整的发信地址,其中的 `@` 要写成 `%40`;SMTP 密码里有 `@ : / ?` 等字符时也要做 URL 编码。
- 用 465 端口(SSL)。ECS 默认封禁出方向 25 端口。

## 6. 启动

```bash
./infra/compose.sh up -d --build   # 第一次构建要几分钟
./infra/compose.sh ps              # app 和 postgres 显示 (healthy),caddy 是 running
./infra/compose.sh logs -f --tail=100 app
```

`infra/compose.sh` 等价于在仓库根目录执行 `docker compose --env-file .env -f infra/docker-compose.yml ...`。直接写 `docker compose -f infra/docker-compose.yml` 会读不到根目录的 `.env`(compose 默认在 compose 文件所在的 infra/ 目录找),数据库密码就是空的。

验证(备案通过、`DOMAIN` 已解析到本机之后):

```bash
curl -sI http://<域名>/            # 308 跳转到 https
curl -s https://<域名>/api/site    # 返回 SiteInfo JSON
./infra/compose.sh logs caddy | grep -i "certificate obtained"
```

**备案下来之前自测**:`.env` 里 `DOMAIN` 先留空(Caddy 用 `localhost` 和自签证书),在你自己的电脑上开 SSH 隧道:

```bash
ssh -L 8443:127.0.0.1:443 <用户>@<ECS 公网 IP>
# 浏览器打开 https://localhost:8443 ,忽略证书警告
```

备案通过后填上 `DOMAIN`,执行 `./infra/compose.sh up -d caddy`,Caddy 会自动申请证书。

## 7. 首个管理员与邀请码

新邮箱登录必须带有效邀请码,管理员也一样。第一个邀请码只能直接写进数据库。

**第一步**:确认 `.env` 里 `ADMIN_EMAILS` 写了你的邮箱(改过的话执行 `./infra/compose.sh up -d app` 生效)。

**第二步**:生成一个邀请码并写入数据库(8 位大写字母和数字,去掉易混的 0 O 1 I):

```bash
CODE=$(tr -dc 'A-HJ-NP-Z2-9' </dev/urandom | head -c 8); echo "邀请码:$CODE"
./infra/compose.sh exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<SQL
insert into invite_codes (code, max_uses, note) values ('$CODE', 1, '首个管理员');
SQL
```

如果报 `relation "invite_codes" does not exist`,说明 app 还没建表(它在启动时执行 `infra/db/` 下的迁移)。先看 `./infra/compose.sh logs app` 有没有报错;也可以手动建表(脚本是幂等的,之后 app 再迁移也不会出错):

```bash
./infra/compose.sh exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < infra/db/001_init.sql
```

**第三步**:打开 `https://<域名>/login`,填邮箱和邀请码 → 收邮件拿验证码 → 勾选同意协议 → 登录后进 `/admin`。

之后的邀请码在 `/admin` 页面生成(`POST /api/admin/invites`),可以指定每个码的使用次数和备注。

**进数据库的常用方式**:

```bash
./infra/compose.sh exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

**用户要求注销账号时**(隐私政策第五条;用户自己在 `/me` 只能删除对话,账号本身要人工删):

```bash
./infra/compose.sh exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
begin;
delete from login_codes where email = 'user@example.com';
-- 外键是 on delete cascade:对局、复盘、反馈、模型调用记录、登录态一并删除
delete from users where email = 'user@example.com';
commit;
SQL
```

## 8. 备份与恢复

`infra/backup.sh` 做的事:在 postgres 容器里执行 `pg_dump --clean --if-exists` → gzip → 存到 `.data/backups/`(权限 600)→ 配了 `OSS_*` 就用 ossutil 上传到 `oss://<Bucket>/db/` → 删除本地 14 天前的备份。

### 8.1 准备 OSS

1. 在与 ECS **同一地域**创建 Bucket:私有读写,开启服务端加密(OSS 完全托管)。
2. 给 Bucket 加生命周期规则:前缀 `db/`,90 天后删除(天数写进隐私政策第四条)。
3. 创建 RAM 子账号(只勾选 OpenAPI 调用访问),授予只限该 Bucket 的自定义权限策略,**不给删除权限**(到期删除交给生命周期规则,这样 AccessKey 泄露也删不掉备份):

   ```json
   {
     "Version": "1",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["oss:PutObject", "oss:GetObject", "oss:ListObjects", "oss:ListParts", "oss:AbortMultipartUpload"],
         "Resource": ["acs:oss:*:*:<Bucket名>", "acs:oss:*:*:<Bucket名>/db/*"]
       }
     ]
   }
   ```

4. 把 `OSS_BUCKET`、`OSS_ENDPOINT`(同地域内网节点,如 `oss-cn-hangzhou-internal.aliyuncs.com`)、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 填进 `.env`。
5. 安装 **ossutil 2.0**(命令名 `ossutil`),按阿里云帮助中心《命令行工具 ossutil 2.0》(https://help.aliyun.com/zh/oss/developer-reference/ossutil-overview/)下载 Linux x86_64 版本,放到 `/usr/local/bin/ossutil`。脚本通过环境变量把 AccessKey 交给 ossutil,不需要执行 `ossutil config`。

### 8.2 手动跑一次,再加 cron

```bash
./infra/backup.sh
ls -lh .data/backups/
```

```bash
sudo crontab -e
```

加入下面两行(cron 默认的 PATH 里没有 `/usr/local/bin`):

```cron
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * /opt/fde/infra/backup.sh >> /var/log/fde-backup.log 2>&1
```

第二天检查 `/var/log/fde-backup.log` 和 OSS 控制台里 `db/` 下有没有新文件。失败时日志里会有"备份失败(backup.sh 第 N 行……)"。

### 8.3 从备份恢复

```bash
# 从 OSS 取回(本地还有的话跳过)
ossutil cp oss://<Bucket名>/db/fde-20261105-031701.sql.gz .data/backups/ -e <OSS_ENDPOINT> --region cn-hangzhou

./infra/compose.sh stop app
gunzip -c .data/backups/fde-20261105-031701.sql.gz \
  | ./infra/compose.sh exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q'
./infra/compose.sh start app
```

备份是带 `--clean --if-exists` 的纯 SQL,可以直接灌回正在用的库(先删表再重建)。

**建议每月演练一次**,恢复到一个临时库,不影响线上:

```bash
F=$(ls -t .data/backups/fde-*.sql.gz | head -n 1)
./infra/compose.sh exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" fde_restore_test'
gunzip -c "$F" | ./infra/compose.sh exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d fde_restore_test -v ON_ERROR_STOP=1 -q'
./infra/compose.sh exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d fde_restore_test -c "select count(*) from users; select count(*) from sessions;"'
./infra/compose.sh exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" fde_restore_test'
```

## 9. 升级与回滚

### 9.1 升级

```bash
cd /opt/fde
./infra/backup.sh                          # 1. 先备份
docker tag fde-app:latest fde-app:previous # 2. 给当前镜像留一份,回滚用
git rev-parse HEAD > .data/previous-commit # 3. 记下当前版本
git pull --ff-only                         # 4. 拉新代码
./infra/compose.sh build app               # 5. 构建新镜像(旧容器继续服务)
./infra/compose.sh up -d app               # 6. 替换 app 容器(中断几秒)
./infra/compose.sh ps app                  # 7. 等到 (healthy)
curl -s https://<域名>/api/site
```

数据库迁移由 app 启动时自动执行(`infra/db/*.sql` 按顺序,已执行过的跳过)。升级说明里如果有不兼容的表结构变更,先在恢复演练用的临时库上试一遍。

### 9.2 回滚

```bash
docker tag fde-app:previous fde-app:latest
./infra/compose.sh up -d --no-build --force-recreate app
git checkout "$(cat .data/previous-commit)"   # 让代码和正在跑的镜像一致;下次升级前先 git checkout main
```

- 迁移脚本都是只增不删的(`create table if not exists`),旧版本一般能直接跑在新表结构上。
- 如果新版本已经把数据改坏了,或者表结构不兼容,再按 8.3 节用升级前的备份恢复。

### 9.3 更新 Caddy 和 PostgreSQL 镜像

```bash
./infra/compose.sh pull caddy postgres
./infra/compose.sh up -d caddy postgres
```

`postgres:16` 只会在 16.x 小版本之间更新。**不要**把它改成 17:大版本升级要先导出再导入。

## 10. 日志查看

| 看什么 | 命令 |
|---|---|
| 应用日志(500 错误的堆栈在这里) | `./infra/compose.sh logs -f --tail=200 app` |
| 最近一小时 Caddy 日志(证书申请等) | `./infra/compose.sh logs --since 1h caddy` |
| 数据库日志 | `./infra/compose.sh logs --tail=200 postgres` |
| 访问日志(JSON,含来访 IP) | `./infra/compose.sh exec caddy tail -f /data/logs/access.log` |
| 备份日志 | `tail -n 50 /var/log/fde-backup.log` |
| 资源占用 | `docker stats --no-stream`;磁盘 `df -h`、`docker system df` |
| 对局回看、成本、完成率、反馈 | 浏览器打开 `/admin` |

从访问日志里筛 5xx(宿主机需要 `apt-get install -y jq`):

```bash
./infra/compose.sh exec -T caddy cat /data/logs/access.log \
  | jq -r 'select(.status >= 500) | [.ts, .request.remote_ip, .request.method, .request.uri, .status] | @tsv'
```

日志保留:容器日志每个服务最多 5 × 20 MB(compose 里配置);访问日志按 200 天滚动删除,满足《网络安全法》网络日志不少于六个月的要求(见合规清单第 10 项)。

## 11. 备案号与模型公示上线

页脚的公示信息来自 `GET /api/site`,由 `.env` 里的三个变量决定;未配置时页脚显示"备案号:待填写"。

```bash
vim .env
#   SITE_ICP_NUMBER=浙ICP备xxxxxxxx号-1
#   SITE_PUBLIC_SECURITY_NUMBER="浙公网安备 33xxxxxxxxxxxx号"
#   SITE_MODEL_DISCLOSURE="通义千问(备案号 xxx);DeepSeek(备案号 xxx)"
./infra/compose.sh up -d app      # 必须用 up -d:restart 不会重新读取 .env
curl -s https://<域名>/api/site   # 核对 icpNumber、publicSecurityNumber、modelDisclosure
```

- ICP 备案通过当天就填 `SITE_ICP_NUMBER`,并核对页脚的备案号链接到 https://beian.miit.gov.cn/ 。
- 公安联网备案在 ICP 备案通过后 30 日内办理,下来后填 `SITE_PUBLIC_SECURITY_NUMBER`。
- `SITE_MODEL_DISCLOSURE` 按 `config/models.yaml` 实际用到的模型填写;以后换模型要同步更新。

## 12. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 证书一直申请不下来 | 备案没通过、DNS 还没生效、安全组没放行 80/443。查 `./infra/compose.sh logs caddy`。不要反复删除 `caddy_data` 卷:Let's Encrypt 对同一域名有频率限制 |
| 构建时 `Killed` 或退出码 137 | 内存不够,按第 2 节加 swap |
| 构建卡在拉基础镜像 | 3.2 节镜像加速 |
| 构建卡在 `pnpm install` 或 corepack 下载 pnpm | `.env` 里设 `NPM_REGISTRY=https://registry.npmmirror.com` |
| 构建卡在下载字体 | 前端用了 `next/font/google`,构建时要访问 Google Fonts;改用 `next/font/local` 或系统字体 |
| app 一直不是 healthy | 看 `./infra/compose.sh logs app`。常见原因:`FDE_AUTH_SECRET` 没填(生产必填)、数据库连不上 |
| postgres 起不来,日志说 superuser password is not specified | `.env` 里 `POSTGRES_PASSWORD` 没填,或者没用 `infra/compose.sh` 而是直接 `docker compose` |
| 改了 `POSTGRES_PASSWORD` 后 app 连不上库 | 密码只在第一次初始化数据卷时生效。在 psql 里 `alter user fde with password '<新密码>';` 后再 `./infra/compose.sh up -d app` |
| 改了 `.env` 不生效 | 用 `./infra/compose.sh up -d <服务>`,不要用 `restart` |
| 收不到验证码邮件 | 发信域名没验证通过、`SMTP_URL` 里的 `@` 没写成 `%40`、用了 25 端口;查 app 日志和邮件推送控制台的发送记录,也看看垃圾箱 |
| 想从宿主机连 3000 或 5432 | 故意没映射。调试用 `./infra/compose.sh exec app ...` 或上面的 psql 命令 |
