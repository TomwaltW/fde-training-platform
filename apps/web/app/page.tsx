// 落地页:一句话定位(方案 1.5)+ 场景卡片 + 开始按钮。场景数据由客户端从 /api/scenarios 取。
import { SiteHeader } from "@/components/SiteHeader";
import { LandingClient } from "@/components/landing/LandingClient";

const STEPS = [
  { t: "上午调研", d: "想找谁聊就直接说,或者点人物。每句话、每次走动都花时间,一共 6 小时。可以要资料、去现场看、做小验证。" },
  { t: "提交判断", d: "真正的问题是什么、证据在哪、「做成」对老板意味着什么、第一步做什么、明确不做什么。" },
  { t: "下午汇报,看复盘", d: "老板会拿你上午说过的话来问你。收工后按七个维度打分,关键时刻引用你的原话。" },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-5xl px-4 pb-12">
        <section className="pt-10 pb-8 sm:pt-16 sm:pb-12">
          <p className="text-sm font-medium text-accent">给想做 FDE 的人</p>
          <h1 className="mt-2 text-[28px] font-bold leading-tight tracking-tight sm:text-5xl">可以翻车的客户现场</h1>
          <p className="mt-4 max-w-2xl text-[17px] leading-8 text-ink-2">
            AI 扮演的老板、主管、一线和财务各说各的。你去问、去要数据、去做判断,最后拿到一份逐轮指出问题的复盘。
          </p>
          <p className="mt-3 max-w-2xl text-[15px] leading-7 text-ink-3">
            适合需要独自面对客户、把模糊需求变成可交付范围的技术人:驻场开发、实施、售前、解决方案。
          </p>
        </section>

        <LandingClient />

        <section className="mt-12" aria-labelledby="how">
          <h2 id="how" className="text-lg font-semibold">一局怎么玩</h2>
          <ol className="mt-4 grid gap-3 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.t} className="rounded-xl border border-line bg-surface p-4">
                <p className="text-sm font-semibold text-accent">第 {i + 1} 步</p>
                <p className="mt-1 font-semibold">{s.t}</p>
                <p className="mt-1.5 text-[15px] leading-7 text-ink-2">{s.d}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm leading-7 text-ink-3">手机上能玩,电脑上看资料更顺手;进度自动保存,换设备登录同一个邮箱接着玩。</p>
        </section>
      </main>
    </>
  );
}
