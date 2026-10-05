// 命令行试玩:pnpm play [--offline] [--resume <会话文件>] [--debug]
//   在线(默认):闸门、演员、裁判、复盘都用 config/models.yaml 里的模型,需要 .env 里的 API Key。
//   离线(--offline):关键词闸门 + 模板演员,只用来调导演规则,不代表线上效果;不跑裁判。
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  Engine,
  FixtureJudge,
  HeuristicGate,
  LlmActor,
  LlmDebrief,
  LlmGate,
  LlmJudge,
  Moderation,
  TemplateActor,
  TemplateDebrief,
  emptyJudge,
  loadScenario,
  minutesLeft,
  type EngineDeps,
  type SessionState,
  type TurnResult,
} from "@fde/engine";
import { createGateway, loadModelsConfig } from "@fde/llm";

const root = resolve(import.meta.dirname, "../../..");
const { values } = parseArgs({
  options: {
    offline: { type: "boolean", default: false },
    resume: { type: "string" },
    debug: { type: "boolean", default: false },
    scenario: { type: "string", default: "scenarios/freight-docs" },
  },
});

const scn = loadScenario(resolve(root, values.scenario!));
const d = scn.data;
const sessionsDir = join(root, ".sessions");
mkdirSync(sessionsDir, { recursive: true });

let st: SessionState;
const sessionId = values.resume ? "" : `s-${new Date().toISOString().replace(/[:.]/g, "-")}`;

let deps: EngineDeps;
if (values.offline) {
  deps = {
    gate: new HeuristicGate(),
    actor: new TemplateActor(),
    judge: new FixtureJudge(() => emptyJudge(scn)),
    debrief: new TemplateDebrief(),
  };
} else {
  if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
  const cfg = loadModelsConfig(process.env.FDE_MODELS_CONFIG ?? join(root, "config/models.yaml"));
  const chat = createGateway(cfg, {
    onCall: (l) => appendFileSync(join(sessionsDir, `${l.sessionId ?? "unknown"}.calls.jsonl`), `${JSON.stringify(l)}\n`),
  });
  deps = { gate: new LlmGate(chat), actor: new LlmActor(chat), judge: new LlmJudge(chat), debrief: new LlmDebrief(chat) };
}
deps.moderation = Moderation.fromFile(process.env.FDE_BANNED_WORDS);
const engine = new Engine(scn, deps);

if (values.resume) {
  st = JSON.parse(readFileSync(values.resume, "utf8")) as SessionState;
} else {
  st = engine.start(sessionId);
}
const save = () => writeFileSync(join(sessionsDir, `${st.sessionId}.json`), JSON.stringify(st, null, 2));

const name = (id: string) => scn.roles.get(id)?.name ?? id;
const findRole = (q: string) => d.roles.find((r) => r.id === q || r.name === q || r.name.includes(q) || q.includes(r.name))?.id;

function header() {
  const left = Math.max(0, minutesLeft(st, scn));
  const total = d.budget.discovery_minutes;
  const bar = "▓".repeat(Math.round((left / total) * 20)).padEnd(20, "░");
  const h = Math.floor(left / 60);
  const m = left % 60;
  return `[今天还剩 ${h} 小时 ${m} 分 ${bar}] 阶段:${st.phase} · 当前:${name(st.currentRole)}`;
}

function show(res: TurnResult, fromDialogue = false) {
  for (const s of res.system) console.log(`  ※ ${s}`);
  if (res.reply) {
    const tag = values.debug && res.directive ? ` 〔${res.directive.stance}${res.directive.beat ? `·${res.directive.beat}` : ""}〕` : "";
    console.log(`\n${name(res.reply.roleId)}:${res.reply.text}${tag}\n`);
  }
  if (res.unlockedArtifacts.length) console.log(`  📎 拿到资料:${res.unlockedArtifacts.map((a) => `${a} ${scn.artifact(a).title}`).join(";")}(/open 查看)`);
  if (res.discovered.length) console.log(`  👤 新出现的人:${res.discovered.map(name).join("、")}`);
  if (values.debug && res.guardFlags.length) console.log(`  [guard] ${res.guardFlags.join(", ")}`);
  if (values.debug && fromDialogue) {
    const t = st.turns.at(-1);
    if (t?.gate) console.log(`  [gate] acts=${t.gate.acts.join(",")} triggers=${t.gate.matched_triggers.map((m) => m.id).join(",")}`);
  }
}

