"use client";
// 候补名单登记表单:/waitlist 页和落地页的卡片(compact,不问"想用它做什么")共用。
// 来源取当前地址的 ?from=;隐藏的 website 是给机器人的陷阱字段(人看不到、读屏也跳过)。
import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { WaitlistBody, WaitlistRole } from "@fde/contracts";
import { api, failureMessage, isFailure } from "@/lib/client/api";
import { cx } from "@/lib/client/format";
import { alert, btn, field } from "@/lib/client/ui";
import { ROLE_OPTIONS, sourceFromLocation } from "./roles";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistSignup({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WaitlistRole | "">("");
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string; alreadyJoined: boolean } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const addr = email.trim();
    if (!EMAIL_RE.test(addr)) {
      setError("邮箱格式不对");
      return;
    }
    const body: WaitlistBody = { email: addr };
    if (role) body.role = role;
    if (!compact && note.trim()) body.note = note.trim();
    const source = sourceFromLocation();
    if (source) body.source = source;
    if (website) body.website = website;
    setBusy(true);
    try {
      const r = await api.joinWaitlist(body);
      setDone({ email: addr, alreadyJoined: r.alreadyJoined });
    } catch (err) {
      setError(isFailure(err, "bad_request") ? "填写的内容不对,请检查邮箱后重试" : failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div role="status" data-testid="waitlist-done" className={done.alreadyJoined ? alert.info : alert.ok}>
        {done.alreadyJoined ? (
          <>
            <span className="font-medium">{done.email}</span> 已经在候补名单里了,不用重复登记。开放时会发邮件通知你。
          </>
        ) : (
          <>
            登记好了。开放时会把邀请码发到 <span className="font-medium">{done.email}</span>,留意一下垃圾邮件。
          </>
        )}
      </div>
    );

  return (
    <form onSubmit={submit} className="relative flex flex-col gap-4" noValidate data-testid="waitlist-form">
      <div className={compact ? "grid gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "flex flex-col gap-4"}>
        <label className={field.label}>
          邮箱
          <input
            className={field.input}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className={field.label}>
          你的身份(选填)
          <select className={field.input} name="role" value={role} onChange={(e) => setRole(e.target.value as WaitlistRole | "")}>
            <option value="">请选择</option>
            {ROLE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!compact && (
        <label className={field.label}>
          想用它做什么(选填)
          <textarea
            className={field.textarea}
            name="note"
            rows={3}
            maxLength={500}
            placeholder="比如:下个月要去客户现场,想先练练怎么问需求"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}
      {/* 陷阱字段:移出可视区域,不能用 Tab 进入,读屏跳过 */}
      <div aria-hidden className="absolute -left-[10000px] top-0 h-px w-px overflow-hidden">
        <label>
          网站
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>
      <button type="submit" className={cx(btn.primary, compact && "sm:self-start sm:px-8")} disabled={busy}>
        {busy ? "正在提交…" : "加入候补名单"}
      </button>
      <p className="text-[13px] leading-relaxed text-ink-3">
        邮箱只用来给你发邀请码,以及统计候补名单里后来有多少人注册、购买(只看人数),不做营销推送。详见
        <Link href="/legal/privacy" className="whitespace-nowrap text-accent underline underline-offset-4">
          隐私政策
        </Link>
        。
      </p>
      {error && (
        <p role="alert" className={alert.error}>
          {error}
        </p>
      )}
    </form>
  );
}
