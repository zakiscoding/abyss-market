import type { MarketState } from "../../state/reducer";
import { currentTask } from "../../scene/model";
import { REPAIR_COPY, type RepairPhase } from "./repairPhase";
import { workerName } from "./command";

export function DockWorker({ state, phase }: { state: MarketState; phase: RepairPhase }) {
  const task = currentTask(state);
  const winner = task?.winner;
  const fishing = phase === "selecting";
  const restored = phase === "restored";
  const label = REPAIR_COPY[phase].action;
  return <div className={`dock-worker ${fishing ? "fishing" : "working"} ${restored ? "celebrating" : ""}`} role="img" aria-label={`Dock worker: ${label}`}>
    <svg viewBox="0 0 400 200" shapeRendering="crispEdges" aria-hidden="true">
      <defs><linearGradient id="worker-water" x2="0" y2="1"><stop stopColor="#38cec3" stopOpacity=".3" /><stop offset="1" stopColor="#38cec3" stopOpacity="0" /></linearGradient></defs>
      <ellipse cx="265" cy="160" rx="105" ry="24" fill="url(#worker-water)" />
      <g className="worker-ripples" fill="none" stroke="#9ef5dd" opacity=".65"><ellipse cx="277" cy="158" rx="20" ry="5" /><ellipse cx="277" cy="158" rx="36" ry="9" /></g>
      <g className="worker-fish" fill="#f6df9a"><path d="M238 169q12-14 24 0q-12 14-24 0l-9 7v-14z" /><circle cx="257" cy="167" r="1.5" fill="#143746" /></g>
      <ellipse cx="93" cy="148" rx="35" ry="7" fill="#04132166" />
      <g className="worker-person" shapeRendering="crispEdges">
        <svg x="62" y="23" width="78" height="126" viewBox="0 0 26 42" overflow="visible">
          {/* A fixed pixel grid keeps the character in the harbor's game-art style. */}
          <path d="M7 0h11v2h4v4h2v5h-3v9h-2v2h3v10h-3v6h3v4H10v-3H8v3H0v-4h3V24h2v-5H3v-8H0V7h3V3h4z" fill="#26352f" />
          <path d="M7 2h11v2h3v4H4V4h3z" fill="#398e8b" />
          <path d="M8 2h8v2H8zM5 4h4v3H5z" fill="#89d0bb" />
          <path d="M18 4h3v4h-5V6h2z" fill="#24636d" />
          <path d="M1 8h23v3H1z" fill="#7cbab0" /><path d="M1 10h23v2H1z" fill="#345d61" />
          <path d="M6 12h14v7h-3v3H9v-3H6z" fill="#d6a16d" />
          <path d="M7 12h9v7H9v-2H7z" fill="#f0bf85" />
          <path d="M18 12h2v7h-3v2h-3v-2h3v-5h1z" fill="#a97050" />
          <path d="M15 14h2v2h-2z" fill="#283b3a" /><path d="M15 18h3v1h-3z" fill="#774d3e" />
          <path d="M7 22h12v11H5V25h2z" fill="#c78a35" />
          <path d="M7 22h5v10H7z" fill="#f0ba4c" /><path d="M14 22h4v10h-4z" fill="#e2a540" />
          <path d="M8 23h2v9H8zM15 23h2v9h-2zM6 28h13v2H6z" fill="#ffe09a" />
          <path d="M12 22h2v11h-2zM5 31h14v3H5z" fill="#795b36" />
          <path d="M5 34h6v5H4zM13 34h6v5h-6z" fill="#365568" />
          <path d="M5 34h2v4H5zM13 34h2v4h-2z" fill="#577987" />
          <path d="M3 39h8v3H1v-2h2zM13 39h8v1h2v2H13z" fill="#263d46" />
          <path d="M2 40h8v1H2zM14 40h7v1h-7z" fill="#6b8284" />
          <path d="M5 24h2v8H4v-6h1z" fill="#f0bf85" /><path d="M4 30h3v3H4z" fill="#ae784f" />
        </svg>
        <g className="worker-arm">
          <path d="M115 87h9v6h6v-6h9v-6h9v12h-9v9h-15v-6h-9z" fill="#26352f" />
          <path d="M118 87h6v9h9v-6h9v-6h6v6h-9v9h-12v-6h-9z" fill="#edb980" />
          <path d="M124 96h9v3h-9zM139 90h6v3h-6z" fill="#b17d52" />
        </g>
      </g>
      {!fishing && <g stroke="#142632" strokeWidth="3">
        <g className="worker-tool"><path d="M137 72h9v36h-9z" fill="#c89d63" /><path d="M127 63h29v14h-29z" fill="#c5e2db" /></g>
        <path d="M132 123h35v24h-35z" fill="#327b80" /><path d="M141 123v-6h16v6" fill="none" stroke="#c5e2db" /><path d="M146 130h8v8h-8z" fill="#ffe5a5" />
      </g>}
      <g className="worker-rod"><path d="M134 97Q166 16 221 28" fill="none" stroke="#ffe1a0" strokeWidth="4" /><path className="worker-line" d="M221 28Q250 60 277 150" fill="none" stroke="#e2fff1" strokeWidth="1.5" /><g className="worker-bobber"><path d="M277 146v-8" stroke="#fff" strokeWidth="2" /><ellipse cx="277" cy="151" rx="5" ry="8" fill="#ff695f" /><path d="M272 150h10" stroke="#fff" strokeWidth="3" /></g></g>
    </svg>
    <span className="worker-action">{label}</span>
    <div className="worker-catch" key={`${task?.task_id}-${winner ?? "bids"}`}>
      {fishing ? <><span>Haiku</span><span>Sonnet</span><span>Opus</span></> : winner ? <strong>{workerName(winner)}</strong> : <span>Awaiting bids</span>}
    </div>
  </div>;
}
