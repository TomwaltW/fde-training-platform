"use client";
// 兑换页:输入兑换码(链接里的 ?code= 预填)→ 兑换 → 显示解锁了什么。
// 没登录(或还没同意协议)先去登录页,做完再带着兑换码回到这里。
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { RedeemResponse } from "@fde/contracts";
import { Markdown } from "@/components/Markdown";
import { IncludesList, listsScenarios, useScenarioTitles } from "@/components/presale/Includes";
import { api, failureMessage, isFailure, loginHref } from "@/lib/client/api";
import { cx } from "@/lib/client/format";
import { useMe } from "@/lib/client/hooks";
import { alert, btn, card, field, pageWrap } from "@/lib/client/ui";

/** 回到兑换页的地址(带上兑换码,登录回来不用再输一遍)。 */
function redeemHref(code: string): string {
  const c = code.trim();
  return c ? `/redeem?code=${encodeURIComponent(c)}` : "/redeem";
}

export function RedeemClient() {
  const router = useRouter();
  const params = useSearchParams();
  const prefill = (params.get("code") ?? "").trim().slice(0, 64);
  const [me] = useMe();
  const [code, setCode] = useState(prefill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RedeemResponse | null>(null);

  const needsLogin = me.status === "anon" || (me.status === "ok" && !me.user.consentAt);
  useEffect(() => {
    if (needsLogin) router.replace(loginHref(redeemHref(prefill)));
  }, [needsLogin, prefill, router]);

  const titles = useScenarioTitles(done ? listsScenarios([done.entitlement]) : false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = code.trim();
    if (!c) {
      setError("请输入兑换码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDone(await api.redeem({ code: c }));
    } catch (err) {
      if (isFailure(err, "unauthorized", "consent_required")) {
        router.replace(loginHref(redeemHref(c)));
        return;
      }
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function again() {
    setDone(null);
    setCode("");
    setError(null);
  }

  if (me.status === "loading" || needsLogin) return <main className={cx(pageWrap, "text-ink-3")}>加载中…</main>;
  if (me.status === "error") {
    return (
      <main className={pageWrap}>
        <p className={alert.error}>{me.message}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-6 sm:py-10">
      <h1 className="text-2xl font-bold">兑换</h1>

      {done ? (
        <section className={cx(card, "flex flex-col gap-4 p-5 sm:p-6")} data-testid="redeem-success" aria-labelledby="done-title">
          <div>
            <p className="text-sm font-medium text-ok">兑换成功</p>
            <h2 id="done-title" className="mt-1 text-xl font-bold">
              {done.entitlement.productName}
            </h2>
            <p className="mt-1 text-sm text-ink-3">
              兑换码 <span className="font-mono">{done.entitlement.code}</span>
            </p>
          </div>
          <IncludesList includes={done.entitlement.includes} titles={titles} />
          <p className="text-[15px]" data-testid="redeem-daily-limit">
            现在每天最多能开 <span className="font-semibold">{done.entitlements.dailySessionLimit}</span> 局。
          </p>
          {done.entitlement.includes.humanReview && (
            <div className="rounded-lg bg-surface-2 p-4" data-testid="human-review">
              <h3 className="font-semibold">真人复盘怎么预约</h3>
              {done.entitlements.humanReviewHowTo ? (
                <Markdown source={done.entitlements.humanReviewHowTo} className="mt-2" />
              ) : (
                <p className="mt-2 text-[15px] text-ink-2">预约方式还没公布,之后在「我的对局」里能看到。</p>
              )}
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link href="/" className={btn.primary}>
              去开一局
            </Link>
            <Link href="/me" className={btn.secondary}>
              我的对局
            </Link>
            <button type="button" className={btn.ghost} onClick={again}>
              再兑换一个
            </button>
          </div>
        </section>
      ) : (
        <form onSubmit={submit} className={cx(card, "flex flex-col gap-4 p-5 sm:p-6")} noValidate>
          <label className={field.label}>
            兑换码
            <input
              className={cx(field.input, "font-mono uppercase tracking-wider")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={64}
            />
          </label>
          <p className={cx(field.hint, "-mt-2")}>不区分大小写,空格和短横线可以不输。每个兑换码只能用一次,兑换后绑定到当前账号。</p>
          {error && (
            <p role="alert" className={alert.error}>
              {error}
            </p>
          )}
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? "正在兑换…" : "兑换"}
          </button>
        </form>
      )}

      <p className="text-[15px] text-ink-2">
        还没有兑换码?
        <Link href="/presale" className="inline-flex min-h-11 items-center px-1 font-medium text-accent hover:underline">
          看看预售
        </Link>
      </p>
    </main>
  );
}
