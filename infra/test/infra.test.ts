// 部署与合规文件的静态校验(spec 第 6 节 T4 / B5)。本机没有 Docker 守护进程,这里只做解析和交叉核对:
// compose 三个服务齐全、应用用到的环境变量都在 .env.example、.env.example 与 spec 3.2 的变量表一致、
// Dockerfile 引用的路径都存在且没被 .dockerignore 排除、Caddyfile 反代到 app:3000、
// 备份脚本语法正确、三份法律文稿标注"草稿,非法律意见"、合规清单覆盖方案 8.2 的 11 项。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ---------------------------------------------------------------- 公共解析

/** spec 3.2「环境变量」表第一列里的变量名(以 spec 为唯一来源)。 */
function specEnvVars(): string[] {
  const lines = read("docs/dev-spec-2026-10-05.md").split("\n");
  const start = lines.findIndex((l) => l.startsWith("**环境变量**"));
  if (start < 0) throw new Error("spec 里找不到「环境变量」表");
  const names: string[] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("|")) {
      inTable = true;
      const firstCell = line.split("|")[1] ?? "";
      for (const m of firstCell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) names.push(m[1]!);
    } else if (inTable) {
      break;
    }
  }
  return names;
}

interface EnvExampleEntry {
  name: string;
  line: number;
  commented: boolean;
  value: string;
}

/** .env.example 里的变量:`KEY=value`(必填)或 `# KEY=value`(可选)。 */
function envExample(): { entries: EnvExampleEntry[]; lines: string[] } {
  const lines = read(".env.example").split("\n");
  const entries: EnvExampleEntry[] = [];
  lines.forEach((raw, i) => {
    const m = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
    if (m) entries.push({ name: m[2]!, line: i, commented: Boolean(m[1]), value: m[3]! });
  });
  return { entries, lines };
}

/** compose 文件里 ${VAR}、${VAR:-x}、${VAR?x} 形式的变量替换($${…} 是转义,不算)。 */
function composeInterpolations(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]!);
  return out;
}

/** 应用服务端代码里读的 process.env.X / process.env["X"]。 */
function codeEnvVars(): Map<string, string> {
  const dirs = ["apps/web/app", "apps/web/lib", "apps/web/components", "packages/contracts/src", "packages/engine/src", "packages/llm/src", "packages/store/src"];
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) {
        const text = readFileSync(p, "utf8");
        for (const m of text.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\])/g)) {
          const v = m[1] ?? m[2]!;
          if (!found.has(v)) found.set(v, relative(ROOT, p));
        }
      }
    }
  };
  for (const d of dirs) walk(resolve(ROOT, d));
  return found;
}

/** 框架、平台和测试运行器自己的变量,不属于 .env 配置。 */
const PLATFORM_VARS = new Set(["NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE", "NEXT_TELEMETRY_DISABLED", "HOSTNAME", "TZ", "CI", "VITEST"]);

interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string; args?: Record<string, string> };
  env_file?: string | (string | { path: string; required?: boolean })[];
  environment?: Record<string, string> | string[];
  depends_on?: string[] | Record<string, { condition?: string }>;
  healthcheck?: { test?: string | string[] };
  ports?: (string | number)[];
  volumes?: string[];
}
interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

const composeText = read("infra/docker-compose.yml");
const compose = parse(composeText) as ComposeFile;

function envKeys(env: ComposeService["environment"]): string[] {
  if (!env) return [];
  return Array.isArray(env) ? env.map((e) => e.split("=")[0]!) : Object.keys(env);
}

/** 非常简化的 .dockerignore 匹配:** 跨目录,* 不跨目录;模式命中路径本身或它的任一上级目录即算排除。 */
function dockerIgnored(path: string): boolean {
  const patterns = read(".dockerignore")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const toRe = (pat: string) =>
    new RegExp(
      "^" +
        pat
          .replace(/^\//, "")
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/\u0000/g, "(?:.*/)?") +
        "$",
    );
  const parts = path.split("/");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let ignored = false;
  for (const pat of patterns) {
    const negate = pat.startsWith("!");
    const re = toRe(negate ? pat.slice(1) : pat);
    if (candidates.some((c) => re.test(c))) ignored = !negate;
  }
  return ignored;
}

interface DockerCopy {
  from: string | null;
  sources: string[];
  dest: string;
  stage: string;
}

