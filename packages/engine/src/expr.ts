// 条件表达式:用于 requires、traps.when、premature_until、caps.if。
//
//   phase==kickoff and exchanges.zhou>=2
//   trust.chen>=1
//   not auth_finance
//   only_talked_to(zhou)
//
// 标识符解析交给调用方(Resolver)。比较右侧如果是解析不到的标识符,按字面字符串处理(phase==report)。
// 写不成表达式的条件(例如"用户向周总问操作细节")由闸门识别,见 triggers.ts。
import type { Requirement } from "./scenario/schema.ts";

export type Value = number | boolean | string | undefined;

export interface Resolver {
  /** 返回 undefined 表示未知标识符。 */
  get(name: string): Value;
  call?(fn: string, args: string[]): boolean | undefined;
}

export type ExprNode = Node;
type Node =
  | { t: "num"; v: number }
  | { t: "id"; name: string }
  | { t: "call"; fn: string; args: string[] }
  | { t: "not"; e: Node }
  | { t: "and" | "or"; l: Node; r: Node }
  | { t: "cmp"; op: string; l: Node; r: Node };

const TOKEN = /\s*(>=|<=|==|!=|>|<|\(|\)|,|[A-Za-z_][A-Za-z0-9_.]*|-?\d+(?:\.\d+)?)/y;

function tokenize(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m || m.index !== pos) throw new ExprError(`无法解析: "${src}"(位置 ${pos})`);
    out.push(m[1]!);
    pos = TOKEN.lastIndex;
  }
  return out;
}

export class ExprError extends Error {}

function parseTokens(tokens: string[], src: string): Node {
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (tok: string) => {
    if (next() !== tok) throw new ExprError(`"${src}" 缺少 ${tok}`);
  };

  const atom = (): Node => {
    const tok = next();
    if (tok === undefined) throw new ExprError(`"${src}" 意外结束`);
    if (tok === "(") {
      const e = or();
      expect(")");
      return e;
    }
    if (/^-?\d/.test(tok)) return { t: "num", v: Number(tok) };
    if (/^[A-Za-z_]/.test(tok)) {
      if (tok === "and" || tok === "or" || tok === "not") throw new ExprError(`"${src}" 位置错误的 ${tok}`);
      if (peek() === "(") {
        next();
        const args: string[] = [];
        while (peek() !== ")") {
          const a = next();
          if (a === undefined || !/^[A-Za-z_0-9]/.test(a)) throw new ExprError(`"${src}" 函数参数错误`);
          args.push(a);
          if (peek() === ",") next();
        }
        expect(")");
        return { t: "call", fn: tok, args };
      }
      return { t: "id", name: tok };
    }
    throw new ExprError(`"${src}" 意外的 ${tok}`);
  };
  const cmp = (): Node => {
    const l = atom();
    const op = peek();
    if (op && ["==", "!=", ">=", "<=", ">", "<"].includes(op)) {
      next();
      return { t: "cmp", op, l, r: atom() };
    }
    return l;
  };
  const not = (): Node => {
    if (peek() === "not") {
      next();
      return { t: "not", e: not() };
    }
    return cmp();
  };
  const and = (): Node => {
    let l = not();
    while (peek() === "and") {
      next();
      l = { t: "and", l, r: not() };
    }
    return l;
  };
  const or = (): Node => {
    let l = and();
    while (peek() === "or") {
      next();
      l = { t: "or", l, r: and() };
    }
    return l;
  };

  const e = or();
  if (i !== tokens.length) throw new ExprError(`"${src}" 有多余内容: ${tokens.slice(i).join(" ")}`);
  return e;
}

const cache = new Map<string, Node>();

export function parseExpr(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    n = parseTokens(tokenize(src), src);
    cache.set(src, n);
  }
  return n;
}

/** 能否写成表达式。不能的(自然语言条件)交给闸门识别。 */
export function isExpression(src: string): boolean {
  try {
    parseExpr(src);
    return true;
  } catch {
    return false;
  }
}

/** 收集表达式里出现的标识符和函数调用,供场景校验器检查引用。 */
export function exprIdentifiers(src: string): { ids: string[]; calls: { fn: string; args: string[] }[] } {
  const ids: string[] = [];
  const calls: { fn: string; args: string[] }[] = [];
  const walk = (n: Node, rhs = false) => {
    switch (n.t) {
      case "id":
        if (!rhs) ids.push(n.name);
        break;
      case "call":
        calls.push({ fn: n.fn, args: n.args });
        break;
      case "not":
        walk(n.e);
        break;
      case "and":
      case "or":
        walk(n.l);
        walk(n.r);
        break;
      case "cmp":
        walk(n.l);
        walk(n.r, true);
        break;
    }
  };
  walk(parseExpr(src));
  return { ids, calls };
}

function value(n: Node, r: Resolver, rhs: boolean): Value {
  switch (n.t) {
    case "num":
      return n.v;
    case "id": {
      const v = r.get(n.name);
      if (v === undefined) {
        if (rhs) return n.name;
        throw new ExprError(`未知标识符: ${n.name}`);
      }
      return v;
    }
    default:
      return truthy(n, r);
  }
}

function truthy(n: Node, r: Resolver): boolean {
  switch (n.t) {
    case "num":
      return n.v !== 0;
    case "id":
      return Boolean(value(n, r, false));
    case "call": {
      const v = r.call?.(n.fn, n.args);
      if (v === undefined) throw new ExprError(`未知函数: ${n.fn}`);
      return v;
    }
    case "not":
      return !truthy(n.e, r);
    case "and":
      return truthy(n.l, r) && truthy(n.r, r);
    case "or":
      return truthy(n.l, r) || truthy(n.r, r);
    case "cmp": {
      const a = value(n.l, r, false);
      const b = value(n.r, r, true);
      switch (n.op) {
        case "==":
          return a === b;
        case "!=":
          return a !== b;
        case ">=":
          return Number(a) >= Number(b);
        case "<=":
          return Number(a) <= Number(b);
        case ">":
          return Number(a) > Number(b);
        case "<":
          return Number(a) < Number(b);
      }
      throw new ExprError(`未知运算符 ${n.op}`);
    }
  }
}

export function evalExpr(src: string, r: Resolver): boolean {
  return truthy(parseExpr(src), r);
}

export function evalRequirement(req: Requirement | undefined, r: Resolver): boolean {
  if (req === undefined) return true;
  if (typeof req === "string") return evalExpr(req, r);
  if (Array.isArray(req)) return req.every((x) => evalRequirement(x, r));
  if ("any" in req) return req.any.some((x) => evalRequirement(x, r));
  return req.all.every((x) => evalRequirement(x, r));
}

/** 把 Requirement 展平成表达式字符串列表(校验器用)。 */
export function requirementLeaves(req: Requirement | undefined): string[] {
  if (req === undefined) return [];
  if (typeof req === "string") return [req];
  if (Array.isArray(req)) return req.flatMap(requirementLeaves);
  if ("any" in req) return req.any.flatMap(requirementLeaves);
  return req.all.flatMap(requirementLeaves);
}
