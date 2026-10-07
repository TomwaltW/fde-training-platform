// 交付文本审计用的数字规整:把角色台词里的数字(阿拉伯数字、中文数字、口语约数)统一成区间。
// 底层沿用引擎的 extractNumbers(成语、钟点、LT2609/Q3 这类编号它已经处理好),
// 在它后面补上它不管的口语说法:四百多、五十多万、十几个、几十万、上千、三成、两成多、一成八、将近、左右……
// 只回答"这句话里有哪些量",不回答"这个量能不能说"——那是 auditor.ts 的事,也不复用守卫的判定。
import { extractNumbers, foldWidth, round, type NumberMention } from "@fde/engine";

export interface Quantity {
  /** 原文片段(全角已折成半角)。 */
  raw: string;
  index: number;
  /** 闭区间;精确数 lo === hi。百分数以"百分点"为单位(18% → 18)。 */
  lo: number;
  hi: number;
  percent: boolean;
  /** exact 精确数;range 两端都说出来的约数(五六十、两三天、七八成);approx 其他口语约数(四百多、几十万、三成、大概五十万)。 */
  kind: "exact" | "range" | "approx";
  /** 紧跟的量词或单位(没有则为空串;百分数为 %)。 */
  unit: string;
}

export interface ExtractOptions {
  /** 按字面取值,不按口语放宽:"约 19800"取 19800,"三成"取 30%。给真值表、事实原文这类作者写的文字用。 */
  literal?: boolean;
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const BIG: Record<string, number> = { 百: 100, 千: 1000, 万: 10_000, 亿: 100_000_000 };

/** 前置的约数词:"将近五十万""大概三百""小五十万""不到十万"。 */
const APPROX_BEFORE = /(大约|大概|差不多|将近|接近|估计|也就|不到|不足|超过|至少|起码|约|近|快|小)\s*$/;
/** 后置的约数词(中间可以隔一个量词:"三百条左右")。 */
const APPROX_AFTER = /^(左右|上下)/;
const ABOVE_AFTER = /^(出头|开外)/;

const MEASURE =
  /^(分钟|小时|星期|个月|公斤|个|件|票|天|周|月|年|元|块|人|条|份|次|箱|家|单|张|种|类|项|位|名|台|套|批|趟|遍|岁|层|轮|笔|页|行|列|吨|柜|托|板|毛|秒|号)/;
const measureAt = (text: string, i: number) => text.slice(i).match(MEASURE)?.[1] ?? "";

/** 一个数的"末位位值":400 → 100,140000 → 10000,428 → 1。"四百多"就是 [400, 400 + 100]。 */
export function placeValue(v: number): number {
  if (!Number.isInteger(v) || v === 0) return 1;
  let p = 1;
  while (v % (p * 10) === 0) p *= 10;
  return p;
}

/** 有效数字不超过 2 位、以 0 结尾的整数(30、400、430、1500、50 万):口语里多半是约数。 */
export function isRound(v: number): boolean {
  if (!Number.isInteger(v) || v < 10 || v % 10 !== 0) return false;
  return String(v).replace(/0+$/, "").length <= 2;
}

/**
 * "几"字族:没有具体数字,只有数量级。[匹配, 下限, 上限];后面再跟 万/千/百/亿 时整体相乘。
 * 下限低于 10 的("几个""好几天")只有后面跟量词或大单位时才算数,免得把"几乎""几时"当成数。
 */
const JI_FORMS: [RegExp, number, number][] = [
  [/^大几十/, 50, 99],
  [/^大几百/, 500, 999],
  [/^成百上千/, 100, 9999],
  [/^几十/, 20, 99],
  [/^几百/, 200, 999],
  [/^几千/, 2000, 9999],
  [/^几万/, 20_000, 99_999],
  [/^上百/, 100, 999],
  [/^上千/, 1000, 9999],
  [/^上万/, 10_000, 99_999],
  [/^十几/, 11, 19],
  [/^十多/, 10, 20],
  [/^十来/, 10, 20],
  [/^好几/, 3, 9],
  [/^几/, 2, 9],
];
const NOT_JI = /^(几乎|几时|几何|几经|几度|几率|上千万[别不要记])/;
const DIGIT_BEFORE = /[\d零〇一二两俩三四五六七八九十百千万亿]/;

function bigAt(text: string, i: number): { mul: number; len: number } {
  const c = text[i] ?? "";
  return c in BIG ? { mul: BIG[c]!, len: 1 } : { mul: 1, len: 0 };
}

/** 合并约数"五六十""两三天"(引擎拆成两条、带同一个 range)。 */
function mergeRanges(ms: NumberMention[]): (NumberMention & { end: number })[] {
  const out: (NumberMention & { end: number })[] = [];
  for (const m of ms) {
    const end = m.index + m.raw.length;
    const prev = out.at(-1);
    if (prev?.range && m.range && prev.range[0] === m.range[0] && prev.range[1] === m.range[1] && prev.end === m.index) {
      prev.raw += m.raw;
      prev.end = end;
      prev.unit = m.unit;
      prev.percent = m.percent;
      continue;
    }
    out.push({ ...m, end });
  }
  return out;
}

const make = (raw: string, index: number, lo: number, hi: number, percent: boolean, unit: string, kind?: Quantity["kind"]): Quantity => ({
  raw,
  index,
  lo: round(lo),
  hi: round(hi),
  percent,
  kind: kind ?? (lo === hi ? "exact" : "approx"),
  unit,
});

/** 区间按 ±10% 放宽(前后有"大概""左右"之类)。 */
const widen = (q: Quantity): Quantity => (q.kind === "exact" ? { ...q, lo: round(q.lo * 0.9), hi: round(q.hi * 1.1), kind: "approx" } : q);

/**
 * 抽出一句话里的全部"量"。规则(docs/quality-gates.md 有完整的表):
 *   - 精确数:428、四百二十八、6.8万、六万八、十四万八千五、18%、百分之十八、一千五
 *   - X多 / X来 / X余 / X几:[X, X + 末位位值](四百多 = [400, 500];五十多万 = [50 万, 60 万];二十几 = [20, 30])
 *   - 几十、几百、上千、十几、十多、大几十……:数量级区间(几十万 = [20 万, 99 万])
 *   - N成:百分数 [10N − 5, 10N + 5](三成 = 25%–35%);N成多 = [10N, 10N + 10];一成八 = 18%;七八成 = [70, 80]
 *   - 约 / 大概 / 差不多 / 将近 / 左右 / 上下:±10%;出头 / 开外:[X, X + 末位位值]
 *   - 五六十、两三天:[50, 60]、[2, 3]
 */
export function extractQuantities(input: string, opts: ExtractOptions = {}): Quantity[] {
  const text = foldWidth(input);
  const out: Quantity[] = [];
  const taken: [number, number][] = [];

  // 1. "几"字族。先认,盖住引擎从里面抠出来的半截数字("几十万"里的"十万")。
  //    跟在数字后面的"几"("二十几""三百几")交给第 2 步的后缀规则。
  for (let i = 0; i < text.length; i++) {
    if (DIGIT_BEFORE.test(text[i - 1] ?? "")) continue;
    const rest = text.slice(i);
    if (NOT_JI.test(rest)) continue;
    const hit = JI_FORMS.find(([re]) => re.test(rest));
    if (!hit) continue;
    const [re, lo, hi] = hit;
    const len = rest.match(re)![0].length;
    const big = bigAt(text, i + len);
    const unit = measureAt(text, i + len + big.len);
    if (lo < 10 && !big.len && !unit) continue;
    const end = i + len + big.len;
    out.push(make(text.slice(i, end), i, lo * big.mul, hi * big.mul, false, unit, "approx"));
    taken.push([i, end]);
    i = end - 1;
  }
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && x < b);

