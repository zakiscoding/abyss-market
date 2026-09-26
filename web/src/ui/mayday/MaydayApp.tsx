import { useEffect, useRef, useState, type ReactNode } from "react";

import { describePlan, type ClientMsg, type ScenarioId } from "../../contract";
import { harborModel } from "../../scene/harbor/model";
import { FixtureSource } from "../../sources/fixture";
import type { EventSource } from "../../sources/types";
import { WsSource } from "../../sources/ws";
import type { MarketState } from "../../state/reducer";
import { incidentElapsed } from "../../state/incident";
import { store } from "../../state/store";
import { DebugPanel } from "../DebugPanel";
import {
  CaptainPanel,
  CrewPanel,
  DecisionPanel,
  EscalationPanel,
  ModelMarket,
  PersonaSelect,
} from "./CommandPanels";
import { captainReadout, canApprove, planHash, type Persona } from "./command";
import { outcome } from "./derive";
import {
  HistoryPanel,
  Inbox,
  OutcomePanel,
  Repairs,
  Terminal,
} from "./panels";
import { IncidentTimer } from "./IncidentTimer";
import { seasidePicture } from "./seaside";
import { SeasideScene } from "./SeasideScene";
import { WorkspaceTabs, type WorkspaceTab } from "./WorkspaceTabs";

