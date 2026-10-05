// 内联 SVG 图表(没有图表库):七维雷达图、柱状直方图、横条列表。
// 单一数据系列,颜色只用 accent;文字一律用文字色;网格线是细实线。每个数据点带 <title> 作为悬停提示。
import { formatScore } from "@/lib/client/format";

export interface RadarDim {
  id: string;
  name: string;
  score: number;
  max: number;
}

/** 名字超过 5 个字就折成两行,优先在"与"后面断开。 */
function splitLabel(name: string): string[] {
  if (name.length <= 5) return [name];
  const i = name.indexOf("与");
  const at = i >= 1 && i <= name.length - 3 ? i + 1 : Math.min(4, name.length - 2);
  return [name.slice(0, at), name.slice(at)];
}

export function RadarChart({ dims, size = 420 }: { dims: RadarDim[]; size?: number }) {
  const W = size;
  const H = size * 0.86;
  const cx = W / 2;
  const cy = H / 2 + 4;
  const r = W * 0.26;
  const n = dims.length;
  if (n < 3) return null;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, k: number) => [cx + Math.cos(angle(i)) * r * k, cy + Math.sin(angle(i)) * r * k] as const;
  const ratio = (d: RadarDim) => (d.max > 0 ? Math.max(0, Math.min(1, d.score / d.max)) : 0);
  const poly = dims.map((d, i) => pt(i, ratio(d)).join(",")).join(" ");
  const summary = dims.map((d) => `${d.name} ${formatScore(d.score)}/${d.max}`).join(",");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`七个维度得分:${summary}`} data-testid="radar-chart" className="mx-auto block h-auto w-full max-w-[460px]">
      {/* 网格:25% / 50% / 75% / 100% 四圈 */}
      {[0.25, 0.5, 0.75, 1].map((k) => (
        <polygon
          key={k}
          points={dims.map((_, i) => pt(i, k).join(",")).join(" ")}
          fill="none"
          stroke="var(--line)"
          strokeWidth={1}
        />
      ))}
      {dims.map((d, i) => {
        const [x, y] = pt(i, 1);
        return <line key={d.id} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--line)" strokeWidth={1} />;
      })}
      {/* 数据 */}
      <polygon points={poly} fill="var(--accent)" fillOpacity={0.14} stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
      {dims.map((d, i) => {
        const [x, y] = pt(i, ratio(d));
        return (
          <g key={d.id}>
            <circle cx={x} cy={y} r={10} fill="transparent">
              <title>{`${d.id} ${d.name}:${formatScore(d.score)} / ${d.max}`}</title>
            </circle>
            <circle cx={x} cy={y} r={4.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} pointerEvents="none" />
          </g>
        );
      })}
      {/* 标签:维度名 + 得分 */}
      {dims.map((d, i) => {
        const a = angle(i);
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const lx = cx + cos * (r + 16);
        const ly = cy + sin * (r + 16);
        const anchor = Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
        const lines = splitLabel(d.name);
        const lh = 17;
        const total = lines.length + 1;
        // 上方的标签往上排,下方的往下排,左右的垂直居中
        const startY = sin < -0.5 ? ly - (total - 1) * lh : sin > 0.5 ? ly + 12 : ly - ((total - 1) * lh) / 2 + 4;
        return (
          <text key={d.id} x={lx} y={startY} textAnchor={anchor} fontSize={14} fill="var(--ink-2)">
            {lines.map((l, j) => (
              <tspan key={j} x={lx} dy={j === 0 ? 0 : lh}>
                {l}
              </tspan>
            ))}
            <tspan x={lx} dy={lh} fill="var(--ink)" fontWeight={600}>
              {`${formatScore(d.score)}/${d.max}`}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}

/** 柱状直方图(管理页的分数分布)。柱宽不超过 24px,顶端 4px 圆角,柱顶标数。 */
export function ColumnChart({ data, label, testId }: { data: { label: string; value: number }[]; label: string; testId?: string }) {
  const W = 560;
  const H = 220;
  const padL = 28;
  const padB = 34;
  const padT = 22;
  const max = Math.max(1, ...data.map((d) => d.value));
  const band = (W - padL - 8) / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.6);
  const plotH = H - padB - padT;
  const ticks = niceTicks(max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} data-testid={testId} className="block h-auto w-full">
      {ticks.map((t) => {
        const y = padT + plotH - (t / ticks[ticks.length - 1]!) * plotH;
        return (
          <g key={t}>
            <line x1={padL} x2={W - 4} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} />
            <text x={padL - 6} y={y + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)" style={{ fontVariantNumeric: "tabular-nums" }}>
              {t}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const top = ticks[ticks.length - 1]!;
        const h = (d.value / top) * plotH;
        const x = padL + band * i + (band - bw) / 2;
        const y = padT + plotH - h;
        const rr = Math.min(4, h);
        return (
          <g key={d.label}>
            <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent">
              <title>{`${d.label}:${d.value}`}</title>
            </rect>
            {h > 0 && (
              <path
                d={`M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + bw - rr} Q${x + bw},${y} ${x + bw},${y + rr} V${y + h} Z`}
                fill="var(--accent)"
                pointerEvents="none"
              />
            )}
            {d.value > 0 && (
              <text x={x + bw / 2} y={y - 6} textAnchor="middle" fontSize={12} fill="var(--ink)" fontWeight={600}>
                {d.value}
              </text>
            )}
            <text x={x + bw / 2} y={H - padB + 18} textAnchor="middle" fontSize={11} fill="var(--ink-3)">
              {d.label}
            </text>
          </g>
        );
      })}
      <line x1={padL} x2={W - 4} y1={padT + plotH} y2={padT + plotH} stroke="var(--ink-3)" strokeWidth={1} />
    </svg>
  );
}

function niceTicks(max: number): number[] {
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 5 / 5) * 5;
  const out: number[] = [];
  for (let v = 0; v <= max + step - 1; v += step) out.push(v);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

/** 横条列表(流失轮次等):左边标签,中间条,右边数值。纯 HTML,窄屏也不会溢出。 */
export function BarList({ data, testId }: { data: { label: string; value: number; title?: string }[]; testId?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="flex flex-col gap-2" data-testid={testId}>
      {data.map((d) => (
        <li key={d.label} className="grid grid-cols-[5.5rem_1fr_2.5rem] items-center gap-3 text-sm" title={d.title ?? `${d.label}:${d.value}`}>
          <span className="text-ink-2">{d.label}</span>
          <span className="h-3 rounded-r bg-surface-2">
            <span className="block h-3 rounded-r bg-accent" style={{ width: `${(d.value / max) * 100}%` }} />
          </span>
          <span className="text-right font-semibold tabular-nums">{d.value}</span>
        </li>
      ))}
    </ul>
  );
}
