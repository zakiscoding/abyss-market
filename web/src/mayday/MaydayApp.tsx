import { useEffect, useRef, useState } from "react";

import type { AbyssEvent, ClientMsg } from "../contract";
import { FixtureSource } from "../sources/fixture";
import type { EventSource } from "../sources/types";
import { WsSource } from "../sources/ws";
import type { MarketState } from "../state/reducer";
import { store } from "../state/store";
import { DebugPanel } from "../ui/DebugPanel";
import { HarborScene } from "./HarborScene";
import { formatClock, moodOf, STATUS_LABEL } from "./model";
import { ApprovalCard, BidsPanel, OutcomePanel, PipelineBar, TeamPanel, TelemetryPanel, Terminal } from "./panels";
import "./mayday.css";

const params = new URLSearchParams(window.location.search);
const SOURCE = params.get("source") === "ws" ? "ws" : "fixture";
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8000/ws";
const parsedSpeed = Number(params.get("speed") || "1");
const SPEED = SOURCE === "fixture" && Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;
const INTERACTIVE = params.get("auto") !== "1";

function createSource(): EventSource {
  if (SOURCE === "ws") {
    return new WsSource(WS_URL, (connected) => store.setConnected(connected));
  }
  const file = params.get("file") || "mayday_run";
  return new FixtureSource(`/fixtures/${encodeURIComponent(file)}.json`, SPEED, INTERACTIVE);
}

function modeBadge(state: MarketState): { label: string; tone: string } {
  if (SOURCE === "fixture") return { label: INTERACTIVE ? "REPLAY" : "REPLAY AUTO", tone: "replay" };
  if (!state.connected) return { label: "OFFLINE", tone: "offline" };
  if (!state.config) return { label: "CONNECTING", tone: "offline" };
  if (state.config.fake_llm) return { label: "FAKE LLM", tone: "fake" };
  if (!state.config.real_models) return { label: "HAIKU TEST MODE", tone: "test" };
  return { label: "LIVE MODELS", tone: "live" };
}

/** Incident clock: event time of the latest event plus the time since it
 *  arrived, frozen at the measured MTTR once the service is restored. */
function useIncidentClock(state: MarketState): number {
  const anchor = useRef({ jobId: "", t: 0, at: 0, shown: 0 });
  const [, setTick] = useState(0);
  const jobId = state.currentJob?.jobId ?? "";
  const last = [...state.log].reverse().find((ev) => ev.job_id === jobId && jobId !== "");
  const status = state.incident.status;
  const running = status !== null && status !== "healthy" && status !== "restored" && status !== "failed";

  if (last && (anchor.current.jobId !== jobId || last.t > anchor.current.t)) {
    const reset = anchor.current.jobId !== jobId;
    anchor.current = { jobId, t: last.t, at: performance.now(), shown: reset ? 0 : anchor.current.shown };
  }
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);

  if (state.incident.restored) return state.incident.restored.mttr_ms;
  if (!last || status === "healthy" || status === null) return 0;
  if (!running) return anchor.current.t;
  const live = anchor.current.t + (performance.now() - anchor.current.at) * SPEED;
  anchor.current.shown = Math.max(anchor.current.shown, live);
  return anchor.current.shown;
}