/** 解析 Dockerfile:每个阶段的 WORKDIR 和所有 COPY。 */
function parseDockerfile(): { copies: DockerCopy[]; workdirs: Map<string, string>; text: string } {
  const text = read("infra/Dockerfile");
  const logical = text
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const copies: DockerCopy[] = [];
  const workdirs = new Map<string, string>();
  let stage = "";
  for (const line of logical) {
    const [instr, ...rest] = line.split(/\s+/);
    const upper = instr!.toUpperCase();
    if (upper === "FROM") {
      const asIdx = rest.findIndex((t) => t.toUpperCase() === "AS");
      stage = asIdx >= 0 ? rest[asIdx + 1]! : String(copies.length);
    } else if (upper === "WORKDIR") {
      workdirs.set(stage, rest[0]!);
    } else if (upper === "COPY") {
      const flags = rest.filter((t) => t.startsWith("--"));
      const args = rest.filter((t) => !t.startsWith("--"));
      const fromFlag = flags.find((f) => f.startsWith("--from="));
      copies.push({ from: fromFlag ? fromFlag.slice("--from=".length) : null, sources: args.slice(0, -1), dest: args.at(-1)!, stage });
    }
  }
  return { copies, workdirs, text };
}

// ---------------------------------------------------------------- docker-compose.yml

