import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { AgentId } from "../../contract";
import { DOCKS, captainReadout, dockWorker } from "./command";
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
  const [frame, setFrame] = useState<Frame | null>(null);
  const [artOk, setArtOk] = useState(true);
  const picture = seasidePicture(state);
  const captain = captainReadout(state);
  const worker = dockWorker(state);
  const domain = state.incident?.commander?.domain ?? null;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w && h) setFrame(coverFrame(w, h));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`harbor-stage scene-mood-${picture.mood}`} ref={stageRef}>
      <p className="sr-only">
        Abyss command harbor. The boat is Captain AI. The stalls are the Database, Network, and Security docks.
        Payments and Generalist sit on the pier. The water beside the dock is the sandbox.
      </p>
      <div
        className={`scene-frame ${frame ? "" : "pending"}`}
        style={frame ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height } : undefined}
      >
        {artOk ? (
          <img src={ART_SRC} alt="" draggable={false} onError={() => setArtOk(false)} />
        ) : (
          <div className="art-missing" role="status">Harbor artwork failed to load. Incident controls are still live.</div>
        )}
        {frame && (
          <>
            <div className={`boat-marker ${picture.boat}`} style={{ left: "32%", top: "76%" }}>
              {picture.boat !== "calm" && (
                <>
                  <b>{picture.service}</b>
                  <small>{picture.region}{picture.severity ? ` · ${picture.severity}` : ""}</small>
                </>
              )}
            </div>

            {picture.classification && (
              <div className="commander-banner" key={picture.classification}>
                <small>Captain AI</small>
                <strong>{picture.classification}</strong>
                <p>{captain.text}</p>
              </div>
            )}

            {DOCKS.filter((dock) => dock.stall === null).map((dock, index) => (
              <div
                key={dock.domain}
                className={`pier-dock ${domain === dock.domain ? "lit winner" : ""}`}
                style={{ left: `${index === 0 ? 40 : 62}%`, top: "40%" }}
              >
                <b>{dock.title}</b>
                {domain === dock.domain && worker.worker && <small>Worker: {worker.worker}</small>}
              </div>
            ))}

            {picture.stalls.map((stall) => (
              <div
                key={stall.agentId}
                className={`stall ${stall.lit ? "lit" : ""} ${stall.winner ? "winner" : ""}`}
                style={{ left: `${SPOT[stall.agentId].x}%`, top: `${SPOT[stall.agentId].y}%`, "--glow": stall.color } as CSSProperties}
              >
                <div className="stall-glow" />
                <div className="stall-sign" title={stall.sign}>
                  {stall.sign}
                </div>
                {stall.bubble && <div className={`stall-bubble ${stall.winner ? "won" : ""}`}>{stall.bubble}</div>}
              </div>
            ))}

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
    </div>
  );
}
