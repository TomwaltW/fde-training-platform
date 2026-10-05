"use client";
// 管理页:兑换码(第三轮 F3)。管理页底部的一个可折叠区块,展开后才请求数据(不展开不发任何请求)。
// 生成:选商品(未上架的也能选,比如先发给企业试点)、数量、备注 → 一批兑换码,可以复制码或复制兑换链接;
// 下面是按商品的汇总和全部兑换码的状态。
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AdminRedeemCodesResponse } from "@fde/contracts";
import { api, failureMessage } from "@/lib/client/api";
import { cx, formatDateTime } from "@/lib/client/format";
import { alert, btn, card, field } from "@/lib/client/ui";

export function RedeemPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section className={cx(card, "p-5")} aria-labelledby="redeem-title" data-testid="redeem-panel">
      <h2 id="redeem-title" className="font-semibold">
        <button
          type="button"
          className="-my-2 flex min-h-11 w-full items-center justify-between gap-3 text-left"
          aria-expanded={open}
          aria-controls="redeem-panel-body"
          onClick={() => setOpen((o) => !o)}
        >
          <span>兑换码</span>
          <span className="text-sm font-normal text-ink-3">{open ? "收起" : "展开"}</span>
        </button>
      </h2>
      {open && (
        <div id="redeem-panel-body">
          <RedeemBody />
        </div>
      )}
    </section>
  );
}

