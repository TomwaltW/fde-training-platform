// pnpm session:export 的计算部分:对局列表的行、用户脱敏、导出文件的内容。CLI 只管参数和打印,测试直接调这里。
import type { StoredSession, User } from "@fde/contracts";
import { renderTable } from "../calibration/report.ts";
import type { SessionSource } from "./store.ts";

export interface SessionRow {
  id: string;
  scenarioId: string;
  status: StoredSession["status"];
  phase: string;
  /** 用户发言次数(和管理页的"轮数"一样取 state.turn)。 */
  turns: number;
  startedAt: string;
  endedAt: string | null;
  /** 复盘里的总分;还没出复盘为 null。 */
  total: number | null;
  /** 这局的模型调用次数和花费(llm_calls)。离线模式玩的对局一次都没有。 */
  calls: number;
  costYuan: number;
  /** 脱敏后的账号。 */
  user: string;
}

/** a***@example.com:只留邮箱第一个字符和域名。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "***";
  const local = email.slice(0, at);
  return `${local ? [...local][0] : ""}***${email.slice(at)}`;
}

/** 138****5678:和网页日志里的手机号脱敏(apps/web/lib/server/phone.ts)一样。 */
export function maskPhone(phone: string): string {
  const d = phone.replace(/^\+86/, "");
  return d.length === 11 ? `${d.slice(0, 3)}****${d.slice(7)}` : "***";
}

export function maskUser(u: Pick<User, "email" | "phone"> | null): string {
  if (!u) return "(已删除的用户)";
  if (u.email) return maskEmail(u.email);
  if (u.phone) return maskPhone(u.phone);
  return "(未知账号)";
}

const UTC8 = 8 * 60 * 60 * 1000;

/** 北京时间 YYYY-MM-DD HH:mm(试玩和标定都在国内,固定 UTC+8,不跟着机器时区变)。 */
export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + UTC8);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/** 一页对局 → 列表行(用户、复盘、模型调用都只读查询)。 */
export async function sessionRows(src: SessionSource, sessions: StoredSession[]): Promise<SessionRow[]> {
  const users = new Map<string, Promise<string>>();
  const userOf = (id: string) => {
    let p = users.get(id);
    if (!p) users.set(id, (p = src.getUser(id).then(maskUser)));
    return p;
  };
  return Promise.all(
    sessions.map(async (s) => {
      const [report, calls, user] = await Promise.all([src.getReport(s.id), src.listLlmCalls(s.id), userOf(s.userId)]);
      return {
        id: s.id,
        scenarioId: s.scenarioId,
        status: s.status,
        phase: s.state.phase,
        turns: s.state.turn,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        total: report ? report.report.score.total : null,
        calls: calls.length,
        costYuan: calls.reduce((sum, c) => sum + (c.costYuan ?? 0), 0),
        user,
      };
    }),
  );
}

const yuan = (v: number) => `¥${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;

export function renderSessionRows(rows: SessionRow[]): string[] {
  return renderTable(
    ["对局 id", "场景", "状态", "轮数", "开始(北京时间)", "结束", "总分", "模型调用", "用户"],
    rows.map((r) => [
      r.id,
      r.scenarioId,
      r.status === "ended" ? "已收工" : `进行中(${r.phase})`,
      String(r.turns),
      formatTime(r.startedAt),
      formatTime(r.endedAt),
      r.total === null ? "—" : String(r.total),
      r.calls ? `${r.calls} 次 ${yuan(r.costYuan)}` : "无",
      r.user,
    ]),
  );
}

/**
 * 导出文件:外面一层 { state } 正是 pnpm calibrate --init 接受的形状(docs/calibration.md 第 1 节)。
 * 只带对局本身的字段,不带 userId——标定用例要进 git,账号信息不跟着走。
 */
export function exportDoc(s: StoredSession) {
  return { id: s.id, scenarioId: s.scenarioId, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, state: s.state };
}

/** 导出或建标定用例前给人看的提醒(不致命)。 */
export function exportWarnings(s: StoredSession, calls: number): string[] {
  const out: string[] = [];
  if (s.state.phase !== "debrief") out.push(`这局还没收工(阶段 ${s.state.phase},${s.state.turn} 轮),按当前状态导出;标定时按当前状态算分`);
  if (calls === 0) {
    out.push("这局没有任何模型调用记录,多半是离线模式(关键词闸门 + 模板台词)玩的:只能用来调规则,不要拿去标定(docs/calibration.md 第 2 节)");
  }
  return out;
}