export default function MaydayApp() {
  const [state, setState] = useState(store.getState());
  const [showLedger, setShowLedger] = useState(params.get("ledger") === "1");
  const [approvalSent, setApprovalSent] = useState(false);
  const [breakSent, setBreakSent] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [sceneReady, setSceneReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let scene: HarborScene | null = null;
    let unsubscribe = () => {};
    void HarborScene.create(stageRef.current!).then((created) => {
      if (cancelled) {
        created.destroy();
        return;
      }
      scene = created;
      if (import.meta.env.DEV) (window as unknown as { __mayday: unknown }).__mayday = { scene: created, store };
      scene.render(store.getState());
      unsubscribe = store.subscribe(() => scene?.render(store.getState()));
      setSceneReady(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      scene?.destroy();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const source = createSource();
    sourceRef.current = source;
    source.start((event: AbyssEvent) => {
      store.dispatch(event);
      if (event.type === "incident_status") {
        if (event.data.status !== "awaiting_approval") setApprovalSent(false);
        if (event.data.status !== "healthy") setBreakSent(false);
      }
      if (event.type === "error") setBreakSent(false);
      // A live backend starts each connection with no incident; ask for the healthy baseline.
      if (event.type === "hello" && SOURCE === "ws") source.send?.({ type: "reset_incident" });
    });
    return () => {
      source.stop();
      unsubscribe();
    };
  }, []);

  const send = (message: ClientMsg) => {
    const sent = sourceRef.current?.send?.(message);
    if (sent === false) console.warn("Message not accepted", message);
    return sent !== false;
  };

  const incident = state.incident;
  const status = incident.status;
  const mood = moodOf(status);
  const clock = useIncidentClock(state);
  const badge = modeBadge(state);
  const canBreak = status === "healthy" && !state.jobActive && !breakSent;
  const canReset = status !== null && status !== "healthy";

  return (
    <div className={`mayday ${showLedger ? "with-ledger" : ""}`} data-mood={mood}>
      <header className="md-header">
        <div className="md-brand">
          <span className="md-logo">MAYDAY</span>
          <span className="md-powered">Powered by the Abyss Agent Market</span>
        </div>
        <div className={`md-sev ${incident.severity ? "on" : ""}`}>
          {incident.severity ? (
            <>
              <span className="md-sev-tag">{incident.severity}</span>
              <span className="md-sev-text">{incident.headline}</span>
            </>
          ) : (
            <span className="md-sev-text">{status === "restored" ? incident.headline : "All systems nominal"}</span>
          )}
        </div>
        <div className="md-clock" title="Time since the outage began">
          <small>INCIDENT</small>
          <strong>{formatClock(clock)}</strong>
        </div>
        <div className={`md-service ${mood}`}>
          <span className="dot" />
          <div>
            <small>{incident.service}</small>
            <strong>{status ? STATUS_LABEL[status] : "CONNECTING"}</strong>
          </div>
        </div>
        <div className="md-actions">
          <span className={`md-badge ${badge.tone}`}>{badge.label}</span>
          <button
            type="button"
            className="md-break"
            disabled={!canBreak}
            onClick={() => {
              if (send({ type: "start_incident" })) setBreakSent(true);
            }}
          >
            Break Production
          </button>
          <button type="button" className="md-ghost" disabled={!canReset} onClick={() => send({ type: "reset_incident" })}>
            Reset
          </button>
          <button type="button" className="md-ghost" onClick={() => setShowLedger((v) => !v)}>
            {showLedger ? "Hide ledger" : "Ledger"}
          </button>
        </div>
      </header>

      <aside className="md-left">
        <TelemetryPanel incident={incident} />
        <Terminal state={state} />
      </aside>

      <main className="md-center">
        <div className="md-stage" ref={stageRef}>
          {!sceneReady && <div className="md-stage-placeholder">HARBOR INITIALIZING</div>}
          {status === "awaiting_approval" && incident.approval && (
            <ApprovalCard
              approval={incident.approval}
              team={incident.team}
              sent={approvalSent}
              onApprove={() => {
                if (send({ type: "approve_repair" })) setApprovalSent(true);
              }}
            />
          )}
        </div>
        <PipelineBar state={state} />
      </main>

      <aside className="md-right">
        <BidsPanel state={state} />
        <TeamPanel incident={incident} />
      </aside>

      <footer className="md-bottom">
        <OutcomePanel state={state} />
      </footer>

      {showLedger && (
        <div className="md-ledger">
          <DebugPanel state={state} />
        </div>
      )}
    </div>
  );
}