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
  /** 带"大概""左右"之类放宽过的精确数:放宽前说出的那个数("差不多四百三"是 430)。审计比对已知值时用它,不用放宽后的区间。 */
  center?: number;
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
 * 前面是"百分之"、后面是"个点 / 个百分点 / %"时是百分数("百分之十几""十几个点""四十几个点"),区间不变。
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
  [/^近百/, 90, 100],
  [/^近千/, 900, 1000],
  [/^近万/, 9000, 10_000],
  [/^百把/, 100, 199],
  [/^千把/, 1000, 1999],
  [/^万把/, 10_000, 19_999],
  [/^十几/, 11, 19],
  [/^十多/, 10, 20],
  [/^十来/, 10, 20],
  [/^好几/, 3, 9],
  [/^几/, 2, 9],
];
const NOT_JI = /^(几乎|几时|几何|几经|几度|几率|[上近]千万[别不要记])/;
const DIGIT_BEFORE = /[\d零〇一二两俩三四五六七八九十百千万亿]/;
/** 紧跟在数后面、说明它是百分数的写法:"十几个点""三十多个百分点""30多%"。返回这段写法的长度,不是百分数时返回 0。 */
const percentAfter = (text: string, i: number) => text.slice(i).match(/^(个百分点|个点|%)/)?.[0].length ?? 0;

/**
 * "一半"字族和分数,都是百分数的约数。"差不多一半"要整体先认,免得从"多一半"那里认起。
 * "大半天""大半年"说的是时间,"多半"是"多半是看错了"(大概),都不算。
 */
const HALF_FORMS: [RegExp, number, number][] = [
  [/^(将近|接近|不到|不足|小)一半/, 40, 50],
  [/^(差不多|大概|大约|约)一半/, 45, 55],
  [/^一小半/, 30, 50],
  [/^(一多半|多一半|一大半|一半多|过半|超过一半)/, 50, 70],
  [/^大半(?![天年夜辈个月生日])/, 50, 70],
  [/^(一半|半数)/, 45, 55],
];
const NOT_HALF = /^(一半天|一半儿)/;
/** "三分之一""四分之一""千分之三":按百分数算,本身就是约数,按 ±10% 放宽(三分之一 = [30%, 36.7%])。 */
const FRACTION = /^([一二两三四五六七八九十]{1,3}|\d{1,3}|千)分之([一二两三四五六七八九十]{1,3}|\d{1,3})/;

/** 分数的分子、分母:1–99 的整数(三、十、十五、九十九),外加"千分之"的千。 */
function smallInt(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "千") return 1000;
  const d = (c: string | undefined) => (c === undefined ? undefined : CN_DIGIT[c]);
  if (s.length === 1) return s === "十" ? 10 : d(s);
  const m = s.match(/^([一二两三四五六七八九]?)十([一二三四五六七八九]?)$/);
  if (!m) return undefined;
  return (m[1] ? d(m[1])! : 1) * 10 + (m[2] ? d(m[2])! : 0);
}

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

/**
 * "四五百有没有""两三百吧":后面没跟量词时,引擎只认出后一半("五百"),前一个数字被当成单字丢掉。
 * 后一半是"一个数字 + 一个数量级"、前一个字正好小 1、再往前不是数时,补成两端都说出来的约数 [400, 500]。
 */
