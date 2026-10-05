"use client";
// 我的对局:列表(接着玩 / 看复盘)、账号信息、退出登录、删除我的全部对局(方案 8.2 第 9 条的删除渠道)。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { SessionSummary } from "@fde/contracts";
import { Modal } from "@/components/Modal";
import { api, failureMessage, loginHref } from "@/lib/client/api";
import { cx, formatDateTime, formatScore, phaseLabel } from "@/lib/client/format";
import { useMe } from "@/lib/client/hooks";
import { alert, btn, card, pageWrap } from "@/lib/client/ui";

export function MeClient() {
  const router = useRouter();
  const [me] = useMe();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);

  useEffect(() => {
    if (me.status === "anon") router.replace(loginHref("/me"));
    if (me.status !== "ok") return;
    let alive = true;
    api
      .sessions()
      .then((r) => alive && setSessions(r.sessions))
      .catch((e: unknown) => alive && setError(failureMessage(e)));
    return () => {
      alive = false;
    };
  }, [me.status, router]);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      const r = await api.deleteMyData();
      setDeleted(r.deletedSessions);
      setSessions([]);
      setConfirmDelete(false);
    } catch (e) {
      setError(failureMessage(e));
    } finally {
      setDeleting(false);
    }
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      /* 已经退出也没关系 */
    }
    // 不把 me 置空:置空会触发上面"未登录去登录页"的跳转,和这里回首页抢路由
    router.push("/");
  }

  if (me.status === "loading" || me.status === "anon") return <main className={cx(pageWrap, "text-ink-3")}>加载中…</main>;
  if (me.status === "error") return <main className={pageWrap}><p className={alert.error}>{me.message}</p></main>;

  return (
    <main className={cx(pageWrap, "flex flex-col gap-8")}>
      <section aria-labelledby="mine-title">
        <div className="flex items-center justify-between gap-3">
          <h1 id="mine-title" className="text-2xl font-bold">
            我的对局
          </h1>
          <Link href="/" className={btn.secondary}>
            开一局
          </Link>
        </div>
        {deleted !== null && <p className={cx(alert.ok, "mt-4")}>已删除 {deleted} 局对局和复盘。</p>}
        {error && <p className={cx(alert.error, "mt-4")}>{error}</p>}
        {!sessions && !error && <p className="mt-4 text-ink-3">加载中…</p>}
        {sessions && sessions.length === 0 && <p className="mt-4 text-ink-2">还没有对局。</p>}
        {sessions && sessions.length > 0 && (
          <ul className="mt-4 flex flex-col gap-3" data-testid="my-sessions">
            {sessions.map((s) => {
              const finished = s.phase === "debrief";
              const href = finished ? `/report/${encodeURIComponent(s.id)}` : `/play/${encodeURIComponent(s.id)}`;
              return (
                <li key={s.id} className={cx(card, "flex flex-wrap items-center justify-between gap-3 p-4")}>
                  <div className="min-w-0">
                    <p className="font-medium leading-6">{s.title}</p>
                    <p className="text-sm text-ink-3">
                      {formatDateTime(s.startedAt)} · {phaseLabel(s.phase)}
                      {s.total !== null && (
                        <>
                          {" · "}
                          <span className="font-semibold text-ink">{formatScore(s.total)} 分</span>
                        </>
                      )}
                    </p>
                  </div>
                  <Link href={href} className={finished ? btn.secondary : btn.primary}>
                    {finished ? "看复盘" : "接着玩"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="account-title" className={cx(card, "p-5")}>
        <h2 id="account-title" className="text-lg font-semibold">
          账号
        </h2>
        <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-2 text-[15px]">
          <dt className="text-ink-3">邮箱</dt>
          <dd className="break-all">{me.user.email}</dd>
          <dt className="text-ink-3">同意协议</dt>
          <dd>{me.user.consentAt ? formatDateTime(me.user.consentAt) : "还没有同意"}</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          {me.user.isAdmin && (
            <Link href="/admin" className={btn.secondary}>
              管理页
            </Link>
          )}
          <button type="button" className={btn.ghost} onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </section>

      <section aria-labelledby="delete-title" className={cx(card, "p-5")}>
        <h2 id="delete-title" className="text-lg font-semibold">
          删除我的对话
        </h2>
        <p className="mt-2 text-[15px] leading-7 text-ink-2">删除你的全部对局、对话记录和复盘。删除后不能恢复。账号本身保留,可以继续登录。</p>
        <button type="button" className={cx(btn.danger, "mt-4")} onClick={() => setConfirmDelete(true)}>
          删除我的全部对局
        </button>
      </section>

      <Modal
        open={confirmDelete}
        title="确定删除全部对局?"
        onClose={() => setConfirmDelete(false)}
        size="sm"
        footer={
          <>
            <button type="button" className={btn.ghost} onClick={() => setConfirmDelete(false)}>
              取消
            </button>
            <button type="button" className={cx(btn.danger, "border-danger")} disabled={deleting} onClick={() => void remove()}>
              {deleting ? "正在删除…" : "确定删除"}
            </button>
          </>
        }
      >
        <p className="text-[15px] leading-7">所有对局、对话记录和复盘都会被删除,不能恢复。</p>
      </Modal>
    </main>
  );
}
