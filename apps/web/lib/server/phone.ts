// 大陆手机号:规范化与脱敏(第三轮,手机号登录用)。

/** 接受 11 位大陆手机号,可带 +86 / 86 / 0086 前缀和空格、短横线;返回 "+86" 开头的 E.164,不合法返回 null。 */
export function normalizeCnMobile(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, "").replace(/^(\+86|0086|86)(?=1\d{10}$)/, "");
  return /^1[3-9]\d{9}$/.test(digits) ? `+86${digits}` : null;
}

/** "+8613812345678" → "138****5678"。 */
export function maskPhone(phone: string): string {
  const d = phone.replace(/^\+86/, "");
  return d.length === 11 ? `${d.slice(0, 3)}****${d.slice(7)}` : d;
}