describe("docker-compose.yml", () => {
  it("有 app、postgres、caddy 三个服务", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["app", "caddy", "postgres"]);
  });

  it("app:从仓库根目录用 infra/Dockerfile 构建,读 ../.env,DATABASE_URL 指向 postgres,等 postgres 健康再启动", () => {
    const app = compose.services.app!;
    expect(app.build?.context).toBe("..");
    expect(app.build?.dockerfile).toBe("infra/Dockerfile");
    expect(existsSync(resolve(ROOT, "infra", app.build!.context!, app.build!.dockerfile!))).toBe(true);

    const envFiles = (Array.isArray(app.env_file) ? app.env_file : [app.env_file]).map((e) => (typeof e === "string" ? e : e?.path));
    expect(envFiles).toContain("../.env");

    const env = app.environment as Record<string, string>;
    expect(env.DATABASE_URL).toMatch(/^postgres(ql)?:\/\/.+@postgres:5432\//);
    expect(env.PORT).toBe("3000");

    const deps = app.depends_on as Record<string, { condition?: string }>;
    expect(deps.postgres?.condition).toBe("service_healthy");
  });

  it("postgres:16,数据卷,pg_isready 健康检查,不对外开放端口", () => {
    const pg = compose.services.postgres!;
    expect(pg.image).toMatch(/postgres:16\b/);
    expect(pg.volumes?.some((v) => v.endsWith(":/var/lib/postgresql/data"))).toBe(true);
    const test = pg.healthcheck?.test;
    expect(Array.isArray(test) ? test.join(" ") : test).toContain("pg_isready");
    expect(pg.ports ?? []).toEqual([]);
  });

  it("caddy:2,对外 80/443,挂载 Caddyfile 和数据卷", () => {
    const caddy = compose.services.caddy!;
    expect(caddy.image).toMatch(/caddy:2\b/);
    const ports = (caddy.ports ?? []).map(String);
    expect(ports).toContain("80:80");
    expect(ports).toContain("443:443");
    expect(caddy.volumes?.some((v) => v.startsWith("./Caddyfile:/etc/caddy/Caddyfile"))).toBe(true);
    expect(caddy.volumes?.some((v) => v.endsWith(":/data"))).toBe(true);
  });

  it("用到的命名卷都在顶层 volumes 里声明", () => {
    const named = Object.values(compose.services)
      .flatMap((s) => s.volumes ?? [])
      .map((v) => v.split(":")[0]!)
      .filter((src) => !src.startsWith(".") && !src.startsWith("/"));
    for (const v of named) expect(Object.keys(compose.volumes ?? {})).toContain(v);
  });

  const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
  it.skipIf(!hasCompose)("docker compose config -q 能解析(没有 .env 也行)", () => {
    const r = spawnSync("docker", ["compose", "-f", "infra/docker-compose.yml", "config", "-q"], { cwd: ROOT, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------- 环境变量

describe(".env.example", () => {
  const spec = specEnvVars();
  const { entries, lines } = envExample();
  const names = new Set(entries.map((e) => e.name));

  it("spec 3.2 的变量表能解析出来(防止解析器漏掉)", () => {
    expect(new Set(spec)).toEqual(
      new Set([
        "FDE_ROOT", "FDE_ENGINE_MODE", "DATABASE_URL", "FDE_MEMORY_STORE_FILE", "DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY",
        "FDE_MODELS_CONFIG", "FDE_BANNED_WORDS", "FDE_AUTH_SECRET", "FDE_DEV_LOGIN_CODES", "SMTP_URL", "MAIL_FROM",
        "ADMIN_EMAILS", "FDE_DAILY_SESSION_LIMIT", "SITE_MODEL_DISCLOSURE", "SITE_ICP_NUMBER", "SITE_PUBLIC_SECURITY_NUMBER",
        "FDE_COOKIE_SECURE", "PORT", "DOMAIN", "OSS_BUCKET", "OSS_ENDPOINT", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET",
      ]),
    );
  });

  it("包含 spec 3.2 环境变量表里的每一个变量", () => {
    expect(spec.filter((v) => !names.has(v))).toEqual([]);
  });

  it("除 spec 的变量外,只多出 compose 自己要的变量(不夹带表外的应用变量)", () => {
    const allowed = new Set([...spec, ...composeInterpolations(composeText)]);
    expect(entries.map((e) => e.name).filter((n) => !allowed.has(n))).toEqual([]);
  });

  it("每个变量只出现一次,上一行是一行注释说明", () => {
    const seen = entries.map((e) => e.name);
    expect(seen.filter((n, i) => seen.indexOf(n) !== i)).toEqual([]);
    for (const e of entries) {
      const prev = (lines[e.line - 1] ?? "").trim();
      const prevIsVar = /^#?\s*[A-Z][A-Z0-9_]*=/.test(prev);
      expect(prev.startsWith("#") && !prevIsVar && prev.length > 2, `${e.name} 上一行缺少注释说明`).toBe(true);
    }
  });

  it("模板里不带真实密钥", () => {
    for (const key of ["DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY", "FDE_AUTH_SECRET", "SMTP_URL", "POSTGRES_PASSWORD", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"]) {
      const e = entries.find((x) => x.name === key)!;
      expect(e.value, key).toBe("");
    }
  });

  it("compose 里 app 的 environment 和所有 ${VAR} 替换都在 .env.example 里", () => {
    const used = new Set([...envKeys(compose.services.app!.environment), ...composeInterpolations(composeText)]);
    expect([...used].filter((v) => !names.has(v))).toEqual([]);
  });

  it("应用代码里读的环境变量都在 .env.example 里", () => {
    const missing = [...codeEnvVars()].filter(([v]) => !PLATFORM_VARS.has(v) && !names.has(v)).map(([v, file]) => `${v}(${file})`);
    expect(missing).toEqual([]);
  });

  it("config/models.yaml 里各供应商的 api_key_env 都在 .env.example 里", () => {
    const cfg = parse(read("config/models.yaml")) as { providers: Record<string, { api_key_env: string }> };
    for (const p of Object.values(cfg.providers)) expect(names.has(p.api_key_env), p.api_key_env).toBe(true);
  });

  it("docs/deploy.md 的变量表逐行列出了 spec 表里的每一个变量", () => {
    const rows = new Set([...read("docs/deploy.md").matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]!));
    expect(spec.filter((v) => !rows.has(v))).toEqual([]);
  });
});

// ---------------------------------------------------------------- Dockerfile

describe("Dockerfile", () => {
  const { copies, workdirs, text } = parseDockerfile();

  it("多阶段;Node 22;corepack 启用 pnpm;frozen-lockfile 安装;build:web", () => {
    expect((text.match(/^FROM /gm) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).toMatch(/ARG NODE_IMAGE=node:22\b/);
    expect(text).toMatch(/corepack enable/);
    expect(text).toMatch(/pnpm install --frozen-lockfile/);
    expect(text).toMatch(/pnpm build:web/);
    expect(read("package.json")).toMatch(/"packageManager":\s*"pnpm@10\./);
  });

  it("运行镜像:非 root 用户、FDE_ROOT、HEALTHCHECK 请求 /api/site、启动 apps/web/server.js", () => {
    const runtime = text.slice(text.lastIndexOf("\nFROM "));
    const user = /^USER\s+(\S+)/m.exec(runtime)?.[1];
    expect(user).toBeDefined();
    expect(["root", "0"]).not.toContain(user);
    expect(runtime).toMatch(/FDE_ROOT=\/app\b/);
    expect(runtime).toMatch(/HEALTHCHECK[\s\S]*\/api\/site/);
    expect(runtime).toMatch(/CMD \["node", "apps\/web\/server\.js"\]/);
    expect(read("apps/web/next.config.ts")).toMatch(/output:\s*"standalone"/);
  });

  it("从构建上下文 COPY 的路径在仓库里都存在,且没被 .dockerignore 排除", () => {
    const ctx = copies.filter((c) => c.from === null).flatMap((c) => c.sources);
    expect(ctx.length).toBeGreaterThan(0);
    for (const src of ctx) {
      expect(existsSync(resolve(ROOT, src)), `${src} 不存在`).toBe(true);
      expect(dockerIgnored(src), `${src} 被 .dockerignore 排除了`).toBe(false);
    }
  });

  it("从构建阶段 COPY 的路径:源码路径存在,.next 产物的上级目录存在", () => {
    const fromBuild = copies.filter((c) => c.from !== null);
    expect(fromBuild.length).toBeGreaterThan(0);
    for (const c of fromBuild) {
      const wd = (workdirs.get(c.from!) ?? "/").replace(/\/?$/, "/");
      for (const src of c.sources) {
        expect(src.startsWith(wd), `${src} 不在构建阶段的 WORKDIR ${wd} 下`).toBe(true);
        const rel = src.slice(wd.length);
        const idx = rel.indexOf(".next");
        const mustExist = idx >= 0 ? rel.slice(0, idx).replace(/\/$/, "") : rel;
        expect(existsSync(resolve(ROOT, mustExist)), `${src} → ${mustExist} 不存在`).toBe(true);
        expect(dockerIgnored(mustExist), `${mustExist} 被 .dockerignore 排除了`).toBe(false);
      }
    }
  });

  it("运行镜像里 FDE_ROOT 下有 scenarios、config、infra/db", () => {
    const runtimeDests = copies.filter((c) => c.stage === "runtime").map((c) => c.dest.replace(/^\.\//, "").replace(/\/$/, ""));
    for (const d of ["scenarios", "config", "infra/db"]) expect(runtimeDests).toContain(d);
    expect(workdirs.get("runtime")).toBe("/app");
  });

  it("运行时要读的关键文件不会被 .dockerignore 挡在构建上下文外", () => {
    for (const f of [
      "pnpm-lock.yaml",
      "apps/web/next.config.ts",
      "scenarios/freight-docs/scenario.yaml",
      "config/models.yaml",
      "infra/db/001_init.sql",
      "apps/web/content/legal/terms.md",
    ]) {
      expect(dockerIgnored(f), f).toBe(false);
    }
    for (const f of [".env", ".env.production", "node_modules", "apps/web/node_modules", "apps/web/.next", ".git", ".data"]) {
      expect(dockerIgnored(f), f).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- Caddyfile

describe("Caddyfile", () => {
  const text = read("infra/Caddyfile");
  it("站点地址来自 {$DOMAIN},反代到 app:3000,压缩,带安全头", () => {
    expect(text).toMatch(/^\{\$DOMAIN(:[^}]*)?\}\s*\{/m);
    expect(text).toMatch(/^\s*reverse_proxy\s+app:3000\s*$/m);
    expect(text).toMatch(/^\s*encode\s+.*gzip/m);
    for (const h of ["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"]) expect(text).toContain(h);
  });
  it("app 服务确实监听 3000", () => {
    expect((compose.services.app!.environment as Record<string, string>).PORT).toBe("3000");
    expect(read("infra/Dockerfile")).toMatch(/EXPOSE 3000/);
  });
});

// ---------------------------------------------------------------- 脚本

describe("脚本", () => {
  for (const f of ["infra/backup.sh", "infra/compose.sh"]) {
    it(`${f}:bash -n 通过,开头 set -euo pipefail`, () => {
      const r = spawnSync("bash", ["-n", resolve(ROOT, f)], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(read(f)).toMatch(/^set -euo pipefail$/m);
      expect(statSync(resolve(ROOT, f)).mode & 0o111).not.toBe(0);
    });
  }

  it("backup.sh:compose exec 跑 pg_dump | gzip,配置了 OSS 时用 ossutil 上传,本地保留 14 天,附 crontab 示例", () => {
    const text = read("infra/backup.sh");
    expect(text).toMatch(/exec -T postgres/);
    expect(text).toMatch(/pg_dump[\s\S]*\|\s*gzip/);
    expect(text).toMatch(/ossutil/);
    for (const v of ["OSS_BUCKET", "OSS_ENDPOINT", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"]) expect(text).toContain(v);
    expect(text).toMatch(/KEEP_DAYS:-14\b/);
    expect(text).toMatch(/^#\s+\d+\s+\d+\s+\*\s+\*\s+\*\s+\S*backup\.sh/m);
  });
});

// ---------------------------------------------------------------- 文档与法律文稿

describe("法律文稿", () => {
  const docs = ["terms", "privacy", "ai-notice"].map((s) => `apps/web/content/legal/${s}.md`);
  for (const f of docs) {
    it(`${f}:存在、非空,开头醒目标注草稿、非法律意见,主体与联系方式待填写`, () => {
      expect(existsSync(resolve(ROOT, f))).toBe(true);
      const text = read(f);
      expect(text.trim().length).toBeGreaterThan(500);
      const head = text.split("\n").slice(0, 6).join("\n");
      expect(head).toContain("草稿");
      expect(head).toContain("非法律意见");
      expect(text).toContain("【待填写】");
    });
  }

  it("用户协议说明 AI 生成内容的标识方式(方案 8.2 第 3 条)", () => {
    const text = read("apps/web/content/legal/terms.md");
    for (const k of ["显式标识", "隐式标识", "元数据"]) expect(text).toContain(k);
  });

  it("隐私政策:最小化收集、对话改进需同意、/me 删除、日志留存", () => {
    const text = read("apps/web/content/legal/privacy.md");
    for (const k of ["邮箱", "IP", "/me", "删除", "同意", "六个月"]) expect(text).toContain(k);
  });

  it("AI 标识说明:显式(页面常驻、分享卡、导出文件)与隐式(文件元数据)", () => {
    const text = read("apps/web/content/legal/ai-notice.md");
    for (const k of ["显式标识", "隐式标识", "分享卡", "元数据", "AIGC"]) expect(text).toContain(k);
  });
});

describe("docs/compliance-checklist.md", () => {
  // 方案 8.2 合规清单的 11 项(从方案原文解析)
  const plan = read("FDE训练平台-产品与开发方案-v1.md");
  const section = plan.slice(plan.indexOf("### 8.2 合规清单"), plan.indexOf("## 9."));
  const items = [...section.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/gm)].map((m) => ({ n: Number(m[1]), name: m[2]! }));
  const text = read("docs/compliance-checklist.md");

  it("方案 8.2 解析出 11 项", () => {
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  for (let n = 1; n <= 11; n++) {
    it(`第 ${n} 项:有独立小节,写了"代码里已做的""上线前要办的""待确认"`, () => {
      const item = items.find((i) => i.n === n)!;
      const re = new RegExp(`^### ${n}\\. (.+)$`, "m");
      const m = re.exec(text);
      expect(m, `缺少「### ${n}. ${item.name}」`).not.toBeNull();
      expect(m![1]).toContain(item.name);
      const body = text.slice(m!.index + m![0].length).split(/^#{2,3} /m)[0]!;
      for (const k of ["代码里已做的", "上线前要办的", "待确认"]) expect(body, `第 ${n} 项缺「${k}」`).toContain(k);
    });
  }
});

describe("docs/deploy.md", () => {
  const text = read("docs/deploy.md");
  it("覆盖前置、装 Docker、镜像加速、compose 启动、首个管理员、备份 cron、升级回滚、日志、备案号", () => {
    for (const k of [
      "ICP 备案",
      "邮箱验证码",
      "mirrors.aliyun.com",
      "registry-mirrors",
      "./infra/compose.sh up -d",
      "invite_codes",
      "ADMIN_EMAILS",
      "crontab",
      "backup.sh",
      "回滚",
      "logs",
      "SITE_ICP_NUMBER",
    ]) {
      expect(text, k).toContain(k);
    }
  });
});
