import { useEffect, useRef, useState } from "react";

import type { ClientMsg, ScenarioId } from "../../contract";
import { HarborScene } from "../../scene/harbor/HarborScene";
import { harborModel } from "../../scene/harbor/model";
import { FixtureSource } from "../../sources/fixture";
import type { EventSource } from "../../sources/types";
import { WsSource } from "../../sources/ws";
import type { MarketState } from "../../state/reducer";
import { store } from "../../state/store";
import { DebugPanel } from "../DebugPanel";
import { formatDuration } from "./derive";
import {
  BidCards,
  CommanderPanel,
  HistoryPanel,
  Inbox,
  OutcomePanel,
  Pipeline,
  Repairs,
  RescueTeam,
  ServiceCard,
  SpecialistsPanel,
  Terminal,
} from "./panels";

const params = new URLSearchParams(window.location.search);
const SOURCE = params.get("source") === "ws" ? "ws" : "fixture";
const WS_URL = import.meta.env.VITE_WS_URL
  || (import.meta.env.PROD
    ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`
    : "ws://localhost:8000/ws");
const parsedSpeed = Number(params.get("speed") || "1");
const SPEED = SOURCE === "fixture" && Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 1;
const AUTO = params.get("auto") === "1";

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

function banner(state: MarketState): string {
  const incident = state.incident;
  const status = incident?.status ?? null;
  if (status === null) return "CONNECTING...";
  if (status === "healthy") return "COMMAND CENTER · ALL SYSTEMS OPERATIONAL";
  const service = incident?.current.service ?? "service";
  const region = incident?.current.region?.toUpperCase() ?? "";
  if (status === "restored") return `RESOLVED · ${service} ${region}`;
  if (status === "failed") return `FAILED · ${incident?.current.summary}`;
  return `${incident?.current.severity ?? "SEV"} · ${service} ${region} · ${incident?.current.summary}`;
}

export default function MaydayApp() {
  const [state, setState] = useState(store.getState());
  const [pending, setPending] = useState<"approve" | ScenarioId | null>(null);
  const [showLedger, setShowLedger] = useState(params.get("ledger") === "1");
  const [now, setNow] = useState(Date.now());
  const sourceRef = useRef<EventSource | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lastEventWall = useRef(Date.now());

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
      if (import.meta.env.DEV) (window as unknown as { __mayday: unknown }).__mayday = { scene: created, store, harborModel };
      scene.render(store.getState());
      unsubscribe = store.subscribe(() => scene?.render(store.getState()));
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

  const send = (message: ClientMsg) => sourceRef.current?.send?.(message) ?? false;
  const incident = state.incident;
  const status = incident?.status ?? null;
  const active = status !== null && !["healthy", "restored", "failed"].includes(status);
  const mood = harborModel(state).mood;
  const elapsedMs = incident?.outageT == null
    ? 0
    : incident.restored
      ? incident.restored.mttr_ms
      : incident.lastT - incident.outageT + (active ? (now - lastEventWall.current) * SPEED : 0);
  const canTrigger = status !== null && !active && pending === null && (SOURCE === "fixture" || state.connected);
  const badge = modeBadge(state);

  return (
    <div className={`mayday mood-${mood}`}>
      <header className="mayday-header">
        <div className="brand">
          <strong>MAYDAY</strong>
          <span>AI Incident Command Center · Abyss Agent Market</span>
        </div>
        <div className={`sev-banner ${active ? "on" : ""}`}>{banner(state)}</div>
        <div className="incident-timer" title="Time since the outage started">
          <small>{status === "restored" ? "MTTR" : "INCIDENT"}</small>
          <b>{formatDuration(elapsedMs)}</b>
        </div>
        <div className="header-actions">
          <button type="button" className={`ghost ${status === "restored" || status === "failed" ? "nudge" : ""}`} disabled={status === null}
            onClick={() => { setPending(null); send({ type: "reset_incident" }); }}>
            Reset
          </button>
          <button type="button" className="ghost" onClick={() => setShowLedger((v) => !v)}>
            {showLedger ? "Hide ledger" : "Ledger"}
          </button>
          <span className={`mode-badge ${badge.tone}`}>{badge.label}</span>
        </div>
      </header>

      <main className="mayday-grid">
        <div className="col left">
          <Inbox state={state} canTrigger={canTrigger} pending={typeof pending === "string" && pending !== "approve" ? pending : null}
            onTrigger={(scenarioId) => { if (send({ type: "start_incident", scenario_id: scenarioId })) setPending(scenarioId); }} />
          <ServiceCard state={state} />
          <CommanderPanel state={state} />
          <Terminal state={state} />
        </div>
        <div className="col center">
          <div className="harbor" ref={stageRef} aria-label="Harbor view of the incident" />
          <Pipeline state={state} />
          <BidCards state={state} />
        </div>
        <div className="col right">
          <SpecialistsPanel state={state} />
          <Repairs state={state} approving={pending === "approve"}
            onApprove={() => { if (send({ type: "approve_repair" })) setPending("approve"); }} />
          <OutcomePanel state={state} elapsedMs={elapsedMs} />
          <RescueTeam state={state} />
          <HistoryPanel history={state.history} />
        </div>
      </main>
      {showLedger && (
        <div className="ledger-drawer">
          <DebugPanel state={state} />
        </div>
      )}
    </div>
  );
}