  // 2. 引擎抽出的数,再看前后的口语修饰
  for (const m of mergeRanges(extractNumbers(text))) {
    if (overlaps(m.index, m.end)) continue;
    let end = m.end;
    let q: Quantity;
    if (m.unit === "成") {
      if (text.startsWith("一成不变", m.index)) continue;
      // 三成、两成多、一成八、七八成
      const after = end + 1;
      const lo = (m.range?.[0] ?? m.value) * 10;
      const hi = (m.range?.[1] ?? m.value) * 10;
      const next = text[after] ?? "";
      if (m.range) {
        q = make(text.slice(m.index, after), m.index, lo, hi, true, "%", "range");
        end = after;
      } else if (next in CN_DIGIT && !measureAt(text, after + 1)) {
        q = make(text.slice(m.index, after + 1), m.index, lo + CN_DIGIT[next]!, lo + CN_DIGIT[next]!, true, "%");
        end = after + 1;
      } else if (next === "多") {
        q = make(text.slice(m.index, after + 1), m.index, lo, lo + 10, true, "%");
        end = after + 1;
      } else {
        q = opts.literal ? make(text.slice(m.index, after), m.index, lo, lo, true, "%") : make(text.slice(m.index, after), m.index, lo - 5, lo + 5, true, "%");
        end = after;
      }
    } else if (m.unit === "个" && /^个(百分)?点/.test(text.slice(end))) {
      // "十八个点""三个百分点":百分点
      const len = text.slice(end).match(/^个(百分)?点/)![0].length;
      q = m.range
        ? make(text.slice(m.index, end + len), m.index, m.range[0], m.range[1], true, "%", "range")
        : make(text.slice(m.index, end + len), m.index, m.value, m.value, true, "%");
      end += len;
    } else if (m.range) {
      q = make(m.raw, m.index, m.range[0], m.range[1], m.percent, m.unit, "range");
    } else {
      q = make(m.raw, m.index, m.value, m.value, m.percent, m.unit);
      // X多 / X来 / X余 / X几,后面可能还跟大单位:"四百多""五十多万""四十来万""二十几万""1万多"
      const suffix = text[end] ?? "";
      const plainOrBig = !m.unit || m.unit === "万" || m.unit === "千" || m.unit === "亿";
      if (plainOrBig && !m.percent && /[多来余几]/.test(suffix) && !/^来[了过的说看找问]/.test(text.slice(end))) {
        const big = bigAt(text, end + 1);
        const lo = m.value * big.mul;
        const after = end + 1 + big.len;
        q = make(text.slice(m.index, after), m.index, lo, lo + placeValue(m.value) * big.mul, false, measureAt(text, after));
        end = after;
      }
    }
    if (!opts.literal) {
      // 后置:左右、上下、出头、开外
      const rest = text.slice(end);
      const restAfterUnit = rest.slice(measureAt(text, end).length);
      if (APPROX_AFTER.test(rest) || APPROX_AFTER.test(restAfterUnit)) q = widen(q);
      else if ((ABOVE_AFTER.test(rest) || ABOVE_AFTER.test(restAfterUnit)) && q.kind === "exact") {
        q = { ...q, hi: round(q.lo + placeValue(q.lo)), kind: "approx" };
      }
      // 前置:将近、大概、小……
      if (APPROX_BEFORE.test(text.slice(Math.max(0, m.index - 3), m.index))) q = widen(q);
    }
    out.push(q);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 区间的可读写法:428、[400, 500]、18%、[25%, 35%]。 */
export function showQuantity(q: Pick<Quantity, "lo" | "hi" | "percent">): string {
  const f = (v: number) => (q.percent ? `${v}%` : String(v));
  return q.lo === q.hi ? f(q.lo) : `[${f(q.lo)}, ${f(q.hi)}]`;
}
