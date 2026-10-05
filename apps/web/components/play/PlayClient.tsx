"use client";
// 对局页(方案 5.3 草图):顶部时间条与[我的判断是…][收工];人物(带迷雾)、对话、资料三栏。
// 手机上底部标签切换 对话/人物/资料,电脑上三栏并排。所有数据只走 HTTP 接口。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { PublicArtifact, PublicView, TurnResponse, UserAction } from "@fde/contracts";
import { Brand } from "@/components/SiteHeader";
import { AiBadge } from "@/components/Markdown";
import { api, failureMessage, isFailure, loginHref } from "@/lib/client/api";
import { cx, formatMinutes, phaseLabel } from "@/lib/client/format";
import { local } from "@/lib/client/hooks";
import { alert, btn } from "@/lib/client/ui";
import { ArtifactViewer } from "./ArtifactViewer";
import { ActionsDialog, EndDialog, ExperimentsDialog, FinishingOverlay, JudgmentDialog, actionBlockedReason, clearJudgmentDraft } from "./Dialogs";
import { Avatar, Transcript } from "./Transcript";

type Tab = "chat" | "people" | "artifacts";
type Busy = { kind: "turn"; text: string; speaker: string } | { kind: "action"; label: string };
type Notice = { tone: "info" | "ok" | "warn" | "error"; text: string };
type Dialog = null | "actions" | "experiments" | "judgment" | "end";
type ViewerState = null | { loading: string } | { artifact: PublicArtifact };

const ASK_FOR_MATERIALS = "能给我看看相关的资料吗?";
const MAX_TEXT = 500;
const DISCOVERING: PublicView["phase"][] = ["kickoff", "discovery"];

