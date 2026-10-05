// 从中文口语里抽数字:阿拉伯数字、中文数字(含"一万八""六万八""四十九点八万"这类口语)、百分数。
// 守卫用它做数字白名单(方案 3.3.5 防编造第 1 条)。

export interface NumberMention {
  value: number;
  raw: string;
  index: number;
  /** 紧跟在数字后面的量词或单位(没有则为空串)。 */
  unit: string;
  percent: boolean;
  /** 约数("五六十个人")的两端;守卫里只要有一端在白名单内,整个约数就放行。 */
  range?: [number, number];
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_SMALL: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG: Record<string, number> = { 万: 10_000, 亿: 100_000_000 };

/** 单个中文数字字只有后面跟着这些量词或单位时才算数(避免"一下""一直""统一"之类)。 */
const MEASURES = [
  "分钟", "小时", "星期", "个月", "公斤", "立方", "点钟", "点半",
  "个", "件", "票", "天", "周", "月", "年", "万", "千", "百", "元", "块", "人", "条", "份", "次",
  "箱", "点", "成", "倍", "号", "家", "单", "张", "种", "类", "项", "位", "名", "台", "套", "批",
  "趟", "遍", "岁", "层", "轮", "笔", "页", "行", "列", "吨", "柜", "托", "板", "毛", "%",
];

function matchMeasure(s: string, i: number): string {
  for (const m of MEASURES) if (s.startsWith(m, i)) return m;
  return "";
}

/** 从 start 开始尽量长地解析一个中文数字;解析不出返回 null。 */
function parseCnAt(s: string, start: number): { value: number; end: number } | null {
  let total = 0;
  let section = 0;
  let num = -1;
  let lastSmall = 0;
  let lastBig = 0;
  let sawZero = false;
  let i = start;
  while (i < s.length) {
    const c = s[i]!;
    if (c in CN_DIGITS) {
      if (CN_DIGITS[c] === 0) {
        if (i === start) break;
        sawZero = true;
        i++;
        continue;
      }
      if (num !== -1) break; // 两个数字连着:"一千八一天"在"八"后面停下
      num = CN_DIGITS[c]!;
      i++;
      continue;
    }
    if (c in CN_SMALL) {
      if (num === -1) {
        if (c === "十" && section === 0) num = 1; // 十二 = 12
        else break;
      }
      section += num * CN_SMALL[c]!;
      lastSmall = CN_SMALL[c]!;
      num = -1;
      sawZero = false;
      i++;
      continue;
    }
    if (c in CN_BIG) {
      if (num !== -1) section += num;
      num = -1;
      if (section === 0 && total === 0) break;
      total += section * CN_BIG[c]!;
      section = 0;
      lastSmall = 0;
      lastBig = CN_BIG[c]!;
      sawZero = false;
      i++;
      continue;
    }
    break;
  }
  if (i === start) return null;
  if (num !== -1) {
    if (!sawZero && lastSmall > 1) section += (num * lastSmall) / 10; // 一千八 = 1800
    else if (!sawZero && section === 0 && lastBig > 1) total += (num * lastBig) / 10; // 六万八 = 68000
    else section += num;
  }
  let value = total + section;
  // 小数:"四十九点八万"
  if (s[i] === "点" && s[i + 1]! in CN_DIGITS) {
    let j = i + 1;
    let frac = "";
    while (j < s.length && s[j]! in CN_DIGITS) frac += String(CN_DIGITS[s[j]!]), j++;
    const big = CN_BIG[s[j] ?? ""];
    if (big && total === 0) {
      value = (section + Number(`0.${frac}`)) * big;
      i = j + 1;
    } else if (!big) {
      value = value + Number(`0.${frac}`);
      i = j;
    }
  }
  if (i === start || Number.isNaN(value)) return null;
  return { value: round(value), end: i };
}

const ARABIC = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(万|亿|千)?\s*(%|％)?/y;
const CN_CHARS = /[零〇一二两俩三四五六七八九十百千万亿]/;
const CN_DIGIT_ONLY = /[零〇一二两俩三四五六七八九]/;

/** 全角数字和符号折成半角(保留中文逗号"，"),长度不变,下标仍对得上。 */
export const foldWidth = (s: string) =>
  s.replace(/[！-～]/g, (c) => (c === "，" ? c : String.fromCharCode(c.charCodeAt(0) - 0xfee0))).replace(/　/g, " ");

/** 含数字的成语和惯用说法,不当数字。 */
const IDIOMS = [
  "三天两头", "三番五次", "三天打鱼", "七上八下", "一五一十", "三三两两", "四面八方", "乱七八糟", "十有八九",
  "三心二意", "一清二楚", "一干二净", "五花八门", "千方百计", "七嘴八舌", "九牛一毛", "一模一样", "一来二去",
  "一天到晚", "三言两语", "千千万万", "万无一失", "一五一十", "接二连三", "颠三倒四", "丢三落四",
];

const CN_D = "[零〇一二两三四五六七八九十]";
const CLOCK = new RegExp(`(${CN_D}{1,3}|\\d{1,2})(点钟|点|:)(半|一刻|三刻|(${CN_D}{1,3}|\\d{1,2})(分)?)?`, "y");
const NOT_CLOCK_AFTER = /^[万亿千百%倍个元块]/;
/** 口语里的分钟:"零五""十五""二十""三十八";逐位读的"二八""四五"是小数,不是分钟。 */
const CN_MINUTES = /^(零[一二三四五六七八九]|十[一二三四五六七八九]?|[二三四五]十[一二三四五六七八九]?)$/;

/** 钟点:"三点""八点二十""十点半""8:30"。返回小时数和结束位置;不是钟点返回 null。 */
function clockAt(text: string, i: number): { hour: number; end: number } | null {
  CLOCK.lastIndex = i;
  const m = CLOCK.exec(text);
  if (!m) return null;
  let h: number | undefined;
  if (/^\d+$/.test(m[1]!)) h = Number(m[1]);
  else {
    const p = parseCnAt(m[1]!, 0);
    if (p && p.end === m[1]!.length) h = p.value;
  }
  if (h === undefined || h > 24) return null;
  const sep = m[2]!;
  const end = CLOCK.lastIndex;
  const rest = text.slice(end);
  if (sep === ":") {
    // 8:30 是钟点;3:1、3:7 是比例
    if (!m[4] || !/^\d{2}$/.test(m[4]) || Number(m[4]) >= 60) return null;
    return { hour: h, end };
  }
  if (!m[3]) return { hour: h, end }; // "三点" "三点钟"
  if (m[3] === "半" || m[3] === "一刻" || m[3] === "三刻") return { hour: h, end };
  const mins = m[4]!;
  if (m[5]) {
    // "八点五分" 是 8:05;"四点五分钟" 是 4.5 分钟,按小数检查
    if (rest.startsWith("钟")) return null;
    return /^\d+$/.test(mins) || CN_MINUTES.test(mins) || /^[一二三四五六七八九]$/.test(mins) ? { hour: h, end } : null;
  }
  if (NOT_CLOCK_AFTER.test(rest)) return null;
  if (/^\d+$/.test(mins)) return mins.length === 2 && Number(mins) < 60 ? { hour: h, end } : null; // "8点30";"7点5" 是小数
  return CN_MINUTES.test(mins) ? { hour: h, end } : null;
}

export function extractNumbers(input: string): NumberMention[] {
  const text = foldWidth(input);
  const out: NumberMention[] = [];
  const covered = new Set<number>();
  for (const w of IDIOMS) {
    for (let k = text.indexOf(w); k >= 0; k = text.indexOf(w, k + 1)) for (let j = 0; j < w.length; j++) covered.add(k + j);
  }
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (covered.has(i)) {
      i++;
      continue;
    }
    // 钟点按"点"计,守卫对 24 以内的钟点放行
    if (/\d/.test(c) || CN_CHARS.test(c)) {
      const clk = (i === 0 || !/[A-Za-z\d.]/.test(text[i - 1]!)) ? clockAt(text, i) : null;
      if (clk) {
        out.push({ value: clk.hour, raw: text.slice(i, clk.end), index: i, unit: "点", percent: false });
        i = clk.end;
        continue;
      }
    }
    // 百分之三十一
    if (text.startsWith("百分之", i)) {
      const r = parseCnAt(text, i + 3);
      if (r) {
        out.push({ value: r.value, raw: text.slice(i, r.end), index: i, unit: "%", percent: true });
        i = r.end;
        continue;
      }
    }
    if (/\d/.test(c)) {
      // 前面紧挨着字母的数字(如 Q3、LT2609)按编号处理,整体跳过
      if (i > 0 && /[A-Za-z]/.test(text[i - 1]!)) {
        while (i < text.length && /[\d-]/.test(text[i]!)) i++;
        continue;
      }
      ARABIC.lastIndex = i;
      const m = ARABIC.exec(text);
      if (m) {
        let value = Number(m[1]!.replace(/,/g, "") + (m[2] ?? ""));
        if (m[3]) value *= m[3] === "万" ? 10_000 : m[3] === "亿" ? 100_000_000 : 1000;
        const end = ARABIC.lastIndex;
        const percent = Boolean(m[4]);
        out.push({
          value: round(value),
          raw: m[0].trim(),
          index: i,
          unit: percent ? "%" : m[3] ? m[3] : matchMeasure(text, end),
          percent,
        });
        i = end;
        continue;
      }
    }
    if (CN_CHARS.test(c)) {
      const r = parseCnAt(text, i);
      if (r) {
        const consumed = r.end - i;
        const unit = matchMeasure(text, r.end);
        const raw = text.slice(i, r.end);
        const isWord = ["万一", "千万", "一一"].some((w) => text.startsWith(w, i));
        // 约数"五六个人""五六十个人""四五万块":第一个数字借用后一个数字的数量级和量词
        let rangeUnit = "";
        let lo = r.value;
        let hi: number | undefined;
        if (consumed === 1 && !unit && CN_DIGIT_ONLY.test(text[r.end] ?? "")) {
          const r2 = parseCnAt(text, r.end);
          if (r2) {
            rangeUnit = matchMeasure(text, r2.end);
            if (rangeUnit) {
              hi = r2.value;
              lo = parseCnAt(text[i]! + text.slice(r.end + 1, r2.end), 0)?.value ?? r.value;
            }
          }
        }
        if (!isWord && (consumed >= 2 || unit || rangeUnit)) {
          const u = unit || rangeUnit;
          out.push({ value: round(lo), raw, index: i, unit: u, percent: u === "%", ...(hi !== undefined && { range: [round(lo), round(hi)] as [number, number] }) });
        }
        i = r.end;
        continue;
      }
    }
    i++;
  }
  // 约数的后一个数字也带上同一个 range,守卫按整个约数判断
  for (let k = 0; k + 1 < out.length; k++) {
    const r = out[k]!.range;
    if (r && !out[k + 1]!.range && out[k + 1]!.value === r[1]) out[k + 1]!.range = r;
  }
  return out;
}

export function numberSet(texts: Iterable<string>): Set<number> {
  const s = new Set<number>();
  for (const t of texts) for (const n of extractNumbers(t)) s.add(round(n.value));
  return s;
}

export const round = (v: number) => Math.round(v * 1000) / 1000;
