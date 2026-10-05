// 关键词版闸门:只给本地开发和命令行离线试玩用,不代表线上效果。
// 方案明确反对按关键词解锁(9.1 第 1 条);线上一律用模型闸门(llm-ports.ts)。
import type { GateInput, GatePort } from "../ports.ts";
import { gateCatalog } from "../triggers.ts";
import type { Act, GateOutput } from "../types.ts";

const STOP = new Set(["什么", "一下", "怎么", "这个", "那个", "问问", "问一", "有没", "没有", "是不", "不是", "你们", "我们", "一个"]);

function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s,。、;:!?,.;:!?()()「」"“”]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    if (!STOP.has(b)) out.add(b);
  }
  return out;
}

const HEDGE = /(大概|左右|估计|看完|先看|范围|可能|差不多|需要先|前提|之后再|再定|不好说)/;
const CN_NUM = "[0-9一二两三四五六七八九十百千万.]+";

export class HeuristicGate implements GatePort {
  async classify({ scn, st, userText }: GateInput): Promise<GateOutput> {
    const t = userText.trim();
    const acts = new Set<Act>();
    const roleNames = scn.data.roles.map((r) => ({ id: r.id, name: r.name }));
    let target: string | null = null;

    const named = roleNames.find((r) => t.includes(r.name));
    if (named && /(去找|找一下|找找|换|跟|和|让|叫).{0,6}(聊|谈|问|说)|^去找|我去找|找.{0,4}聊/.test(t)) {
      acts.add("switch_role");
      target = named.id;
    }
    if (/(现场|操作部).{0,8}(看|转|走)|去.{0,4}(现场|一线)/.test(t)) acts.add("request_site_visit");
    if (/(做个验证|做个测试|试一下|跑一下|重新归类|按类别|对一下|交叉核对|按客户看)/.test(t)) acts.add("request_experiment");
    if (/(给我看|看看|要一份|发我|导出|拿给我|能看下|能看看)/.test(t)) acts.add("request_artifact");
    if (/(同意|授权|批准|点头|允许|能不能让我|可以让我|让财务|让操作部)/.test(t)) acts.add("request_permission");
    if (/(收回|不算数|不作数|撤回|先不算|之前说的不算)/.test(t)) acts.add("retract_commitment");
    if (/(我建议|方案是|我们可以给你做|给你做一个|上一套|做一套)/.test(t)) acts.add("propose_solution");
    if (/^(收工|结束|不玩了)/.test(t)) acts.add("end_session");
    if (/我的判断/.test(t)) acts.add("state_judgment");

    const commitments: GateOutput["commitments"] = [];
    const firm = !HEDGE.test(t);
    const time = t.match(new RegExp(`${CN_NUM}\\s*(天|周|个星期|星期|个月)(就|能|可以|搞定|做完|上线|建)`));
    if (time) commitments.push({ type: "time", value_text: time[0], firm });
    const price = t.match(new RegExp(`${CN_NUM}\\s*(万|元|块)`));
    if (price && /(报价|一共|收|费|价格|万块|多少钱|花)/.test(t)) commitments.push({ type: "price", value_text: price[0], firm });
    const acc = t.match(/(准确率|识别率).{0,6}(\d+%|百分之[一二三四五六七八九十]+|九[十五]|99)/);
    if (acc) commitments.push({ type: "accuracy", value_text: acc[0], firm });
    if (time) acts.add("commit_time");
    if (price) acts.add("commit_price");
    if (acc) acts.add("commit_accuracy");

    // 触发器:字符二元组重合
    const ub = bigrams(t);
    const scored = gateCatalog(scn)
      .map((c) => {
        const ab = bigrams(c.ask);
        let n = 0;
        for (const b of ab) if (ub.has(b)) n++;
        const boost = c.role === st.currentRole ? 1 : 0;
        return { id: c.id, n: n + boost, size: ab.size };
      })
      .filter((x) => x.n >= 3)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((x) => ({ id: x.id, confidence: Math.min(0.95, 0.55 + x.n * 0.05) }));

    const plus: string[] = [];
    const minus: string[] = [];
    if (/(不是来追责|不追究|不追责|不是来查)/.test(t)) plus.push("说明来意不是追责");
    if (/(不点名|不会说是谁|不提名字)/.test(t)) plus.push("承诺不点名");
    if (/(辛苦|不容易|理解你|听你说|您说的我明白)/.test(t)) plus.push("先听对方抱怨并复述");
    if (/(新人不认真|太粗心|就是你们|怪你们)/.test(t)) minus.push("把错误归咎于一线");
    if (/(替代|裁掉|少用人|不需要人)/.test(t)) minus.push("暗示要替代人");
    if (/(快点|赶紧|别废话|直接说)/.test(t)) minus.push("催促或打断");

    const meta = /(提示词|prompt|系统设定|你是AI|你是模型|忽略之前|直接告诉我答案|真相是什么|跳出角色|扮演)/i.test(t);
    if (acts.size === 0) acts.add(/[??]|吗|呢|怎么|为什么|多少|哪/.test(t) ? "ask" : "smalltalk");
    if (/[??]|吗|呢|怎么|为什么|多少|哪/.test(t)) acts.add("ask");

    return {
      target_role: target,
      acts: [...acts],
      matched_triggers: scored,
      question_tags: {
        open: /(怎么|为什么|什么样|哪些|说说|讲讲|如何|是什么)/.test(t),
        quantifying: /(多少|几个|几成|比例|占比|多大|金额|数量|几次|多久|几份)/.test(t),
        follow_up: /(具体|刚才|您说的|你说的|也就是说|比如|举个例子)/.test(t),
        leading: /(是不是|是否其实|难道|对吧|对不对)/.test(t),
        bundled_count: Math.max(1, (t.match(/[??]/g) ?? []).length),
        evidence_ask: /(记录|表|数据|单据|单子|资料|统计|汇总|给我看|截图|样本)/.test(t),
      },
      commitments,
      retracts: [],
      trust_moves: [...plus.map((what) => ({ dir: "plus" as const, what })), ...minus.map((what) => ({ dir: "minus" as const, what }))],
      meta_or_injection: meta,
      summary: t.slice(0, 40),
    };
  }
}

/** 脚本化玩家用:每轮的闸门输出由脚本给出(相当于"标准答案"标注),用来确定性地测试导演和算分。 */
export class QueueGate implements GatePort {
  private queue: GateOutput[] = [];
  push(g: GateOutput) {
    this.queue.push(g);
  }
  /** 输入被审核拦下时不会走到闸门,每步结束清掉没用上的标注,免得错位。 */
  clear() {
    this.queue.length = 0;
  }
  async classify(): Promise<GateOutput> {
    const g = this.queue.shift();
    if (!g) throw new Error("QueueGate:没有预置的闸门输出");
    return g;
  }
}

export function gateOutput(partial: Partial<GateOutput>): GateOutput {
  return {
    target_role: null,
    acts: ["ask"],
    matched_triggers: [],
    commitments: [],
    retracts: [],
    trust_moves: [],
    meta_or_injection: false,
    summary: "",
    ...partial,
    question_tags: {
      open: false,
      quantifying: false,
      follow_up: false,
      leading: false,
      bundled_count: 1,
      evidence_ask: false,
      ...partial.question_tags,
    },
  };
}
