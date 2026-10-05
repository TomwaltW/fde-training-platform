// 不接模型时的演员、裁判、复盘。输出确定,用于测试、回归评测(离线模式)和命令行调试。
import { renderDebriefMarkdown } from "../debrief.ts";
import type { JudgeOutput } from "../judge.ts";
import type { ActorInput, ActorPort, DebriefPort, JudgePort } from "../ports.ts";

const OPENERS: Record<string, string> = {
  test_user: "(上下打量你)你之前做过这行吗?",
  guarded: "(没接话)你先说说,你是来干嘛的?",
  impatient: "(看了眼手表)",
  confused: "你说的这些我听不懂。说正事吧。",
  push_back: "(皱眉)",
};

export class TemplateActor implements ActorPort {
  async speak({ scn, st, plan }: ActorInput): Promise<string> {
    const d = plan.directive!;
    const parts: string[] = [];
    if (OPENERS[d.stance]) parts.push(OPENERS[d.stance]!);
    if (d.stance === "pocket") {
      const mine = st.ledger.filter((e) => e.turn === st.turn).map((e) => e.valueText);
      parts.push(`${mine.join(",")}。行,我记下了。`);
    }
    if (d.beat) parts.push(`(${d.beat})`);
    for (const r of plan.reveals) parts.push(r.level === "L1" ? r.text : `具体是这样:${r.text}`);
    for (const h of plan.hints) {
      if (h.kind === "redirect" && h.toRole) parts.push(`这个你得问${scn.role(h.toRole).name}。`);
    }
    if (d.stance === "confused") return parts.join("");
    if (!parts.length) parts.push("嗯。");
    return parts.join("");
  }
}

export class FixtureJudge implements JudgePort {
  constructor(private output: JudgeOutput | (() => JudgeOutput)) {}
  async judge(): Promise<unknown> {
    return typeof this.output === "function" ? this.output() : this.output;
  }
}

export class TemplateDebrief implements DebriefPort {
  async write({ st, data }: Parameters<DebriefPort["write"]>[0]): Promise<string> {
    return renderDebriefMarkdown(data, st);
  }
}
