// 浏览器端共用的 React hooks。
import { useEffect, useState } from "react";
import type { Me, SiteInfo } from "@fde/contracts";
import { api, isFailure } from "./api";

/** 接口不通时页脚也要有合规标识,所以先用这份兜底。 */
export const SITE_FALLBACK: SiteInfo = {
  aiNotice: "对话内容由 AI 生成",
  modelDisclosure: null,
  icpNumber: null,
  publicSecurityNumber: null,
  inviteOnly: true,
  smsLogin: false,
  presaleOpen: false,
};

let sitePromise: Promise<SiteInfo> | null = null;

function loadSite(): Promise<SiteInfo> {
  sitePromise ??= api.site().catch((e: unknown) => {
    sitePromise = null; // 失败了下次再试
    throw e;
  });
  return sitePromise;
}

/** GET /api/site,整个页面生命周期只请求一次。加载前和失败时返回兜底值。 */
export function useSite(): { site: SiteInfo; loaded: boolean } {
  const [site, setSite] = useState<SiteInfo | null>(null);
  useEffect(() => {
    let alive = true;
    loadSite()
      .then((s) => alive && setSite(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return { site: site ?? SITE_FALLBACK, loaded: site !== null };
}

export type MeState = { status: "loading" } | { status: "anon" } | { status: "error"; message: string } | { status: "ok"; user: Me };

/** GET /api/me;401 视为未登录。 */
export function useMe(): [MeState, (u: Me | null) => void] {
  const [state, setState] = useState<MeState>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((r) => alive && setState({ status: "ok", user: r.user }))
      .catch((e: unknown) => {
        if (!alive) return;
        if (isFailure(e, "unauthorized")) setState({ status: "anon" });
        else setState({ status: "error", message: e instanceof Error ? e.message : "加载失败" });
      });
    return () => {
      alive = false;
    };
  }, []);
  const set = (u: Me | null) => setState(u ? { status: "ok", user: u } : { status: "anon" });
  return [state, set];
}

/** localStorage 只存本机便利项(笔记、提示是否看过);隐身窗口等情况下会抛错,一律吞掉。 */
export const local = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* 存不了就算了 */
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* 同上 */
    }
  },
};
