// 发验证码邮件(阿里云邮件推送 SMTP)。没有 SMTP_URL 时不发。
import { optionalEnv } from "./env.ts";
import { runtime } from "./runtime.ts";

export function mailConfigured(): boolean {
  return optionalEnv("SMTP_URL") !== null;
}

async function transport(url: string) {
  const rt = runtime();
  if (rt.mailer?.url === url) return rt.mailer.transport;
  // 只有配置了 SMTP 才加载 nodemailer
  const nodemailer = await import("nodemailer");
  const t = nodemailer.createTransport(url);
  rt.mailer = { url, transport: t };
  return t;
}

/** 发一封纯文本邮件(第三轮:邀请邮件等);没配置 SMTP 返回 false。发送失败抛错。 */
export async function sendMail(msg: { to: string; subject: string; text: string }): Promise<boolean> {
  const url = optionalEnv("SMTP_URL");
  if (!url) return false;
  const t = await transport(url);
  const from = optionalEnv("MAIL_FROM") ?? "FDE 训练场 <no-reply@localhost>";
  await t.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text });
  return true;
}

/** 发出验证码;没配置 SMTP 返回 false。发送失败抛错。 */
export async function sendLoginCodeMail(to: string, code: string): Promise<boolean> {
  const url = optionalEnv("SMTP_URL");
  if (!url) return false;
  const t = await transport(url);
  const from = optionalEnv("MAIL_FROM") ?? "FDE 训练场 <no-reply@localhost>";
  await t.sendMail({
    from,
    to,
    subject: `FDE 训练场登录验证码:${code}`,
    text: [`你的登录验证码是 ${code},10 分钟内有效。`, "", "如果不是你本人操作,请忽略这封邮件。"].join("\n"),
  });
  return true;
}
