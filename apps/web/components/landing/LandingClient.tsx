"use client";
// 落地页的动态部分:场景卡片、开始按钮、没打完的对局。
// 第三轮:付费场景的卡片标"需要兑换码";开局遇到 entitlement_required 时给出去预售页、去兑换的链接。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ScenarioSummary, SessionSummary } from "@fde/contracts";
import { api, failureMessage, isFailure, loginHref, track } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { useSite } from "@/lib/client/hooks";
import { alert, btn, card } from "@/lib/client/ui";
import { WaitlistForm } from "./WaitlistForm";

function Difficulty({ level }: { level: number }) {
  return (
    <span aria-label={`难度 ${level} / 5`} className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden className={i <= level ? "size-2 rounded-full bg-accent" : "size-2 rounded-full bg-line"} />
      ))}
    </span>
  );
}

export function LandingClient() {
  const router = useRouter();
  const { site } = useSite();
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resume, setResume] = useState<SessionSummary | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  /** 开局失败的提示,只显示在那个场景的卡片上;needsCode:付费场景还没兑换。 */
  const [error, setError] = useState<{ scenarioId: string; message: string; needsCode: boolean } | null>(null);

  useEffect(() => {
    // 第三轮埋点:落地页打开(带上链接里的 ?from= 来源)
    const from = new URLSearchParams(window.location.search).get("from");
    track("landing_viewed", from && /^[A-Za-z0-9_-]{1,32}$/.test(from) ? { props: { from } } : {});
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .scenarios()
      .then((r) => alive && setScenarios(r.scenarios))
      .catch((e: unknown) => alive && setLoadError(failureMessage(e)));
    // 登录了才有;没登录(401)就不显示"接着玩"
    api
      .sessions()
      .then((r) => alive && setResume(r.sessions.find((s) => s.phase !== "debrief") ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 没登录时点了"开始这一局":登录(和同意协议)之后带着 ?start=<场景> 回来,直接开局,不用再点一次
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!scenarios || autoStarted.current) return;
    const id = new URLSearchParams(window.location.search).get("start");
    if (!id) return;
    autoStarted.current = true;
    // 先把 start 从地址里去掉,刷新页面不会再开一局
    window.history.replaceState(null, "", window.location.pathname);
    if (scenarios.some((s) => s.id === id)) void start(id);
    // start 每次渲染都是新函数,这里只在场景列表加载好时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios]);

  async function start(scenarioId: string) {
    if (starting) return;
    setStarting(scenarioId);
    setError(null);
    try {
      const r = await api.createSession({ scenarioId });
      router.push(`/play/${encodeURIComponent(r.sessionId)}`);
    } catch (e) {
      // 没登录、没同意协议:都去登录页,登录页会接着把没做完的步骤做完
      if (isFailure(e, "unauthorized", "consent_required")) {
        router.push(loginHref(`/?start=${encodeURIComponent(scenarioId)}`));
        return;
      }
      setError({ scenarioId, message: failureMessage(e), needsCode: isFailure(e, "entitlement_required") });
      setStarting(null);
    }
  }

  return (
    <section aria-label="场景" className="flex flex-col gap-4">
      {resume && (
        <div className={`${alert.info} flex flex-wrap items-center justify-between gap-2`}>
          <span>
            你有一局还没打完:{resume.title}(开始于 {formatDateTime(resume.startedAt)})
          </span>
          <Link href={`/play/${encodeURIComponent(resume.id)}`} className={btn.secondary}>
            接着玩
          </Link>
        </div>
      )}
      {loadError && <p className={alert.error}>场景加载失败:{loadError}</p>}
      {!scenarios && !loadError && <div className={`${card} h-64 animate-pulse`} aria-label="加载中" />}
      {scenarios?.map((s) => (
        <article key={s.id} className={`${card} p-5 sm:p-7`} data-testid="scenario-card">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
            <span className="inline-flex items-center gap-2">
              难度 <Difficulty level={s.difficulty} />
            </span>
            <span>约 {s.estMinutes} 分钟</span>
            {s.access === "paid" && (
              <span className="rounded-full border border-warn/40 bg-warn-soft px-2.5 py-0.5 text-[13px] font-medium leading-5 text-warn" data-testid="needs-code">
                需要兑换码
              </span>
            )}
          </div>
          <h2 className="mt-2 text-xl font-bold leading-snug sm:text-2xl">{s.title}</h2>
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="练什么">
            {s.skillFocus.map((k) => (
              <li key={k} className="rounded-full bg-accent-soft px-3 py-0.5 text-sm text-ink">
                {k}
              </li>
            ))}
          </ul>
          <figure className="mt-5 rounded-lg border-l-4 border-accent bg-surface-2 px-4 py-3">
            <figcaption className="text-sm text-ink-2">
              {s.opening.speakerName} · {s.opening.speakerTitle}
            </figcaption>
            <blockquote className="mt-1 text-[16px] leading-8">“{s.opening.text}”</blockquote>
          </figure>
          <p className="mt-3 text-[13px] text-ink-3">{s.disclaimer}</p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button type="button" className={`${btn.primary} w-full sm:w-auto sm:px-8`} onClick={() => start(s.id)} disabled={starting !== null}>
              {starting === s.id ? "正在开局…" : "开始这一局"}
            </button>
            {site.inviteOnly && <span className="text-sm text-ink-3">目前内测,第一次登录需要邀请码。</span>}
          </div>
          {error?.scenarioId === s.id && starting === null && (
            <div role="alert" className={`${alert.error} mt-3`}>
              <p>{error.message}</p>
              {error.needsCode && (
                <p className="mt-1 flex flex-wrap items-center gap-x-3">
                  <Link href="/presale" className="inline-flex min-h-11 items-center font-medium text-accent hover:underline">
                    去预售页看看
                  </Link>
                  <Link href="/redeem" className="inline-flex min-h-11 items-center font-medium text-accent hover:underline">
                    已经有兑换码?去兑换
                  </Link>
                </p>
              )}
            </div>
          )}
        </article>
      ))}
      <WaitlistForm />
    </section>
  );
}
