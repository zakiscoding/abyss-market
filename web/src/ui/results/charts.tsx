// Plain-SVG charts for the experiment results. Hover tooltips use <title>.
import type { AgentId, JobTaskType } from "../../contract";
import { AGENT_IDS, INK, TASK_TYPES, armColor, type ArmResult } from "./types";

const W = 560;
const H = 300;
const PAD = { top: 30, right: 24, bottom: 40, left: 44 };
const CHAR_W = 6.2; // Silkscreen at 9px

interface Box { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Greedy label placement: try right-above, right-below, then step further out. */
function placeLabels(items: { key: string; cx: number; cy: number; text: string }[]) {
  const placed: Box[] = [];
  const result = new Map<string, { x: number; y: number }>();
  const offsets = [-7, 15, -19, 27, -31, 39];
  for (const item of [...items].sort((a, b) => a.cx - b.cx)) {
    const w = item.text.length * CHAR_W;
    let chosen = { x: item.cx + 9, y: item.cy + offsets[0] };
    for (const dy of offsets) {
      const candidate: Box = { x: item.cx + 9, y: item.cy + dy - 9, w, h: 11 };
      if (!placed.some((p) => overlaps(p, candidate))) {
        chosen = { x: candidate.x, y: item.cy + dy };
        break;
      }
    }
    placed.push({ x: chosen.x, y: chosen.y - 9, w, h: 11 });
    result.set(item.key, chosen);
  }
  return result;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil((value * 1.1) / step) * step;
}

/** Cost (x) vs mean grade (y). Market arms are joined as the price-weight frontier. */
export function CostQualityScatter({ arms }: { arms: ArmResult[] }) {
  const xMax = niceMax(Math.max(...arms.map((a) => a.total_usd)));
  const grades = arms.map((a) => a.mean_grade ?? 0);
  const yMin = Math.max(0, Math.floor(Math.min(...grades)) - 1);
  const yMax = Math.min(10, Math.ceil(Math.max(...grades)) + 1);
  const x = (v: number) => PAD.left + (v / xMax) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - ((v - yMin) / (yMax - yMin || 1)) * (H - PAD.top - PAD.bottom);
  const market = arms
    .filter((a) => a.fixed_agent_id === null && a.mean_grade !== null)
    .sort((a, b) => (a.price_weight ?? 0) - (b.price_weight ?? 0));
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * xMax);
  const yTicks = Array.from({ length: yMax - yMin + 1 }, (_, i) => yMin + i);
  const labels = placeLabels(
    arms
      .filter((a) => a.mean_grade !== null)
      .map((a) => ({ key: a.arm, cx: x(a.total_usd), cy: y(a.mean_grade!), text: a.arm })),
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Total cost versus mean grade per arm">
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={INK.grid} strokeWidth={1} />
          <text x={PAD.left - 8} y={y(t) + 3} textAnchor="end" fill={INK.muted} fontSize={9}>{t}</text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={`x${t}`} x={x(t)} y={H - PAD.bottom + 14} textAnchor="middle" fill={INK.muted} fontSize={9}>
          ${t.toFixed(t < 0.1 ? 3 : 2)}
        </text>
      ))}
      <text x={(W + PAD.left) / 2} y={H - 6} textAnchor="middle" fill={INK.secondary} fontSize={9}>total cost (USD) →</text>
      <text x={12} y={14} fill={INK.secondary} fontSize={9}>↑ mean grade</text>
      {market.length > 1 && (
        <polyline
          points={market.map((a) => `${x(a.total_usd)},${y(a.mean_grade!)}`).join(" ")}
          fill="none" stroke={armColor(market[0])} strokeWidth={2} strokeDasharray="4 3"
        />
      )}
      {arms.map((a) => {
        if (a.mean_grade === null) return null;
        const cx = x(a.total_usd);
        const cy = y(a.mean_grade);
        const tip = `${a.arm}\ncost $${a.total_usd.toFixed(4)}\nmean grade ${a.mean_grade}\n$/grade pt ${a.usd_per_grade_point ?? "-"}`;
        return (
          <g key={a.arm}>
            <title>{tip}</title>
            <circle cx={cx} cy={cy} r={12} fill="transparent" />
            {a.fixed_agent_id ? (
              <rect x={cx - 5} y={cy - 5} width={10} height={10} rx={2} fill={armColor(a)} stroke="#102333" strokeWidth={2} />
            ) : (
              <circle cx={cx} cy={cy} r={5} fill={armColor(a)} stroke="#102333" strokeWidth={2} />
            )}
            <text x={labels.get(a.arm)!.x} y={labels.get(a.arm)!.y} fill={INK.primary} fontSize={9}>{a.arm}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Grade by job index for one arm, on a shared 0–10 scale. */
export function LearningCurve({ arm }: { arm: ArmResult }) {
  const w = 180;
  const h = 70;
  const pad = 8;
  const n = Math.max(1, arm.per_job.length - 1);
  const x = (i: number) => pad + (i / n) * (w - 2 * pad);
  const y = (g: number) => h - pad - (g / 10) * (h - 2 * pad);
  const points = arm.per_job.filter((j) => j.grade_mean !== null);
  return (
    <figure className="curve">
      <figcaption>{arm.arm}</figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Grade by job for ${arm.arm}`}>
        <line x1={pad} x2={w - pad} y1={y(5)} y2={y(5)} stroke={INK.grid} strokeWidth={1} />
        <polyline
          points={points.map((j) => `${x(j.job_idx)},${y(j.grade_mean!)}`).join(" ")}
          fill="none" stroke={armColor(arm)} strokeWidth={2}
        />
        {points.map((j) => (
          <g key={j.job_idx}>
            <title>{`${j.job_id}: grade ${j.grade_mean}, $${j.cost_usd.toFixed(4)}`}</title>
            <circle cx={x(j.job_idx)} cy={y(j.grade_mean!)} r={8} fill="transparent" />
            <circle cx={x(j.job_idx)} cy={y(j.grade_mean!)} r={3} fill={armColor(arm)} />
          </g>
        ))}
      </svg>
    </figure>
  );
}

// Diverging: red (< 1.0, overpromised) ← dark neutral at 1.0 → blue (> 1.0).
const NEUTRAL = [0x38, 0x38, 0x35];
const LOW = [0xe0, 0x62, 0x5a];
const HIGH = [0x5b, 0x9b, 0xd5];

function divergingColor(value: number): string {
  const t = Math.max(-1, Math.min(1, (value - 1) / 0.5)); // ±0.5 saturates
  const pole = t < 0 ? LOW : HIGH;
  const mix = NEUTRAL.map((c, i) => Math.round(c + (pole[i] - c) * Math.abs(t)));
  return `rgb(${mix.join(",")})`;
}

/** Final reputation per (agent, task type) for one market arm. */
export function RepHeatmap({ arm }: { arm: ArmResult }) {
  if (!arm.rep_final) return null;
  const cell = 38;
  const left = 58;
  const top = 16;
  const rep = arm.rep_final;
  return (
    <figure className="heatmap">
      <figcaption>{arm.arm} final reputation</figcaption>
      <svg viewBox={`0 0 ${left + cell * 3 + 4} ${top + cell * 3 + 4}`} role="img" aria-label={`Final reputation for ${arm.arm}`}>
        {TASK_TYPES.map((t: JobTaskType, c) => (
          <text key={t} x={left + c * cell + cell / 2} y={11} textAnchor="middle" fill={INK.muted} fontSize={8}>
            {{ research: "RSRCH", writing: "WRITE", checking: "CHECK" }[t]}
          </text>
        ))}
        {AGENT_IDS.map((agent: AgentId, r) => (
          <g key={agent}>
            <text x={left - 6} y={top + r * cell + cell / 2 + 3} textAnchor="end" fill={INK.secondary} fontSize={8}>{agent}</text>
            {TASK_TYPES.map((t, c) => {
              const v = rep[agent][t];
              return (
                <g key={t}>
                  <title>{`${agent} ${t}: ${v.toFixed(3)} (wins ${arm.wins[agent][t]})`}</title>
                  <rect x={left + c * cell + 1} y={top + r * cell + 1} width={cell - 2} height={cell - 2} rx={3} fill={divergingColor(v)} />
                  <text x={left + c * cell + cell / 2} y={top + r * cell + cell / 2 + 3} textAnchor="middle" fill={INK.primary} fontSize={9}>
                    {v.toFixed(2)}
                  </text>
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </figure>
  );
}
