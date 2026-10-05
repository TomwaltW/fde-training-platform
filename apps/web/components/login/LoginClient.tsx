"use client";
// 登录:邮箱 + 邀请码(老用户可不填)→ 发验证码 → 输入验证码 → 首次登录勾选同意协议(POST /api/me/consent)。
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api, failureMessage, isFailure, safeNext } from "@/lib/client/api";
import { alert, btn, field } from "@/lib/client/ui";

type Step = "checking" | "email" | "code" | "consent";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginClient() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));

  const [step, setStep] = useState<Step>("checking");
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreePrivacy, setAgreePrivacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已经登录:没同意协议的直接到同意那一步,同意过的直接回去
  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((r) => {
        if (!alive) return;
        if (r.user.consentAt) router.replace(next);
        else {
          setEmail(r.user.email ?? "");
          setStep("consent");
        }
      })
      .catch(() => alive && setStep("email"));
    return () => {
      alive = false;
    };
  }, [next, router]);

  // 重发倒计时(服务端 60 秒内只允许请求一次)
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    const addr = email.trim();
    if (!EMAIL_RE.test(addr)) {
      setError("邮箱格式不对");
      return;
    }
    setBusy(true);
    try {
      const inviteCode = invite.trim();
      const r = await api.requestCode(inviteCode ? { email: addr, inviteCode } : { email: addr });
      setDevCode(r.devCode ?? null);
      setCode("");
      setCooldown(60);
      setStep("code");
    } catch (err) {
      if (isFailure(err, "invite_invalid")) setError("邀请码无效或已经用完。第一次登录需要有效的邀请码。");
      else setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      setError("验证码是 6 位数字");
      return;
    }
    setBusy(true);
    try {
      // 新用户的邀请码在验证通过时才消耗,所以这里也要带上
      const inviteCode = invite.trim();
      const r = await api.verify(inviteCode ? { email: email.trim(), code: c, inviteCode } : { email: email.trim(), code: c });
      if (r.user.consentAt) router.replace(next);
      else {
        setStep("consent");
        setBusy(false);
      }
    } catch (err) {
      setError(
        isFailure(err, "code_invalid")
          ? "验证码不对或已经过期"
          : isFailure(err, "invite_invalid")
            ? "邀请码已经用完了。请向发给你邀请码的人再要一个,填好后重新发送验证码。"
            : failureMessage(err),
      );
      setBusy(false);
    }
  }

  async function consent(e: FormEvent) {
    e.preventDefault();
    if (!agreeTerms || !agreePrivacy) return;
    setError(null);
    setBusy(true);
    try {
      await api.consent();
      router.replace(next);
    } catch (err) {
      setError(isFailure(err, "unauthorized") ? "登录已过期,请重新登录" : failureMessage(err));
      if (isFailure(err, "unauthorized")) setStep("email");
      setBusy(false);
    }
  }

  if (step === "checking") return <p className="text-ink-3">加载中…</p>;

  return (
    <div className="flex flex-col gap-5">
      {step === "email" && (
        <form onSubmit={sendCode} className="flex flex-col gap-5" noValidate>
          <div>
            <h1 className="text-2xl font-bold">登录</h1>
            <p className="mt-2 text-[15px] leading-7 text-ink-2">用邮箱收验证码登录,不用设密码。</p>
          </div>
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
            邀请码
            <input
              className={field.input}
              name="invite"
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="第一次登录需要;老用户不用填"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
          </label>
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? "正在发送…" : "发送验证码"}
          </button>
        </form>
      )}

      {step === "code" && (
        <form onSubmit={verify} className="flex flex-col gap-5" noValidate>
          <div>
            <h1 className="text-2xl font-bold">输入验证码</h1>
            <p className="mt-2 text-[15px] leading-7 text-ink-2">
              验证码已发到 <span className="font-medium text-ink">{email.trim()}</span>,10 分钟内有效。没收到的话看看垃圾邮件。
            </p>
          </div>
          {devCode && (
            <p className={alert.warn} data-testid="dev-code">
              开发环境验证码:<strong className="font-mono text-base tracking-widest">{devCode}</strong>
            </p>
          )}
          <label className={field.label}>
            验证码
            <input
              className={`${field.input} font-mono tracking-[0.3em]`}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6 位数字"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              autoFocus
            />
          </label>
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? "正在登录…" : "登录"}
          </button>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn.small} disabled={busy || cooldown > 0} onClick={() => sendCode()}>
              {cooldown > 0 ? `${cooldown} 秒后可以重发` : "重新发送"}
            </button>
            <button
              type="button"
              className={btn.small}
              onClick={() => {
                setStep("email");
                setError(null);
              }}
            >
              换个邮箱
            </button>
          </div>
        </form>
      )}

      {step === "consent" && (
        <form onSubmit={consent} className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-bold">开始之前</h1>
            <p className="mt-2 text-[15px] leading-7 text-ink-2">第一次登录,请先读一下这几点,再勾选同意。</p>
          </div>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-[15px] leading-7 text-ink-2">
            <li>对话内容由 AI 生成。人物、公司、数据都是虚构的,复盘仅供训练参考。</li>
            <li>我们会保存你的对话,用来生成复盘和改进训练内容。你可以随时在「我的对局」里删除全部对局。</li>
            <li>登录只用邮箱,不需要手机号。</li>
          </ul>
          <div className="flex flex-col gap-1">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
              <input type="checkbox" className="size-5 shrink-0 accent-[var(--accent)]" checked={agreeTerms} onChange={(e) => setAgreeTerms(e.target.checked)} />
              <span>
                我已阅读并同意
                <Link href="/legal/terms" target="_blank" className="text-accent underline underline-offset-4">
                  《用户协议》
                </Link>
              </span>
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
              <input type="checkbox" className="size-5 shrink-0 accent-[var(--accent)]" checked={agreePrivacy} onChange={(e) => setAgreePrivacy(e.target.checked)} />
              <span>
                我已阅读并同意
                <Link href="/legal/privacy" target="_blank" className="text-accent underline underline-offset-4">
                  《隐私政策》
                </Link>
              </span>
            </label>
          </div>
          <button type="submit" className={btn.primary} disabled={busy || !agreeTerms || !agreePrivacy}>
            {busy ? "正在保存…" : "同意并继续"}
          </button>
          {(!agreeTerms || !agreePrivacy) && <p className="-mt-2 text-sm text-ink-3">两项都勾选后才能继续。</p>}
        </form>
      )}

      {error && (
        <p role="alert" className={alert.error}>
          {error}
        </p>
      )}
    </div>
  );
}