function RedeemBody() {
  const [data, setData] = useState<AdminRedeemCodesResponse | null>(null);
  /** 上架的商品 id(只用来在下拉框里标"未上架";取不到就不标)。 */
  const [onSale, setOnSale] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [productId, setProductId] = useState("");
  const [count, setCount] = useState("10");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** 刚生成的一批(记下是哪个商品的,之后换了下拉框也不影响这里的说明)。 */
  const [batch, setBatch] = useState<{ productId: string; codes: string[] } | null>(null);
  const codes = batch?.codes ?? null;
  const [copied, setCopied] = useState<"codes" | "links" | null>(null);

  /** 生成之后刷新列表;刷新失败只在表单下面提示,不把刚生成的那批码盖掉。 */
  async function reload() {
    try {
      setData(await api.adminRedeemCodes());
    } catch (e) {
      setFormError(`兑换码已经生成,但刷新列表失败:${failureMessage(e)}`);
    }
  }

  useEffect(() => {
    let alive = true;
    api.adminRedeemCodes().then(
      (r) => alive && setData(r),
      (e: unknown) => alive && setError(failureMessage(e)),
    );
    api.products().then(
      (r) => alive && setOnSale(new Set(r.products.map((p) => p.id))),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  // 默认选第一个上架的商品,没有就选配置里的第一个;上架信息晚到时再选一次(管理员自己选过就不动)
  const touched = useRef(false);
  const choices = data?.byProduct.filter((p) => p.configured) ?? [];
  useEffect(() => {
    if (!data || touched.current) return;
    const configured = data.byProduct.filter((p) => p.configured);
    const first = configured.find((p) => onSale?.has(p.productId)) ?? configured[0];
    if (first) setProductId(first.productId);
  }, [data, onSale]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(count);
    if (!productId) {
      setFormError("先选一个商品");
      return;
    }
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      setFormError("数量 1–500");
      return;
    }
    setBusy(true);
    setFormError(null);
    setCopied(null);
    try {
      const r = await api.createRedeemCodes(note.trim() ? { productId, count: n, note: note.trim() } : { productId, count: n });
      setBatch({ productId, codes: r.codes });
      await reload();
    } catch (err) {
      setFormError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(kind: "codes" | "links") {
    if (!codes) return;
    const text = kind === "codes" ? codes.join("\n") : codes.map((c) => `${window.location.origin}/redeem?code=${encodeURIComponent(c)}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setFormError("复制失败,请手动选择复制");
    }
  }

  const label = (id: string, name: string) => {
    const base = name === id ? id : `${name}(${id})`;
    return onSale && !onSale.has(id) ? `${base} · 未上架` : base;
  };
  const nameOf = (id: string) => data?.byProduct.find((p) => p.productId === id)?.productName ?? id;

  if (error) return <p className={cx(alert.error, "mt-3")}>{error}</p>;
  if (!data) return <p className="mt-3 text-ink-3">加载中…</p>;

  return (
    <div className="mt-3 flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label="生成兑换码">
          <h3 className="text-[15px] font-semibold">生成兑换码</h3>
          {data.byProduct.length === 0 ? (
            <p className={alert.warn}>config/products.yaml 里还没有商品。先在配置里加上商品,再来生成兑换码。</p>
          ) : (
            <>
              <label className={field.label}>
                商品
                <select
                  className={field.input}
                  value={productId}
                  onChange={(e) => {
                    touched.current = true;
                    setProductId(e.target.value);
                  }}
                >
                  {/* 配置里已经删掉的商品不能再生成,只在下面的汇总里出现 */}
                  {choices.map((p) => (
                    <option key={p.productId} value={p.productId}>
                      {label(p.productId, p.productName)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3">
                <label className={field.label}>
                  数量
                  <input className={field.input} type="number" inputMode="numeric" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} />
                </label>
                <label className={field.label}>
                  备注(选填)
                  <input className={field.input} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="比如:早鸟第一批" />
                </label>
              </div>
              <p className={field.hint}>每个兑换码只能用一次。站内不收款:把兑换码交给在第三方平台付了款的人,或者直接发给试点的企业。</p>
              <button type="submit" className={btn.primary} disabled={busy}>
                {busy ? "正在生成…" : "生成兑换码"}
              </button>
            </>
          )}
          {formError && <p className={alert.error}>{formError}</p>}
          {batch && codes && (
            <div data-testid="redeem-new-codes">
              <p className="text-sm text-ink-2">
                新生成 {codes.length} 个「{nameOf(batch.productId)}」的兑换码:
              </p>
              <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg bg-surface-2 p-3 font-mono text-[15px]">
                {codes.map((c) => (
                  <li key={c} className="select-all">
                    {c}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-1">
                <button type="button" className={btn.small} onClick={() => void copy("codes")}>
                  {copied === "codes" ? "已复制" : "复制全部"}
                </button>
                <button type="button" className={btn.small} onClick={() => void copy("links")}>
                  {copied === "links" ? "已复制" : "复制兑换链接"}
                </button>
              </div>
            </div>
          )}
        </form>

        <div>
          <h3 className="text-[15px] font-semibold">按商品</h3>
          {data.byProduct.length === 0 ? (
            <p className="mt-2 text-ink-3">还没有商品。</p>
          ) : (
            <table className="mt-2 w-full text-left text-sm" data-testid="redeem-by-product">
              <thead className="border-b border-line text-ink-3">
                <tr>
                  <th className="py-2 pr-3 font-medium">商品</th>
                  <th className="py-2 pr-3 text-right font-medium">已生成</th>
                  <th className="py-2 text-right font-medium">已兑换</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.byProduct.map((p) => (
                  <tr key={p.productId}>
                    <td className="py-2 pr-3">{label(p.productId, p.productName)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{p.created}</td>
                    <td className="py-2 text-right tabular-nums">{p.redeemed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-[15px] font-semibold">全部兑换码</h3>
        {data.rows.length === 0 ? (
          <p className="mt-2 text-ink-3">还没有兑换码。</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm" data-testid="redeem-codes">
              <thead className="border-b border-line text-ink-3">
                <tr>
                  <th className="py-2 pr-3 font-medium">兑换码</th>
                  <th className="py-2 pr-3 font-medium">商品</th>
                  <th className="py-2 pr-3 font-medium">备注</th>
                  <th className="py-2 pr-3 font-medium">生成时间</th>
                  <th className="py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((r) => (
                  <tr key={r.code}>
                    <td className="py-2 pr-3 whitespace-nowrap font-mono select-all">{r.code}</td>
                    <td className="py-2 pr-3">{nameOf(r.productId)}</td>
                    <td className="py-2 pr-3 text-ink-2">{r.note ?? "—"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{formatDateTime(r.createdAt)}</td>
                    <td className="py-2">
                      {r.redeemedAt ? (
                        <span>
                          已兑换 · {r.redeemedBy ?? "—"} · <span className="tabular-nums">{formatDateTime(r.redeemedAt)}</span>
                        </span>
                      ) : (
                        <span className="text-ink-3">未使用</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