const HELP = `命令:
  直接打字          对当前的人说话
  /people           人物列表(没发现的人不显示)
  /to <人名>        去找某人(花 ${d.budget.switch_person_min} 分钟)
  /files            我拿到的资料
  /open <A1>        看一份资料(第一次看要花时间)
  /visit            ${d.actions.site_visit?.title ?? "去现场"}
  /exp [X1]         可做的验证 / 做一个验证(${d.budget.experiment_min} 分钟)
  /judge            我的判断是…(填 J1–J5,之后去向周总汇报)
  /end              收工,看复盘
  /debug            显示/隐藏导演指令和闸门标注
  /help             帮助`;

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
// 用异步迭代器读行:它会缓冲引擎处理期间到达的输入(rl.question 会丢),输入结束时返回 undefined
const lines = rl[Symbol.asyncIterator]();
async function ask(prompt: string): Promise<string | undefined> {
  process.stdout.write(prompt);
  const r = await lines.next();
  return r.done ? undefined : String(r.value);
}

async function finish() {
  console.log("\n正在生成复盘……");
  const report = await engine.finish(st);
  save();
  const file = join(sessionsDir, `${st.sessionId}.debrief.md`);
  writeFileSync(file, report.markdown);
  console.log(`\n${report.markdown}\n`);
  console.log(`复盘已保存:${file.replace(`${root}/`, "")}`);
  if (report.judgeIssues.length && values.debug) console.log(`[judge] ${report.judgeIssues.join(";")}`);
}

console.log(`\n=== ${d.meta.title} ===\n${d.meta.disclaimer}\n`);
if (!values.resume) {
  console.log(`${d.briefing.you_are}\n${d.briefing.company}\n\n目标:${d.briefing.goal}\n`);
  for (const r of d.briefing.rules_shown) console.log(`· ${r}`);
  console.log(`\n${values.offline ? "(离线模式:关键词闸门 + 模板台词,只用于调规则)\n" : ""}输入 /help 查看命令。对话内容由 AI 生成。\n`);
  console.log(`${name(d.briefing.opening.speaker)}:${d.briefing.opening.text}\n`);
} else {
  console.log(`继续会话 ${st.sessionId}。最近的对话:`);
  for (const l of st.transcript.slice(-4)) console.log(`  ${l.speaker === "user" ? "你" : l.speaker === "npc" ? name(l.roleId ?? "") : "※"}:${l.text}`);
}

while (st.phase !== "debrief") {
  console.log(header());
  const input = await ask("你:");
  if (input === undefined) {
    save();
    console.log(`\n输入结束,进度已保存。继续:pnpm play --resume .sessions/${st.sessionId}.json`);
    break;
  }
  const line = input.trim();
  if (!process.stdin.isTTY) console.log(line);
  if (!line) continue;
  try {
    if (!line.startsWith("/")) {
      show(await engine.userTurn(st, line), true);
    } else {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "help":
          console.log(HELP);
          break;
        case "debug":
          values.debug = !values.debug;
          console.log(`debug ${values.debug ? "开" : "关"}`);
          break;
        case "people":
          for (const id of st.discovered) {
            const r = scn.role(id);
            console.log(`  ${id === st.currentRole ? "●" : "○"} ${r.name}(${r.title})${st.exchanges[id] ? ` · 聊过 ${st.exchanges[id]} 轮` : ""}`);
          }
          break;
        case "to": {
          const id = findRole(arg);
          if (!id) console.log("  没有这个人。");
          else show(await engine.act(st, { type: "switch_role", role: id }));
          break;
        }
        case "files":
          if (!Object.keys(st.artifacts).length) console.log("  还没有拿到任何资料。");
          for (const [id, a] of Object.entries(st.artifacts)) {
            const art = scn.artifact(id);
            console.log(`  ${a.openedTurn !== undefined ? "▣" : "□"} ${id} ${art.title}(${art.files})`);
          }
          break;
        case "open":
          show(await engine.act(st, { type: "open_artifact", artifact: arg.toUpperCase() }));
          break;
        case "visit":
          show(await engine.act(st, { type: "action", action: "site_visit" }));
          break;
        case "exp":
          if (!arg) for (const x of d.experiments) console.log(`  ${x.id} ${x.title}${st.experiments[x.id] ? "(已做)" : ""}`);
          else show(await engine.act(st, { type: "experiment", experiment: arg.toUpperCase() }));
          break;
        case "judge": {
          const form: Record<string, string> = {};
          for (const f of d.judgment_form) form[f.id] = ((await ask(`${f.id} ${f.label}:\n> `)) ?? "").trim();
          show(await engine.act(st, { type: "submit_judgment", form }));
          break;
        }
        case "end":
          show(await engine.act(st, { type: "end" }));
          break;
        case "state":
          console.log(JSON.stringify({ facts: st.facts, trust: st.trust, flags: st.flags, ledger: st.ledger, minutesUsed: st.minutesUsed }, null, 2));
          break;
        default:
          console.log("  不认识这个命令,输入 /help 查看。");
      }
    }
  } catch (e) {
    console.log(`  出错了:${(e as Error).message}`);
  }
  save();
}

if (st.phase === "debrief") await finish();
rl.close();