export function PlayClient({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [view, setView] = useState<PublicView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const busyRef = useRef(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [tab, setTab] = useState<Tab>("chat");
  const [unseenArtifacts, setUnseenArtifacts] = useState(0);
  const [draft, setDraft] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [viewer, setViewer] = useState<ViewerState>(null);
  const [finishing, setFinishing] = useState<null | { error: string | null }>(null);
  const finishStarted = useRef(false);
  const [mobileHint, setMobileHint] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  /** 每次打开资料加一;关掉时也加一,让还在路上的加载结果作废。 */
  const viewerToken = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const toLogin = useCallback(() => router.push(loginHref(`/play/${encodeURIComponent(sessionId)}`)), [router, sessionId]);

  const load = useCallback(async () => {
    try {
      const r = await api.session(sessionId);
      setView(r.view);
      setLoadError(null);
    } catch (e) {
      if (isFailure(e, "unauthorized")) toLogin();
      else if (isFailure(e, "forbidden", "not_found")) setLoadError("这一局不存在,或者不是你的。");
      else setLoadError(failureMessage(e));
    }
  }, [sessionId, toLogin]);

  useEffect(() => {
    void load();
  }, [load]);

  // 手机首次进入:提示换电脑(只提示一次)
  useEffect(() => {
    try {
      if (window.matchMedia("(max-width: 1023px)").matches && !local.get("fde:hint:desktop")) {
        setMobileHint(true);
        local.set("fde:hint:desktop", "1");
      }
    } catch {
      /* matchMedia 不可用就不提示 */
    }
  }, []);

  // 收工后先 POST finish(幂等),出了复盘再跳 /report/[id]
  const startFinish = useCallback(async () => {
    if (finishStarted.current) return;
    finishStarted.current = true;
    setFinishing({ error: null });
    try {
      await api.finish(sessionId);
      router.push(`/report/${encodeURIComponent(sessionId)}`);
    } catch (e) {
      finishStarted.current = false;
      if (isFailure(e, "unauthorized")) toLogin();
      else setFinishing({ error: failureMessage(e) });
    }
  }, [sessionId, router, toLogin]);

  const ended = view?.ended ?? false;
  useEffect(() => {
    if (ended) void startFinish();
  }, [ended, startFinish]);

  // 新消息、正在说话时滚到底;刚进来时直接跳到底,之后平滑滚动
  const lineCount = view?.transcript.length ?? 0;
  const scrolledOnce = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el || lineCount === 0) return;
    el.scrollTo({ top: el.scrollHeight, behavior: scrolledOnce.current ? "smooth" : "auto" });
    scrolledOnce.current = true;
  }, [lineCount, busy]);

  // 对话区高度变了(输入框长高、提示条收起)时,原来在底部就继续贴着底部
  const atBottom = useRef(true);
  const hasView = view !== null;
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasView]);

  // 输入框随内容长高(最多约 5 行)
  useEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [draft]);

  function begin(b: Busy): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(b);
    setNotices([]);
    return true;
  }
  function done() {
    busyRef.current = false;
    setBusy(null);
  }

  function handleFailure(e: unknown) {
    if (isFailure(e, "unauthorized")) return toLogin();
    if (isFailure(e, "session_busy")) return setNotices([{ tone: "warn", text: "上一句还在处理,稍等一下再发。" }]);
    if (isFailure(e, "session_ended")) {
      setNotices([{ tone: "info", text: "这一局已经结束了。" }]);
      void load();
      return;
    }
    setNotices([{ tone: "error", text: failureMessage(e) }]);
  }

  /**
   * 请求没拿到响应(网络断了、服务器出错)时,服务端可能已经处理完了,只是响应没回来。
   * 稍等一下重新拉一次视图:对话记录变长了说明已经生效,返回 true(调用方不要再把草稿放回去,免得重复发)。
   */
  async function resync(prevLen: number): Promise<boolean> {
    // 服务端可能还在处理(模型一轮要几秒到十几秒):隔一会儿看一次,最多等约 20 秒
    setNotices([{ tone: "info", text: "网络不太稳,正在确认刚才那句有没有发出去…" }]);
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = await api.session(sessionId).catch(() => null);
      if (!fresh) continue;
      setView(fresh.view);
      if (fresh.view.transcript.length > prevLen) return true;
    }
    return false;
  }

  /** 用响应更新视图;没写进对话记录的系统消息(比如动作失败的原因)放到提示条里。 */
  function apply(resp: TurnResponse, prevLen: number) {
    const added = new Set(resp.view.transcript.slice(prevLen).map((l) => l.text));
    const out: Notice[] = [];
    const extra = resp.result.system.filter((s) => !added.has(s));
    // 动作失败、或者这句话没被接收(比如太长、阶段不对)时,原因只在 result.system 里
    const rejected = resp.result.ok === false || (added.size === 0 && !resp.result.reply);
    if (extra.length) out.push({ tone: rejected ? "warn" : "info", text: extra.join("\n") });
    if (resp.result.unlockedArtifacts.length) {
      out.push({ tone: "ok", text: `拿到资料:${resp.result.unlockedArtifacts.map((a) => `「${a.title}」`).join("、")}。在「资料」里点开查看。` });
      setUnseenArtifacts((n) => n + resp.result.unlockedArtifacts.length);
    }
    if (resp.result.discovered.length) {
      out.push({ tone: "ok", text: `新认识:${resp.result.discovered.map((p) => `${p.name}(${p.title})`).join("、")}。在「人物」里可以去找。` });
    }
    setView(resp.view);
    setNotices(out);
  }

  async function sendTurn(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!view || !text || view.ended || view.phase === "judgment" || finishing !== null) return;
    if (text.length > MAX_TEXT) {
      setNotices([{ tone: "warn", text: `一次说太多了,控制在 ${MAX_TEXT} 字以内,一次说一件事。` }]);
      return;
    }
    const speaker = view.people.find((p) => p.current)?.name ?? "对方";
    if (!begin({ kind: "turn", text, speaker })) {
      setNotices([{ tone: "warn", text: "上一句还在处理,稍等一下再发。" }]);
      return;
    }
    setDraft("");
    const prevLen = view.transcript.length;
    try {
      const r = await api.turn(sessionId, { text });
      apply(r, prevLen);
      // 没被接收的话(对话记录没变长)放回输入框,不让用户白打
      if (r.view.transcript.length === prevLen) setDraft(text);
    } catch (err) {
      if (isFailure(err, "network", "internal", "unknown") && (await resync(prevLen))) {
        setNotices([{ tone: "info", text: "网络不太稳,刚才那句已经发出去了。" }]);
        return;
      }
      setDraft(text);
      handleFailure(err);
    } finally {
      done();
      // 发送期间输入框只读(不禁用),焦点和手机键盘都还在;这里只在焦点丢了时补回来
      if (document.activeElement === document.body) composer.current?.focus();
    }
  }

  /** 发一个按钮动作;返回动作是否成功。 */
  async function act(action: UserAction, label: string): Promise<boolean> {
    if (!view) return false;
    if (!begin({ kind: "action", label })) {
      setNotices([{ tone: "warn", text: "上一句还在处理,稍等一下。" }]);
      return false;
    }
    const prevLen = view.transcript.length;
    try {
      const r = await api.act(sessionId, action);
      apply(r, prevLen);
      return r.result.ok !== false;
    } catch (err) {
      // 动作可能已经生效(只是响应丢了):重新拉一次视图,让界面和服务端一致
      if (isFailure(err, "network", "internal", "unknown")) await resync(prevLen);
      handleFailure(err);
      return false;
    } finally {
      done();
    }
  }

  async function switchTo(p: PublicView["people"][number]) {
    if (p.current) {
      setTab("chat");
      return;
    }
    const ok = await act({ type: "switch_role", role: p.id }, `正在去找${p.name}…`);
    if (ok) setTab("chat");
  }

  async function openArtifact(a: PublicView["artifacts"][number]) {
    // 没看过的先发 open_artifact(会花时间);看过的直接列文件,不重复记时间
    if (!a.opened) {
      const ok = await act({ type: "open_artifact", artifact: a.id }, `正在看「${a.title}」…`);
      if (!ok) return;
    }
    const token = ++viewerToken.current;
    setViewer({ loading: a.title });
    try {
      const r = await api.artifact(sessionId, a.id);
      // 加载期间用户已经关掉(或打开了别的资料)就不要再弹出来
      if (viewerToken.current === token) setViewer({ artifact: r.artifact });
    } catch (err) {
      if (viewerToken.current === token) setViewer(null);
      handleFailure(err);
    }
  }

  function closeViewer() {
    viewerToken.current += 1;
    setViewer(null);
  }

  function askForMaterials() {
    setDraft((d) => (d.trim() ? `${d.trimEnd()} ${ASK_FOR_MATERIALS}` : ASK_FOR_MATERIALS));
    setTab("chat");
    requestAnimationFrame(() => composer.current?.focus());
  }

  // ---------------------------------------------------------------- 渲染

  if (loadError) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <p className="text-lg font-semibold">打不开这一局</p>
        <p className="text-ink-2">{loadError}</p>
        <div className="flex gap-2">
          <Link href="/me" className={btn.secondary}>
            我的对局
          </Link>
          <button type="button" className={btn.primary} onClick={() => void load()}>
            重试
          </button>
        </div>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="flex flex-1 items-center justify-center px-4 py-24 text-ink-3" aria-busy="true">
        正在进入现场…
      </main>
    );
  }

  const current = view.people.find((p) => p.current);
  const discovering = DISCOVERING.includes(view.phase);
  const inputLocked = busy !== null || view.ended || view.phase === "judgment" || finishing !== null;
  const siteBlocked = view.actions.length > 0 && view.actions.every((a) => !a.available);
  const siteNote = siteBlocked && view.actions[0] ? actionBlockedReason(view.actions[0], view.phase) : null;
  const userTurns = view.transcript.filter((l) => l.speaker === "user").length;
  const canJudge = !view.judgmentSubmitted && !view.ended && (discovering || view.phase === "judgment");

  const header = (
    <header className="z-10 border-b border-line bg-surface">
      <div className="flex items-center gap-2 px-3 py-2 lg:gap-4 lg:px-4">
        <div className="hidden shrink-0 items-center gap-3 lg:flex">
          <Brand />
          <span className="max-w-64 truncate text-sm text-ink-2" title={view.scenario.title}>
            {view.scenario.title}
          </span>
        </div>
        <div className="min-w-0 flex-1 lg:max-w-md">
          <div className="flex items-baseline gap-2">
            <span className="whitespace-nowrap text-[15px] font-semibold" data-testid="time-left">
              {view.minutesLeft > 0 ? (
                <>
                  <span className="max-[359px]:hidden">今天</span>还剩 {formatMinutes(view.minutesLeft)}
                </>
              ) : (
                "时间用完了"
              )}
            </span>
            <span className="hidden truncate text-sm text-ink-3 sm:inline">{phaseLabel(view.phase)}</span>
          </div>
          <div
            role="progressbar"
            aria-label="今天剩余时间"
            aria-valuemin={0}
            aria-valuemax={view.minutesTotal}
            aria-valuenow={view.minutesLeft}
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className={cx("h-full rounded-full transition-[width] duration-500", view.minutesLeft <= 60 ? "bg-warn" : "bg-accent")}
              style={{ width: `${view.minutesTotal > 0 ? Math.max(0, Math.min(100, (view.minutesLeft / view.minutesTotal) * 100)) : 0}%` }}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 lg:ml-auto">
          <button
            type="button"
            className={cx(btn.secondary, "px-3")}
            onClick={() => setDialog("judgment")}
            disabled={!canJudge || busy !== null}
            title={view.judgmentSubmitted ? "已经提交过判断" : undefined}
          >
            {view.judgmentSubmitted ? "已提交判断" : "我的判断是…"}
          </button>
          <button type="button" className={cx(btn.primary, "px-3")} onClick={() => setDialog("end")} disabled={view.ended || busy !== null}>
            收工
          </button>
        </div>
      </div>
    </header>
  );

  const peoplePanel = (
    <aside
      data-testid="people-panel"
      aria-label="人物"
      className={cx(
        "min-h-0 w-full flex-col overflow-y-auto overscroll-contain bg-surface lg:flex lg:w-64 lg:shrink-0 lg:border-r lg:border-line",
        tab === "people" ? "flex" : "hidden",
      )}
    >
      <h2 className="px-4 pt-4 pb-1 text-sm font-semibold text-ink-2">人物</h2>
      <ul className="flex flex-col gap-1 px-2">
        {view.people.map((p) => {
          const locked = !p.current && (!discovering || view.ended);
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => !locked && void switchTo(p)}
                aria-current={p.current ? "true" : undefined}
                aria-disabled={locked || busy !== null || undefined}
                data-testid={`person-${p.id}`}
                className={cx(
                  "flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                  p.current ? "bg-accent-soft ring-1 ring-accent/40" : "hover:bg-surface-2",
                  locked && "cursor-not-allowed opacity-60",
                )}
              >
                <Avatar name={p.name} active={p.current} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-medium leading-6">
                    {p.name}
                    {p.current && <span className="rounded bg-accent px-1.5 text-[11px] leading-5 text-accent-ink">正在谈</span>}
                  </span>
                  <span className="block truncate text-[13px] leading-5 text-ink-3">{p.title}</span>
                </span>
                <span className="shrink-0 text-xs text-ink-3">{p.exchanges > 0 ? `聊过 ${p.exchanges} 句` : "还没聊"}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="px-4 pt-3 text-[13px] leading-6 text-ink-3">
        {view.phase === "report"
          ? "汇报阶段只和老板谈。"
          : "还有谁、管什么,要在聊天里问出来;没见过的人不会出现在这里。换人要走过去,也花时间。"}
      </p>
      <div className="mt-auto px-4 pt-6 pb-4">
        <Link href="/me" className="inline-flex min-h-11 items-center text-sm text-ink-2 underline-offset-4 hover:text-ink hover:underline">
          离开这一局(进度已自动保存)
        </Link>
      </div>
    </aside>
  );

  const artifactsPanel = (
    <aside
      data-testid="artifacts-panel"
      aria-label="资料"
      className={cx(
        "min-h-0 w-full flex-col overflow-y-auto overscroll-contain bg-surface lg:flex lg:w-72 lg:shrink-0 lg:border-l lg:border-line",
        tab === "artifacts" ? "flex" : "hidden",
      )}
    >
      <h2 className="px-4 pt-4 pb-1 text-sm font-semibold text-ink-2">我拿到的资料</h2>
      {view.artifacts.length === 0 ? (
        <p className="px-4 py-2 text-[14px] leading-6 text-ink-3">还没有资料。想看什么,直接开口要,或者点「要资料」。</p>
      ) : (
        <ul className="flex flex-col gap-1 px-2">
          {view.artifacts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => void openArtifact(a)}
                disabled={busy !== null}
                data-testid={`artifact-${a.id}`}
                className="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-60"
              >
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-ink-2 ring-1 ring-line">
                  <svg viewBox="0 0 20 20" className="size-5">
                    <path d="M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium leading-6">{a.title}</span>
                  <span className="block text-[13px] leading-5 text-ink-3">{a.opened ? "看过了,点开再翻" : `还没看 · 细看要 ${a.reviewCostMin} 分钟`}</span>
                </span>
                {!a.opened && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="还没看" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Notes sessionId={sessionId} />
    </aside>
  );

  const chatPanel = (
    <section data-testid="chat-panel" aria-label="对话" className={cx("min-h-0 min-w-0 flex-1 flex-col", tab === "chat" ? "flex" : "hidden lg:flex")}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line bg-canvas px-4 py-2">
        <p className="min-w-0 text-sm" data-testid="current-role">
          <span className="text-ink-3">当前:</span>
          <span className="font-semibold">{current?.name ?? "—"}</span>
          {current && <span className="text-ink-3"> · {current.title}</span>}
        </p>
        <AiBadge text={view.aiNotice} />
      </div>
      {mobileHint && (
        <div className={cx(alert.info, "mx-3 mt-2 flex items-center justify-between gap-2 lg:hidden")} data-testid="mobile-hint">
          <span>在电脑上玩更顺手,进度会自动保存。</span>
          <button type="button" className={cx(btn.small, "shrink-0")} onClick={() => setMobileHint(false)}>
            知道了
          </button>
        </div>
      )}

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5"
      >
        <details open={userTurns === 0} className="mb-5 rounded-xl border border-line bg-surface px-4 py-3 text-[15px] leading-7">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">今天的任务</summary>
          <div className="mt-2 flex flex-col gap-2 text-ink-2">
            <p>{view.briefing.youAre}</p>
            <p>
              <span className="font-medium text-ink">客户:</span>
              {view.briefing.company}
            </p>
            <p>
              <span className="font-medium text-ink">目标:</span>
              {view.briefing.goal}
            </p>
            <ul className="list-disc pl-5">
              {view.briefing.rulesShown.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="text-[13px] text-ink-3">{view.scenario.disclaimer}</p>
          </div>
        </details>
        <Transcript lines={view.transcript}>
          {busy?.kind === "turn" && (
            <li className="flex justify-end" data-testid="pending-line">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-accent/70 px-3.5 py-2 text-[15px] leading-7 text-accent-ink">{busy.text}</div>
            </li>
          )}
          {busy && (
            <li className="flex items-center gap-2 text-sm text-ink-2" data-testid="typing" role="status">
              {busy.kind === "turn" ? (
                <>
                  <Avatar name={busy.speaker} size="sm" />
                  <span>{busy.speaker}正在说话…</span>
                </>
              ) : (
                <span>{busy.label}</span>
              )}
              <span aria-hidden className="inline-flex gap-1">
                <span className="typing-dot size-1.5 rounded-full bg-ink-3" />
                <span className="typing-dot size-1.5 rounded-full bg-ink-3" />
                <span className="typing-dot size-1.5 rounded-full bg-ink-3" />
              </span>
            </li>
          )}
        </Transcript>
      </div>

      <div className="border-t border-line bg-surface px-3 pt-2 pb-3 sm:px-4">
        {notices.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5" data-testid="notices" role="status">
            {notices.map((n, i) => (
              <p key={i} className={cx(alert[n.tone], "whitespace-pre-line")}>
                {n.text}
              </p>
            ))}
          </div>
        )}
        {view.phase === "judgment" && !view.judgmentSubmitted && (
          <div className={cx(alert.warn, "mb-2 flex flex-wrap items-center justify-between gap-2")}>
            <span>时间用完了。先提交你的判断,再去会议室向老板汇报。</span>
            <button type="button" className={btn.secondary} onClick={() => setDialog("judgment")}>
              填写判断
            </button>
          </div>
        )}
        {discovering ? (
          <div className="mb-2">
            <div className="flex flex-wrap gap-2" aria-label="快捷动作">
              <button
                type="button"
                onClick={() => setDialog("actions")}
                disabled={busy !== null}
                aria-describedby={siteNote ? "site-note" : undefined}
                className={cx(
                  "min-h-11 rounded-full border px-4 text-sm font-medium transition-colors disabled:opacity-60",
                  siteBlocked ? "border-line bg-surface-2 text-ink-3" : "border-accent/40 bg-accent-soft text-ink hover:border-accent",
                )}
              >
                去现场看看
              </button>
              <button
                type="button"
                onClick={askForMaterials}
                disabled={busy !== null}
                className="min-h-11 rounded-full border border-accent/40 bg-accent-soft px-4 text-sm font-medium text-ink hover:border-accent disabled:opacity-60"
              >
                要资料
              </button>
              <button
                type="button"
                onClick={() => setDialog("experiments")}
                disabled={busy !== null}
                className={cx(
                  "min-h-11 rounded-full border px-4 text-sm font-medium transition-colors disabled:opacity-60",
                  view.experiments.length === 0 ? "border-line bg-surface-2 text-ink-3" : "border-accent/40 bg-accent-soft text-ink hover:border-accent",
                )}
              >
                做个验证
              </button>
            </div>
            {siteNote && (
              <p id="site-note" className="mt-1 text-xs leading-5 text-ink-3">
                去现场:{siteNote}
              </p>
            )}
          </div>
        ) : view.phase === "report" ? (
          <p className="mb-2 text-xs leading-5 text-ink-3">汇报阶段只和老板谈。说完了点「收工」看复盘。</p>
        ) : null}
        <form onSubmit={sendTurn} className="flex items-end gap-2">
          <label htmlFor="composer" className="sr-only">
            对{current?.name ?? "对方"}说
          </label>
          <textarea
            id="composer"
            ref={composer}
            rows={1}
            maxLength={MAX_TEXT}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // 输入法候选中按回车是上屏,不是发送
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void sendTurn();
              }
            }}
            // 发送中只读而不是禁用:禁用会让输入框失去焦点,手机键盘每发一句就收起来
            readOnly={busy !== null}
            aria-busy={busy !== null || undefined}
            disabled={view.ended || view.phase === "judgment" || finishing !== null}
            placeholder={view.phase === "judgment" ? "先提交判断" : `对${current?.name ?? "对方"}说…`}
            className="min-h-11 flex-1 resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-base leading-6 text-ink placeholder:text-ink-3 focus:border-accent focus:outline-2 focus:outline-accent/30 read-only:opacity-60 disabled:opacity-60"
          />
          <button type="submit" className={cx(btn.primary, "shrink-0 px-5")} disabled={inputLocked || !draft.trim()}>
            发送
          </button>
        </form>
      </div>
    </section>
  );

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "chat", label: "对话" },
    { id: "people", label: "人物", badge: view.people.length },
    { id: "artifacts", label: "资料", badge: unseenArtifacts || undefined },
  ];

  return (
    <div className="flex h-dvh flex-col bg-canvas" data-testid="play">
      {header}
      <div className="flex min-h-0 flex-1">
        {peoplePanel}
        {chatPanel}
        {artifactsPanel}
      </div>
      <nav role="tablist" aria-label="切换面板" className="grid grid-cols-3 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              if (t.id === "artifacts") setUnseenArtifacts(0);
            }}
            className={cx("relative flex min-h-12 items-center justify-center gap-1.5 text-[15px] font-medium", tab === t.id ? "text-accent" : "text-ink-2")}
          >
            {t.label}
            {t.badge !== undefined && (
              <span className={cx("min-w-5 rounded-full px-1.5 text-xs leading-5", t.id === "artifacts" ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2")}>{t.badge}</span>
            )}
            {tab === t.id && <span aria-hidden className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </nav>

      <ActionsDialog
        open={dialog === "actions"}
        actions={view.actions}
        phase={view.phase}
        disabled={busy !== null}
        onClose={() => setDialog(null)}
        onRun={(a) => {
          setDialog(null);
          setTab("chat");
          void act({ type: "action", action: a.id }, `${a.title}…`);
        }}
      />
      <ExperimentsDialog
        open={dialog === "experiments"}
        experiments={view.experiments}
        locked={view.lockedExperiments}
        phase={view.phase}
        disabled={busy !== null}
        onClose={() => setDialog(null)}
        onRun={(x) => {
          setDialog(null);
          setTab("chat");
          void act({ type: "experiment", experiment: x.id }, `正在做「${x.title}」…`);
        }}
      />
      <JudgmentDialog
        open={dialog === "judgment"}
        sessionId={sessionId}
        form={view.judgmentForm}
        disabled={busy !== null}
        onClose={() => setDialog(null)}
        onSubmit={async (form) => {
          setDialog(null);
          setTab("chat");
          const ok = await act({ type: "submit_judgment", form }, "正在去会议室…");
          if (ok) clearJudgmentDraft(sessionId);
        }}
      />
      <EndDialog
        open={dialog === "end"}
        judgmentSubmitted={view.judgmentSubmitted}
        disabled={busy !== null}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          setDialog(null);
          await act({ type: "end" }, "正在收工…");
        }}
      />
      {viewer && <ArtifactViewer sessionId={sessionId} state={viewer} onClose={closeViewer} />}
      {finishing && <FinishingOverlay error={finishing.error} onRetry={() => void startFinish()} />}
    </div>
  );
}

/** 我的笔记:只存在这台设备上(localStorage),不发给服务器。 */
function Notes({ sessionId }: { sessionId: string }) {
  const key = `fde:notes:${sessionId}`;
  const [text, setText] = useState("");
  useEffect(() => {
    setText(local.get(key) ?? "");
  }, [key]);
  return (
    <div className="mt-auto border-t border-line px-4 pt-4 pb-4">
      <label htmlFor="notes" className="text-sm font-semibold text-ink-2">
        我的笔记
      </label>
      <textarea
        id="notes"
        rows={5}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          local.set(key, e.target.value);
        }}
        placeholder="随手记:谁说了什么、哪两份单子对不上……"
        className="mt-1.5 block w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-base leading-6 placeholder:text-ink-3 focus:border-accent focus:outline-2 focus:outline-accent/30"
      />
      <p className="mt-1 text-xs text-ink-3">只存在这台设备上,不会发给服务器。</p>
    </div>
  );
}