const BIG_OR_TEN: Record<string, number> = { 十: 10, ...BIG };
function leadingRange(text: string, m: NumberMention): [number, number] | undefined {
  if (m.range || m.percent || !/^[二三四五六七八九][十百千万]$/.test(m.raw)) return undefined;
  const d1 = CN_DIGIT[text[m.index - 1] ?? ""];
  const d2 = CN_DIGIT[m.raw[0]!]!;
  if (d1 === undefined || d1 + 1 !== d2 || DIGIT_BEFORE.test(text[m.index - 2] ?? "")) return undefined;
  return [d1 * BIG_OR_TEN[m.raw[1]!]!, m.value];
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

/** 区间按 ±10% 放宽(前后有"大概""左右"之类);记下放宽前的数。 */
const widen = (q: Quantity): Quantity => (q.kind === "exact" ? { ...q, lo: round(q.lo * 0.9), hi: round(q.hi * 1.1), kind: "approx", center: q.lo } : q);

/**
 * 抽出一句话里的全部"量"。规则(docs/quality-gates.md 有完整的表):
 *   - 精确数:428、四百二十八、6.8万、六万八、十四万八千五、18%、百分之十八、一千五
 *   - X多 / X来 / X余 / X几:[X, X + 末位位值](四百多 = [400, 500];五十多万 = [50 万, 60 万];二十几 = [20, 30])
 *   - 几十、几百、上千、十几、十多、大几十……:数量级区间(几十万 = [20 万, 99 万]);近千 = [900, 1000];千把 = [1000, 1999]
 *   - 百分数也一样:百分之十几 = 十几个点 = [11%, 19%];百分之三十多 = 30多% = 三十多个点 = [30%, 40%]
 *   - N成:百分数 [10N − 5, 10N + 5](三成 = 25%–35%);N成多 = [10N, 10N + 10];一成八 = 18%;七八成 = [70, 80]
 *   - 一半 = [45%, 55%];将近一半 = [40%, 50%];一多半 = [50%, 70%];三分之一 = [30%, 36.7%](分数按 ±10%)
 *   - 约 / 大概 / 差不多 / 将近 / 左右 / 上下:±10%;出头 / 开外:[X, X + 末位位值]
 *   - 五六十、两三天、四五百(后面没跟量词也算):[50, 60]、[2, 3]、[400, 500]
 */
export function extractQuantities(input: string, opts: ExtractOptions = {}): Quantity[] {
  const text = foldWidth(input);
  const out: Quantity[] = [];
  const taken: [number, number][] = [];

  // 1. "几"字族、"一半"字族、分数。先认,盖住引擎从里面抠出来的半截数字("几十万"里的"十万"、"百分之十几"里的"百分之十")。
  //    跟在数字后面的"几"("二十几""三百几")交给第 2 步的后缀规则。
  const take = (q: Quantity, end: number) => {
    out.push(q);
    taken.push([q.index, end]);
    return end - 1;
  };
  for (let i = 0; i < text.length; i++) {
    if (DIGIT_BEFORE.test(text[i - 1] ?? "")) continue;
    const rest = text.slice(i);
    // 分数:三分之一、四分之一(百分之 N 是精确的百分数,由引擎认)
    const fr = rest.match(FRACTION);
    if (fr) {
      const den = smallInt(fr[1]!);
      const num = smallInt(fr[2]!);
      if (den && den >= 2 && num !== undefined) {
        const v = (num / den) * 100;
        i = take(make(fr[0], i, v * 0.9, v * 1.1, true, "%", "approx"), i + fr[0].length);
        continue;
      }
    }
    if (!NOT_HALF.test(rest)) {
      const half = HALF_FORMS.find(([re]) => re.test(rest));
      if (half) {
        const len = rest.match(half[0])![0].length;
        i = take(make(text.slice(i, i + len), i, half[1], half[2], true, "%", "approx"), i + len);
        continue;
      }
    }
    if (NOT_JI.test(rest)) continue;
    const hit = JI_FORMS.find(([re]) => re.test(rest));
    if (!hit) continue;
    const [re, lo, hi] = hit;
    const len = rest.match(re)![0].length;
    const big = bigAt(text, i + len);
    let end = i + len + big.len;
    // 百分数:"百分之十几""十几个点""十几%"
    const pctBefore = !big.len && text.slice(Math.max(0, i - 3), i) === "百分之";
    const pctAfter = big.len ? 0 : percentAfter(text, end);
    if (pctBefore || pctAfter) {
      const start = pctBefore ? i - 3 : i;
      end += pctAfter;
      i = take(make(text.slice(start, end), start, lo, hi, true, "%", "approx"), end);
      continue;
    }
    const unit = measureAt(text, end);
    if (lo < 10 && !big.len && !unit) continue;
    i = take(make(text.slice(i, end), i, lo * big.mul, hi * big.mul, false, unit, "approx"), end);
  }
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && x < b);

  // 2. 引擎抽出的数,再看前后的口语修饰
  for (const m of mergeRanges(extractNumbers(text))) {
    if (overlaps(m.index, m.end)) continue;
    let end = m.end;
    let q: Quantity;
    const lead = leadingRange(text, m);
    if (m.unit === "成") {
      // "一成不变";"九成九是看错了"是"十有八九"一类的口头禅,不是 99%
      if (text.startsWith("一成不变", m.index) || text.startsWith("九成九", m.index)) continue;
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
    } else if (lead) {
      q = make(text.slice(m.index - 1, end), m.index - 1, lead[0], lead[1], false, m.unit, "range");
    } else {
      q = make(m.raw, m.index, m.value, m.value, m.percent, m.unit);
      // "夜里十一二点":十一点到十二点,是钟点,不是一个"十一"
      if (!m.unit && !m.percent && Number.isInteger(m.value) && m.value >= 10 && m.value <= 23 && /^[一二两三四五六七八九]点/.test(text.slice(end))) {
        q = { ...q, unit: "点" };
      }
      // X多 / X来 / X余 / X几,后面可能还跟大单位:"四百多""五十多万""四十来万""二十几万""1万多";
      // 百分数也一样:"百分之三十多""30%多",以及后面才说是百分数的"30多%""二十多个点"
      const suffix = text[end] ?? "";
      const plainOrBig = !m.unit || m.unit === "万" || m.unit === "千" || m.unit === "亿";
      if ((plainOrBig || m.percent) && /[多来余几]/.test(suffix) && !/^来[了过的说看找问]/.test(text.slice(end))) {
        const big = m.percent ? { mul: 1, len: 0 } : bigAt(text, end + 1);
        const lo = m.value * big.mul;
        let after = end + 1 + big.len;
        const pct = m.percent ? 0 : big.len ? 0 : percentAfter(text, after);
        const percent = m.percent || pct > 0;
        after += pct;
        q = make(text.slice(m.index, after), m.index, lo, lo + placeValue(m.value) * big.mul, percent, percent ? "%" : measureAt(text, after));
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
