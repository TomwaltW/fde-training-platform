// 候补名单的身份选项(契约 WAITLIST_ROLES 的中文说法)和来源参数。
// 只用 import type 引用契约,不把契约的运行时打进浏览器包;Record 保证五种身份一个不漏。
import type { WaitlistRole } from "@fde/contracts";

export const ROLE_LABELS: Record<WaitlistRole, string> = {
  fde: "在做 FDE / 解决方案",
  career_switch: "在职,想转 FDE",
  student: "学生",
  hiring: "招聘或培训负责人",
  other: "其他",
};

export const ROLE_OPTIONS = Object.entries(ROLE_LABELS) as [WaitlistRole, string][];

/** 名单里的身份 → 中文;没填为 "—"。 */
export function roleLabel(role: string | null): string {
  return role !== null && Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role as WaitlistRole] : "—";
}

/** 当前地址里的 ?from=(xhs、jike、wechat……);规则和服务端一样:字母数字 - _,最长 32,不合法的不要。 */
export function sourceFromLocation(): string | null {
  try {
    const v = new URLSearchParams(window.location.search).get("from");
    return v && /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
