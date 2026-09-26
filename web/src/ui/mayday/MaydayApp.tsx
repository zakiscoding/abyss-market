import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ClientMsg, ScenarioId } from "../../contract";
import { harborModel } from "../../scene/harbor/model";
import { FixtureSource } from "../../sources/fixture";
import type { EventSource } from "../../sources/types";
import { WsSource } from "../../sources/ws";
import type { MarketState } from "../../state/reducer";
import { store } from "../../state/store";
import { DebugPanel } from "../DebugPanel";
import { formatDuration, outcome } from "./derive";
import {
  BidCards,
  CommanderPanel,
  HistoryPanel,
  Inbox,
  OutcomePanel,
  Repairs,
  RescueTeam,
  ServiceCard,
  SpecialistsPanel,
  Terminal,
} from "./panels";
import { seasidePicture } from "./seaside";
import { SeasideScene } from "./SeasideScene";

const params = new URLSearchParams(window.location.search);
const SOURCE = params.get("source") === "ws" ? "ws" : "fixture";
const WS_URL = import.meta.env.VITE_WS_URL
  || (import.meta.env.PROD
    ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`
    : "ws://localhost:8000/ws");
const parsedSpeed = Number(params.get("speed") || "1");
const SPEED = SOURCE === "fixture" && Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;
const AUTO = params.get("auto") === "1";
const WIDE = "(min-width: 1180px)";

function fixtureUrl(scenario: ScenarioId): string {
  return `/fixtures/incident_${scenario}.json`;
}

function createSource(): EventSource {
  if (SOURCE === "ws") {
    return new WsSource(WS_URL, (connected) => store.setConnected(connected));
  }
  const file = params.get("file");
  if (file) return new FixtureSource(`/fixtures/${encodeURIComponent(file)}.json`, SPEED, AUTO);
  return new FixtureSource(fixtureUrl, SPEED, AUTO);
}

function modeBadge(state: MarketState): { label: string; tone: string } {
  if (SOURCE === "fixture") return { label: AUTO ? "REPLAY · AUTO" : "REPLAY", tone: "replay" };
  if (!state.connected) return { label: "OFFLINE", tone: "offline" };
  if (!state.config) return { label: "CONNECTING", tone: "offline" };
  if (state.config.fake_llm) return { label: "FAKE LLM", tone: "fake" };
  if (!state.config.real_models) return { label: "HAIKU TEST MODE", tone: "test" };
  return { label: "LIVE", tone: "live" };
}

function Fold({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="fold" open={open}>
      <summary>{title}</summary>
      {children}
    </details>
  );
}

export default function MaydayApp() {
  const [state, setState] = useState(store.getState());
  const [pending, setPending] = useState<"approve" | ScenarioId | null>(null);
  const [showLedger, setShowLedger] = useState(params.get("ledger") === "1");
  const [inboxOpen, setInboxOpen] = useState(() => window.matchMedia(WIDE).matches);
  const [detailOpen, setDetailOpen] = useState(() => window.matchMedia("(min-width: 1680px)").matches);
  const [now, setNow] = useState(Date.now());
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventWall = useRef(Date.now());

  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __mayday: unknown }).__mayday = { store, seasidePicture, harborModel };
    }
  }, []);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setState(store.getState()));
    const source = createSource();
    sourceRef.current = source;
    source.start((event) => {
      lastEventWall.current = Date.now();
      if (event.type === "incident_status" || event.type === "error") setPending(null);
      store.dispatch(event);
    });
    return () => {
      source.stop();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (SOURCE === "ws" && state.connected) sourceRef.current?.send?.({ type: "reset_incident" });
    if (!state.connected) setPending(null);
  }, [state.connected]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const phase = state.incident?.status;
    if ((phase === "awaiting_approval" || phase === "restored" || phase === "failed")
      && window.matchMedia("(min-width: 1400px)").matches) {
      setDetailOpen(true);
    }
  }, [state.incident?.status]);

  const send = (message: ClientMsg) => sourceRef.current?.send?.(message) ?? false;
  const incident = state.incident;
  const status = incident?.status ?? null;
  const active = status !== null && !["healthy", "restored", "failed"].includes(status);
  const mood = harborModel(state).mood;
  const picture = seasidePicture(state);
  const elapsedMs = incident?.outageT == null
    ? 0
    : incident.restored
      ? incident.restored.mttr_ms
      : incident.lastT - incident.outageT + (active ? (now - lastEventWall.current) * SPEED : 0);
  const canTrigger = status !== null && !active && pending === null && (SOURCE === "fixture" || state.connected);
  const badge = modeBadge(state);
  const cost = incident?.restored?.total_cost_usd ?? outcome(state).aiCost;
  const approve = () => {
    if (send({ type: "approve_repair" })) setPending("approve");
  };

  return (
    <div className={`mayday mood-${mood}`}>
      <header className="mayday-header">
        <div className="brand">
          <strong>MAYDAY</strong>
          <span>Seaside incident command</span>
        </div>
        <div className="header-facts" aria-label="Incident summary">
          <b className={active ? "sev" : picture.boat === "restored" ? "ok" : ""}>{picture.severity ?? "STANDBY"}</b>
          <span>{picture.service}</span>
          <span>{picture.region || "—"}</span>
          <span className="status">{(status ?? "connecting").replaceAll("_", " ")}</span>
          <span className="cost">${cost.toFixed(4)}</span>
        </div>
        <div className="incident-timer" title="Time since the outage started">
          <small>{status === "restored" ? "MTTR" : "INCIDENT"}</small>
          <b>{formatDuration(elapsedMs)}</b>
        </div>
        <div className="header-actions">
          <button type="button" className="ghost" aria-expanded={inboxOpen} onClick={() => setInboxOpen((open) => !open)}>
            Inbox
          </button>
          <button type="button" className="ghost" aria-expanded={detailOpen} onClick={() => setDetailOpen((open) => !open)}>
            Details
          </button>
          <button type="button" className={`ghost ${status === "restored" || status === "failed" ? "nudge" : ""}`} disabled={status === null}
            onClick={() => { setPending(null); send({ type: "reset_incident" }); }}>
            Reset
          </button>
          <button type="button" className="ghost" onClick={() => setShowLedger((open) => !open)}>
            {showLedger ? "Hide ledger" : "Ledger"}
          </button>
          <span className={`mode-badge ${badge.tone}`}>{badge.label}</span>
        </div>
      </header>

      <div className="harbor-wrap">
        <SeasideScene state={state} approving={pending === "approve"} onApprove={approve} />

        <aside className={`drawer left ${inboxOpen ? "open" : ""}`} aria-label="Incident inbox">
          <Inbox
            state={state}
            canTrigger={canTrigger}
            pending={typeof pending === "string" && pending !== "approve" ? pending : null}
            onTrigger={(scenarioId) => { if (send({ type: "start_incident", scenario_id: scenarioId })) setPending(scenarioId); }}
          />
          <HistoryPanel history={state.history} />
        </aside>

        <aside className={`drawer right ${detailOpen ? "open" : ""}`} aria-label="Telemetry, responders, and approval">
          <Fold title="Telemetry" open>
            <ServiceCard state={state} />
          </Fold>
          <Fold title="Commander" open={picture.classification !== null}>
            <CommanderPanel state={state} />
          </Fold>
          <Fold title="Specialist auction" open={active}>
            <BidCards state={state} />
            <SpecialistsPanel state={state} />
          </Fold>
          <Fold title="Humans" open={picture.responders.length > 0}>
            <RescueTeam state={state} />
          </Fold>
          <Fold title="Approval" open={picture.gate !== "idle" || (incident?.repairs.length ?? 0) > 0}>
            <Repairs state={state} approving={pending === "approve"} onApprove={approve} />
          </Fold>
          <Fold title="Metrics" open={picture.boat === "restored" || picture.boat === "failed"}>
            <OutcomePanel state={state} elapsedMs={elapsedMs} />
          </Fold>
          <Fold title="Terminal">
            <Terminal state={state} />
          </Fold>
        </aside>
      </div>

      {showLedger && (
        <div className="ledger-drawer">
          <DebugPanel state={state} />
        </div>
      )}
    </div>
  );
}
