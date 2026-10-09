// 从网页后端的库里导出对局(试玩、内测的对局拿去做标定用例,方案 3.4.4 第 1 步):
//   pnpm session:export --list [--limit 50]          列出对局(新的在前):id、场景、状态、轮数、起止时间、总分、模型花费、脱敏后的账号
//   pnpm session:export --id <对局 id> [--out <文件>]  导出 { state } JSON(pnpm calibrate --init 接受的形状);不给 --out 打印到标准输出
//   pnpm session:export --id <对局 id> --calibrate <caseId>
//                                                     同时建标定用例(和 pnpm calibrate --init 是同一段代码)
//   通用:--store-file <dev-store.json>(直接读这个内存库文件,不看 DATABASE_URL,也不读 .env)、
//         --dotenv <文件>(用这个文件代替仓库根目录的 .env,不和 --store-file 一起用)、
//         --scenario scenarios/freight-docs、--dir <标定集目录>(后两个只和 --calibrate 一起用)
// 库的选择和网页后端一样(见 sessions/store.ts):有 DATABASE_URL 读 PostgreSQL,否则读内存库落盘文件;只读,不改库。
// 和 pnpm play、pnpm calibrate --live 一样先读仓库根目录的 .env(已经设了的环境变量不会被覆盖),pnpm playtest 也是这样启动网页的。
// 直接用 pnpm dev:web 玩的对局例外:网页不读根目录的 .env、读 apps/web 下的 .env*,库的变量写在两边不一样时这里会找错库——
// apps/web 下有 .env* 时打印提醒,对不上就用 --store-file。
// 退出码:0 成功;1 读库、写文件或建用例失败(连不上数据库、内存库文件坏了、用例目录写不进去);
// 2 参数或配置错误(找不到库文件或 --dotenv、DATABASE_URL 写错了、没有这局、用例 id 不对或已存在、场景读不进来)。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadScenario, type LoadedScenario } from "@fde/engine";
import { CASE_ID, initCase } from "./calibration/cases.ts";
import { CalibrationInputError } from "./calibration/human.ts";
import { loadDotenv } from "./dotenv.ts";
import { exportDoc, exportWarnings, renderSessionRows, sessionRows } from "./sessions/export.ts";
import {
  SourceConfigError,
  describeTarget,
  errorText,
  openSessionSource,
  webEnvFiles,
  webStoreTarget,
  type OpenedSource,
  type StoreTarget,
} from "./sessions/store.ts";

const root = resolve(import.meta.dirname, "../../..");
// pnpm 会把工作目录切到仓库根目录;用户在别处敲命令时,相对路径按他敲命令的目录解析
const userCwd = process.env.INIT_CWD ?? process.cwd();
const rel = (p: string) => {
  const r = relative(root, p);
  return r.startsWith("..") || isAbsolute(r) ? p : r || ".";
};

const DEFAULT_LIMIT = 50;