const params = new URLSearchParams(window.location.search);
const SOURCE = params.get("source") === "fixture" || params.get("source") === "replay" ? "fixture" : "ws";
const WS_URL = import.meta.env.VITE_WS_URL
  || (import.meta.env.PROD
    ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`
    : "ws://127.0.0.1:8000/ws");
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
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(params.get("ledger") === "1" ? "ledger" : "inbox");
  const [persona, setPersona] = useState<Persona>("commander");
  const [note, setNote] = useState<{ key: string; kind: "revision" | "reject" } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<{ title: string; message: string; tab: WorkspaceTab } | null>(null);
  const approvedKey = useRef<string | null>(null);
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
      if (event.type === "incident_received") {
        approvedKey.current = null;
        setNote(null);
      }
      if (event.type === "error") {
        approvedKey.current = null;
        setNotice({ title: "Something needs attention", message: event.data.message, tab: "evidence" });
      }
      if (event.type === "incident_received") setNotice({ title: "New incident received", message: event.data.alert, tab: "evidence" });
      if (event.type === "approval_required") {
        setActiveTab("crew");
        setNotice({ title: "Your approval is needed", message: "Review the validated plan before applying it to the simulated cluster.", tab: "crew" });
      }
      if (event.type === "service_restored") { setActiveTab("evidence"); setNotice({ title: "Service restored", message: "Applied to simulated cluster. View the recovery checks in Evidence.", tab: "evidence" }); }
      if (event.type === "incident_escalated") setNotice({ title: "Incident needs attention", message: event.data.reason, tab: "crew" });
      if (event.type === "incident_status" && event.data.status === "healthy") setNotice(null);
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
  const hasIncident = Boolean(incident?.received) || (status !== null && status !== "healthy");
  const active = status !== null && !["healthy", "restored", "failed"].includes(status);
  const mood = harborModel(state).mood;
  const picture = seasidePicture(state);
  const elapsedMs = incidentElapsed(incident, (now - lastEventWall.current) * SPEED);
  const canTrigger = status !== null && !active && !state.jobActive && pending === null && (SOURCE === "fixture" || state.connected);
  const badge = modeBadge(state);
  const cost = incident?.restored?.total_cost_usd ?? outcome(state).aiCost;
  const costLabel = state.config && !state.config.fake_llm && SOURCE === "ws" ? "Actual AI cost" : "Simulated cost";
  const planText = incident?.approval ? describePlan(incident.approval.steps) : "";
  const planKey = incident?.approval ? `${incident.jobId}-${incident.approval.task_id}-${incident.approval.attempt}-${planHash(planText)}` : null;
  const blocked = planKey && approvedKey.current === planKey ? "approved" : note?.key === planKey ? (note.kind === "reject" ? "rejected" : "review") : null;
  const approve = () => {
    if (status !== "awaiting_approval" || !planKey || approvedKey.current === planKey || pending === "approve") return;
    if (!canApprove(persona, incident?.commander?.severity ?? null)) return;
    if (note?.key === planKey) return;
    if (send({ type: "approve_repair" })) {
      approvedKey.current = planKey;
      setPending("approve");
    }
  };

  return (
    <div className={`mayday mood-${mood}`}>
      <header className="mayday-header">
        <div className="brand">
          <strong>ABYSS</strong>
          <span>Incident command</span>
        </div>
        {hasIncident && <div className="header-facts" aria-label="Incident summary">
          <b className={active ? "sev" : picture.boat === "restored" ? "ok" : ""}>{status === "restored" ? "RESTORED" : picture.severity ?? "STANDBY"}</b>
          <span>{picture.service}</span>
          <span>{picture.region || "—"}</span>
          <span className="cost" title={costLabel}>{costLabel}: ${cost.toFixed(4)}</span>
        </div>}
        <IncidentTimer incident={incident} sinceLastEventMs={(now - lastEventWall.current) * SPEED} />
        <div className="header-actions">
          <PersonaSelect persona={persona} onChange={setPersona} />
          <button type="button" className={`ghost ${status === "restored" || status === "failed" ? "nudge" : ""}`} disabled={SOURCE === "ws" && !state.connected}
            onClick={() => { setPending(null); setNote(null); approvedKey.current = null; send({ type: "reset_incident" }); setActiveTab("inbox"); }}>
            Reset
          </button>
          <span className={`mode-badge ${badge.tone}`}>{badge.label}</span>
        </div>
      </header>

      <main className="command-layout">
      <div className="harbor-wrap">
        <div className="harbor-notices" aria-live="polite" aria-atomic="true">
          {notice ? <div className={`harbor-notice ${notice.title === "Service restored" ? "success" : ""}`}>
            <div><strong>{notice.title}</strong><p>{notice.message}</p></div>
            <button type="button" onClick={() => {
              setActiveTab(notice.tab);
              requestAnimationFrame(() => document.getElementById(`panel-${notice.tab}`)?.focus());
              setNotice(null);
            }}>View details</button>
            <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>Dismiss</button>
          </div> : !hasIncident && <div className="harbor-notice quiet">
            <div><strong>{SOURCE === "ws" && !state.connected ? "Connecting to incident feed" : "No active alerts"}</strong><p>{SOURCE === "ws" && !state.connected ? "Waiting for the server connection." : "The harbor is on standby. Explore a stall or trigger an incident from the inbox."}</p></div>
            <button type="button" onClick={() => {
              setActiveTab("inbox");
              requestAnimationFrame(() => document.getElementById("panel-inbox")?.focus());
            }}>Open inbox</button>
          </div>}
        </div>
        <SeasideScene state={state} onCaptain={() => {
          setActiveTab("crew");
          requestAnimationFrame(() => document.getElementById("panel-crew")?.focus());
        }} />

      <div className="harbor-caption"><span>CAPTAIN READOUT</span><p>{captainReadout(state, costLabel).text}</p>
        {status === "awaiting_approval" && <button type="button" onClick={() => { setActiveTab("crew"); requestAnimationFrame(() => document.getElementById("panel-crew")?.focus()); }}>Review repair</button>}
      </div>
      </div>
      <WorkspaceTabs active={activeTab} onChange={setActiveTab} attention={status === "awaiting_approval"}>
        {{ inbox: <>

          <Inbox
            state={state}
            canTrigger={canTrigger}
            pending={typeof pending === "string" && pending !== "approve" ? pending : null}
            onTrigger={(scenarioId) => { if (canTrigger && send({ type: "start_incident", scenario_id: scenarioId })) setPending(scenarioId); }}
          />
          <HistoryPanel history={state.history} />
        </>,
        crew: <>
          <CaptainPanel state={state} costLabel={costLabel} />
          <DecisionPanel
            state={state}
            persona={persona}
            approving={pending === "approve"}
            blocked={blocked}
            onApprove={approve}
            onResume={() => setNote(null)}
            onRevise={() => { if (planKey) setNote({ key: planKey, kind: "revision" }); }}
            onReject={() => { if (planKey) setNote({ key: planKey, kind: "reject" }); }}
          />
          <CrewPanel state={state} revision={note?.kind === "revision" && note.key === planKey} />
          <ModelMarket state={state} />
          <Fold title="Assignments">
            <Repairs state={state} />
          </Fold>
        </>,
        evidence: <>
          <OutcomePanel state={state} elapsedMs={elapsedMs} costLabel={costLabel} />
          <Terminal state={state} />
          <ModelMarket state={state} />
          <EscalationPanel state={state} />
        </>,
        ledger: <DebugPanel state={state} /> }}
      </WorkspaceTabs>
      </main>
    </div>
  );
}
