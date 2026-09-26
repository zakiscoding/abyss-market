import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { AgentId } from "../../contract";
import { DOCKS, captainReadout, selectionFor } from "./command";
import { alertBadge, stallAlerts } from "./alerts";
import { useRepairCinema } from "./RepairCinema";
import { repairShot } from "./repairPhase";
import { DockWorker } from "./DockWorker";
import { Pipeline } from "./panels";
import { seasidePicture, type SeasidePicture } from "./seaside";
import type { MarketState } from "../../state/reducer";

const ART = { w: 1024, h: 576 };
const ART_SRC = "/art/seaside-market.jpg";

/** Fractions of the painting. Tuned to the blank stall signs, the pier, the boat, and the water beside it. */
const SPOT: Record<AgentId, { x: number; y: number }> = {
  haiku: { x: 28.2, y: 30.4 },
  sonnet: { x: 56.2, y: 30.6 },
  opus: { x: 78.8, y: 30.4 },
};
const SANDBOX = { x: 70, y: 64 };

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

function Remedy({ picture }: { picture: SeasidePicture }) {
  const agent = picture.remedyAgent;
  const [arrived, setArrived] = useState(false);
  const key = picture.remedyKey;
  useLayoutEffect(() => {
    if (!key) return;
    setArrived(false);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setArrived(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [key]);
  if (!agent || !picture.remedyText) return null;
  const from = SPOT[agent];
  const at = arrived ? SANDBOX : { x: from.x, y: from.y + 8 };
  return (
    <div className={`remedy remedy-${picture.sandbox}`} style={{ left: `${at.x}%`, top: `${at.y}%` }}>
      {picture.remedyText}
    </div>
  );
}

export function SeasideScene({
  state,
  approving,
  canApprove,
  onApprove,
}: {
  state: MarketState;
  approving: boolean;
  canApprove: boolean;
  onApprove: () => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cinema = useRepairCinema(state);
  const workerPhase = repairShot(state) ?? (state.incident?.status === "awaiting_approval" ? "validated" : null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [frame, setFrame] = useState<Frame | null>(null);
  const [artOk, setArtOk] = useState(true);
  const [openStall, setOpenStall] = useState<AgentId | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dock = DOCKS.find((item) => item.stall === openStall);
  const market = selectionFor(state);
  const openAlerts = dock ? stallAlerts(state, dock.domain) : [];
  const picture = seasidePicture(state);
  const captain = captainReadout(state);
  const activeStall = DOCKS.find((item) => item.domain === state.incident?.commander?.domain)?.stall;
  const focusSpot = activeStall ? SPOT[activeStall] : null;
  const zoomed = Boolean(cinema.shot && focusSpot && frame);
  const camera = frame && zoomed && focusSpot ? (() => {
    const width = frame.width * 1.65;
    const height = frame.height * 1.65;
    return {
      width, height,
      left: Math.min(0, Math.max(viewport.width - width, viewport.width / 2 - width * focusSpot.x / 100)),
      top: Math.min(0, Math.max(viewport.height - height, viewport.height * .48 - height * .39)),
    };
  })() : frame;

  useLayoutEffect(() => {
    if (openStall) dialogRef.current?.showModal();
  }, [openStall]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w && h) { setFrame(coverFrame(w, h)); setViewport({ width: w, height: h }); }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`harbor-stage scene-mood-${picture.mood} ${zoomed ? "stall-focused" : ""}`} ref={stageRef}>
      <p className="sr-only">
        Abyss command harbor. The boat is Captain AI. The stalls are the Database Repair, Network Routing, and Security Watch stalls.
        The water beside the dock is the sandbox.
      </p>
      <div
        className={`scene-frame ${frame ? "" : "pending"}`}
        style={camera ? { left: camera.left, top: camera.top, width: camera.width, height: camera.height } : undefined}
      >
        {artOk ? (
          <img src={ART_SRC} alt="" draggable={false} onError={() => setArtOk(false)} />
        ) : (
          <div className="art-missing" role="status">Harbor artwork failed to load. Incident controls are still live.</div>
        )}
        {frame && (
          <>
            {workerPhase && focusSpot && <div className={`stall-resident phase-${workerPhase}`} style={{ left: `${focusSpot.x - 3.4}%`, top: "29.5%" }}>
              <DockWorker state={state} phase={workerPhase} />
            </div>}
            <div className={`boat-marker ${picture.boat}`} style={{ left: "32%", top: "76%" }}>
              <b>Captain AI</b>
              <small>{picture.boat === "calm" ? "Standing by" : `${picture.service} · ${picture.region}`}</small>
            </div>

            {picture.classification && (
              <div className="commander-banner" key={picture.classification}>
                <small>Captain AI</small>
                <strong>{picture.classification}</strong>
                <p>{captain.text}</p>
              </div>
            )}

            {picture.stalls.map((stall) => {
              const stallDock = DOCKS.find((item) => item.stall === stall.agentId)!;
              const alerts = stallAlerts(state, stallDock.domain);
              const count = alerts.length;
              return (
              <button
                key={stall.agentId}
                type="button"
                aria-label={`Explore ${stall.sign}`}
                aria-haspopup="dialog"
                aria-describedby={`stall-preview-${stall.agentId}`}
                onClick={() => setOpenStall(stall.agentId)}
                className={`stall ${count ? "has-alerts" : "all-clear"} ${stall.lit ? "lit" : ""} ${stall.winner ? "winner" : ""}`}
                style={{ left: `${SPOT[stall.agentId].x}%`, top: `${SPOT[stall.agentId].y}%`, "--glow": stall.color } as CSSProperties}
              >
                <span className="stall-glow" />
                {count > 0 && <span className="stall-alert-badge" aria-label={`${count} unresolved ${count === 1 ? "alert" : "alerts"}`}>{alertBadge(count)}</span>}
                <span className="stall-sign">
                  {stall.sign}
                </span>
                <span className="stall-hint"><span className="stall-status-dot" />{count ? `${alertBadge(count)} ${count === 1 ? "alert" : "alerts"}` : "All clear"}</span>
                <span className="stall-preview" id={`stall-preview-${stall.agentId}`} role="tooltip">
                  <span className="stall-preview-heading">{count ? "ATTENTION NEEDED" : "READY TO RESPOND"}</span>
                  <strong>{stall.sign}</strong>
                  <span className="stall-preview-detail">{count ? `${alerts[0].severity ?? "Alert"} / ${alerts[0].service}` : "No active alerts for this specialty."}</span>
                  {count > 0 && <span className="stall-preview-message">{alerts[0].message}</span>}
                  <span className="stall-preview-link">Click to inspect specialists &amp; alerts <span aria-hidden="true">&#8599;</span></span>
                </span>
                {stall.bubble && !(workerPhase && activeStall === stall.agentId) && <span className={`stall-bubble ${stall.winner ? "won" : ""}`}>{stall.bubble}</span>}
              </button>
            ); })}

            <div className="dock-strip">
              {picture.boat === "calm" ? (
                <p className="dock-legend">
                  Incidents enter one harbor. The Commander routes each one. Specialists compete. The sandbox tests the repair. Humans approve production.
                </p>
              ) : (
                <Pipeline state={state} />
              )}
            </div>

            <div className={`approval-gate ${picture.gate}`}>
              <span className="gate-leaf" />
              <span className="gate-leaf" />
              {picture.gate === "closed" && canApprove && (
                <button type="button" className="approve-button" disabled={approving} onClick={onApprove}>
                  {approving ? "Applying..." : "Approve repair"}
                </button>
              )}
            </div>

            {picture.responders.length > 0 && (
              <ul className="dock-crew">
                {picture.responders.map((person) => (
                  <li key={person.id} className={person.needsApproval ? "needed" : ""}>
                    {person.name}
                  </li>
                ))}
              </ul>
            )}

            <div className={`sandbox sandbox-${picture.sandbox}`} aria-live="polite">
              <b>Sandbox</b>
              <small>
                {picture.sandbox === "pass" ? "Passed" : picture.sandbox === "fail" ? "Rejected" : picture.sandbox === "testing" ? "Testing" : "Waiting for a plan"}
              </small>
            </div>
            <Remedy picture={picture} />
          </>
        )}
      </div>
      {zoomed && <button type="button" className="harbor-zoom-out" onClick={cinema.skip}>Show whole harbor</button>}
      <dialog ref={dialogRef} className="stall-dialog" aria-labelledby="stall-dialog-title"
        onClose={() => setOpenStall(null)} onClick={(event) => {
          if (event.target === event.currentTarget) {
            const bounds = event.currentTarget.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
          }
        }}>
        <header className="panel-head">
          <div><small>SPECIALIST DOCK</small><h2 id="stall-dialog-title">{dock?.title}</h2></div>
          <button type="button" autoFocus onClick={() => dialogRef.current?.close()} aria-label="Close specialist details">Close</button>
        </header>
        <p>{state.incident?.commander?.domain === dock?.domain
          ? "This dock is handling the current incident. Specialists compete to diagnose and repair it."
          : "Standing by. The Commander dispatches this dock when an incident needs its specialty."}</p>
        <section className={`stall-alert-summary ${openAlerts.length ? "has-alerts" : ""}`}>
          <h3>{openAlerts.length ? `${alertBadge(openAlerts.length)} unresolved ${openAlerts.length === 1 ? "alert" : "alerts"}` : "No active alerts"}</h3>
          {openAlerts.length ? <ul>{openAlerts.map((alert) => <li key={alert.id}><strong>{alert.service}</strong><span>{alert.severity ?? "Alert"} - {alert.message}</span></li>)}</ul> : <p>This specialty is standing by.</p>}
        </section>
        <h3>Available specialists</h3>
        <ul className="stall-specialists">
          {market.models.filter((model) => dock && model.domains.includes(dock.domain)).map((model) => (
            <li key={model.id}><strong>{model.displayName}</strong><span className={`avail avail-${model.availability}`}>{model.availability}</span><small>{model.provider}</small></li>
          ))}
        </ul>
        <p className="muted">Follow bids and validation in the Evidence tab. Production changes require human approval.</p>
      </dialog>
    </div>
  );
}