const USAGE = `用法:
  pnpm session:export --list [--limit ${DEFAULT_LIMIT}]
  pnpm session:export --id <对局 id> [--out <文件>]
  pnpm session:export --id <对局 id> --calibrate <caseId> [--out <文件>]
其他选项:--store-file <dev-store.json>(直接读这个内存库文件,不看 DATABASE_URL)、
          --dotenv <文件>(用这个文件代替仓库根目录的 .env;不和 --store-file 一起用)、
          --scenario <场景目录>(默认 scenarios/freight-docs)、--dir <标定集目录>(默认 <场景>/evals/calibration)
说明见 docs/playtest.md、docs/calibration.md 第 2 节`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        list: { type: "boolean", default: false },
        limit: { type: "string", default: String(DEFAULT_LIMIT) },
        id: { type: "string" },
        out: { type: "string" },
        calibrate: { type: "string" },
        "store-file": { type: "string" },
        dotenv: { type: "string" },
        scenario: { type: "string" },
        dir: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    console.error(`参数错误:${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const fail = (msg: string) => {
    console.error(`${msg}\n\n${USAGE}`);
    return 2;
  };
  if (values.list === Boolean(values.id)) return fail("--list 和 --id 必须给一个,且只能给一个");
  if (values.list && (values.out || values.calibrate)) return fail("--out、--calibrate 只和 --id 一起用");
  if (!values.calibrate && (values.scenario || values.dir)) return fail("--scenario、--dir 只和 --calibrate 一起用");
  if (values["store-file"] && values.dotenv !== undefined) return fail("--dotenv 不和 --store-file 一起用:给了 --store-file 就不读 .env");
  if (!/^\d+$/.test(values.limit!) || Number(values.limit) < 1) return fail(`--limit 必须是正整数(实际 ${values.limit})`);
  const caseId = values.calibrate;
  if (caseId !== undefined && !CASE_ID.test(caseId)) {
    return fail(`用例 id「${caseId}」不合法:字母或数字开头,只能含字母、数字、-、_,最长 64 个字符`);
  }

  // --calibrate:先确认场景读得进来、用例目录不冲突,再去碰库
  let scn: LoadedScenario | undefined;
  let calibrationDir = "";
  if (caseId !== undefined) {
    const scenario = values.scenario ?? "scenarios/freight-docs";
    const scnDir = resolve(root, scenario);
    try {
      scn = loadScenario(scnDir);
    } catch (e) {
      console.error(`无法读取场景 --scenario ${scenario}:${(e as Error).message}`);
      return 2;
    }
    calibrationDir = values.dir ? resolve(userCwd, values.dir) : join(scnDir, "evals/calibration");
    if (existsSync(join(calibrationDir, caseId))) {
      console.error(`用例目录已存在:${rel(join(calibrationDir, caseId))}。换一个 --calibrate,或先手动删掉旧目录`);
      return 2;
    }
  }

  // 选库:--store-file 直接指定内存库文件;否则按网页后端的约定(先读仓库根目录的 .env,或 --dotenv 指定的文件)
  let target: StoreTarget;
  if (values["store-file"]) {
    target = { kind: "memory", file: resolve(userCwd, values["store-file"]) };
  } else {
    const envError = loadDotenv(root, userCwd, values.dotenv);
    if (envError) {
      console.error(envError);
      return 2;
    }
    target = webStoreTarget(process.env, root);
  }
  console.error(`对局来源:${describeTarget(target)}`);
  const webEnv = values["store-file"] ? [] : webEnvFiles(root);
  if (webEnv.length) {
    console.error(
      `! apps/web 下有 ${webEnv.join("、")}:直接用 pnpm dev:web 玩时,网页读的是这些文件、不读仓库根目录的 .env(这里正相反)。` +
        `DATABASE_URL、FDE_MEMORY_STORE_FILE、FDE_ROOT 写在那里时,上面的来源可能不是网页用的库,用 --store-file 指定文件。`,
    );
  }

  let opened: OpenedSource;
  try {
    opened = await openSessionSource(target, root);
  } catch (e) {
    if (e instanceof SourceConfigError) {
      console.error(e.message);
      return 2;
    }
    console.error(`读库失败:${errorText(e)}`);
    return 1;
  }
  const { source } = opened;

  try {
    // ---------- --list
    if (values.list) {
      const limit = Number(values.limit);
      const page = await source.listAllSessions(limit + 1);
      const more = page.length > limit;
      const rows = await sessionRows(source, page.slice(0, limit));
      if (!rows.length) {
        console.log("还没有对局。");
        return 0;
      }
      for (const line of renderSessionRows(rows)) console.log(line);
      console.log(
        `\n${more ? `只显示最新 ${limit} 局(--limit 调整)` : `共 ${rows.length} 局`}。` +
          `"模型调用"为"无"的是离线模式(模板台词)玩的,不要拿去标定。` +
          `\n建标定用例:pnpm session:export --id <对局 id> --calibrate <用例 id>`,
      );
      return 0;
    }

    // ---------- --id
    const id = values.id!;
    const s = await source.getSession(id);
    if (!s) {
      console.error(`没有这局:${id}(pnpm session:export --list 看有哪些)`);
      return 2;
    }
    const calls = await source.listLlmCalls(s.id);
    for (const w of exportWarnings(s, calls.length)) console.error(`! ${w}`);

    const json = `${JSON.stringify(exportDoc(s), null, 2)}\n`;
    if (values.out) {
      const out = resolve(userCwd, values.out);
      try {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, json);
      } catch (e) {
        console.error(`写文件失败:${(e as Error).message}`);
        return 1;
      }
      console.error(`已导出 ${s.id} → ${rel(out)}`);
    } else if (caseId === undefined) {
      // macOS 上标准输出接管道时是异步写;等写完再退出,否则大的对局在 process.exit 时会被截断
      await new Promise<void>((done) => process.stdout.write(json, () => done()));
    }

    if (caseId !== undefined) {
      let r: ReturnType<typeof initCase>;
      try {
        r = initCase({ scn: scn!, calibrationDir, state: s.state, caseId });
      } catch (e) {
        if (e instanceof CalibrationInputError) {
          console.error(`输入有误:${e.message}`);
          return 2;
        }
        console.error(`建用例失败:${(e as Error).message}`);
        return 1;
      }
      console.log(`已建标定用例 ${caseId}:`);
      for (const f of r.files) console.log(`  ${rel(f)}`);
      console.log(
        `\n下一步:先别跑裁判,读 transcript.md,在 human.yaml 里逐维度打分并写理由(docs/calibration.md 第 3 节);` +
          `\n提交之前通读一遍 session.json 里的对话,确认没有试玩者的姓名、公司等个人信息;` +
          `\n填完后 pnpm calibrate --live --case ${caseId}${values.dir ? ` --dir ${values.dir}` : ""}。`,
      );
    }
    return 0;
  } catch (e) {
    console.error(`读库失败:${errorText(e)}`);
    return 1;
  } finally {
    await opened.close().catch(() => undefined);
  }
}

process.exit(await main());
