import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Domain } from "../../contract";
import type { MarketState } from "../../state/reducer";
import { selectionFor } from "./command";
import { DockWorker } from "./DockWorker";
import { repairShot } from "./repairPhase";
import { Pipeline } from "./panels";
import { HARBOR_STALLS, specialtyState, sandboxState, validationReadout } from "./harborView";
const ART = { w: 1672, h: 941 };
interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clampCover(offset: number, viewport: number, size: number, bandStart: number, bandEnd: number): number {
  const band0 = bandStart * size;
  const band1 = bandEnd * size;
  const minOff = -band0;
  const maxOff = viewport - band1;
  if (minOff <= maxOff) return Math.min(maxOff, Math.max(minOff, offset));
  return viewport / 2 - (band0 + band1) / 2;
}

/** Cover the viewport, then shift so the stalls, dock, and boat stay in frame. */
export function coverFrame(viewW: number, viewH: number): Frame {
  const scale = Math.max(viewW / ART.w, viewH / ART.h);
  const width = ART.w * scale;
  const height = ART.h * scale;
  return {
    width,
    height,
    left: clampCover((viewW - width) / 2, viewW, width, 0.18, 0.88),
    top: clampCover((viewH - height) / 2, viewH, height, 0.14, 0.9),
  };
}

export function SeasideScene({ state, onCaptain }: {
  state: MarketState;
  onCaptain: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [open, setOpen] = useState<Domain | null>(null);
  const [artOk, setArtOk] = useState(true);
  const incident = state.incident;
  const phase = repairShot(state) ?? (incident?.status === "awaiting_approval" ? "validated" : null);
  const sandbox = sandboxState(state);
  const primary = HARBOR_STALLS.find((stall) => stall.domain === incident?.commander?.domain);
  const market = selectionFor(state);
  const chosenDock = HARBOR_STALLS.find((stall) => stall.domain === open);
  useLayoutEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const fit = () => {
      const scale = Math.min(element.clientWidth / ART.w, element.clientHeight / ART.h);
      const width = ART.w * scale;
      const height = ART.h * scale;
      setFrame({ width, height, left: (element.clientWidth - width) / 2, top: (element.clientHeight - height) / 2 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div className="harbor-world" ref={stage}>
    <div className="harbor-painting" style={frame ? { ...frame } : undefined}>
      {artOk ? <img className="harbor-art" src="/art/seaside-five-stalls.png" alt="Five wooden specialty stalls with blue, gold, red, teal and purple awnings on a tropical harbor, with the Captain's sailboat below." onError={() => setArtOk(false)} /> : <p className="art-missing">Harbor artwork could not load. Incident controls remain available in the workspace.</p>}
      {HARBOR_STALLS.map((stall) => {
        const view = specialtyState(state, stall.domain);
        return <div key={stall.domain} className={`specialty-building state-${view.kind}`} data-domain={stall.domain}
          style={{ left: `${stall.x}%`, "--stall-color": stall.color } as CSSProperties}>
          <button type="button" className="building-sign" aria-haspopup="dialog" onClick={() => setOpen(stall.domain)} aria-label={`Explore ${stall.title}`}>{stall.title}</button>
          <span className="building-status">{view.label}</span>
          {view.primary && phase && <div className={`building-worker phase-${phase}`}><DockWorker state={state} phase={phase} /></div>}
        </div>;
      })}
      <div className="harbor-workflow"><Pipeline state={state} /></div>
      {primary && incident?.repairs.length ? <svg className="harbor-repair-route" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d={`M ${primary.x} 46 L ${primary.x} 60 Q ${primary.x} 66 75 66`} />
      </svg> : null}
      <button type="button" className="boat-captain" onClick={onCaptain} aria-label="Open Captain AI readout">
        <svg viewBox="0 0 24 38" shapeRendering="crispEdges" aria-hidden="true">
          <path fill="#143443" d="M5 0h14v4h3v7h-3v9h2v13h-3v5h-7v-4H9v4H2v-5h3V20H3V7h2z" />
          <path fill="#f5ebc9" d="M6 2h12v3h3v5H3V6h3z" /><path fill="#458f9a" d="M3 9h18v3H3z" /><path fill="#e9b884" d="M7 12h11v8H9v-2H7z" />
          <path fill="#223f57" d="M6 21h13v12H5z" /><path fill="#f5ebc9" d="M8 21h3v10H8zM14 21h3v10h-3z" /><path fill="#edc763" d="M6 22h3v3H6zM16 22h3v3h-3z" />
          <path fill="#4e7380" d="M6 33h4v4H4v-2h2zM13 33h5v2h2v2h-7z" /><path fill="#173445" d="M14 14h2v2h-2z" />
        </svg>
        <span><strong>Captain AI</strong><small>AI Commander</small></span>
      </button>
      <div className={`harbor-sandbox sandbox-${sandbox.kind}`} role="status">
        <small>Deterministic sandbox</small><strong>{sandbox.label}</strong><span>{sandbox.detail}</span>
      </div>
    </div>
    <dialog ref={dialog} className="stall-dialog" aria-labelledby="specialty-title" onClose={() => setOpen(null)}>
      <header className="panel-head"><h2 id="specialty-title">{chosenDock?.title}</h2><button type="button" autoFocus onClick={() => dialog.current?.close()}>Close</button></header>
      {open && <p>{specialtyState(state, open).label}</p>}
      <p>{open && specialtyState(state, open).primary ? validationReadout(state) : open === "payments" && incident?.current.scenario_id === "payments_pool" ? "Payments Operations monitors the affected service while Database Repair handles the connection-pool root cause." : "Ready for incidents that need this specialty."}</p>
      <h3>Specialist models</h3>
      <ul className="stall-specialists">{market.models.filter((model) => open && model.domains.includes(open)).map((model) => <li key={model.id}><strong>{model.displayName}</strong><span>{model.availability}</span></li>)}</ul>
      <p className="muted">Only the primary remediation stall selects a worker.</p>
    </dialog>
  </div>;
}
