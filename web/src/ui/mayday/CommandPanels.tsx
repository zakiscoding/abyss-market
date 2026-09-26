import { describePlan, formatMetric, type Region } from "../../contract";
import type { MarketState } from "../../state/reducer";
import { currentTask } from "../../scene/model";
import { validationReadout } from "./harborView";
import {
  PERSONAS,
  canApprove,
  canReject,
  canRevise,
  captainReadout,
  crewState,
  dockWorker,
  escalationCost,
  incidentChat,
  planHash,
  repairAttempts,
  selectionFor,
  type Persona,
} from "./command";

const usd = (value: number) => `$${value.toFixed(4)}`;

const REGIONS: { id: Region; label: string }[] = [
  { id: "ams", label: "Amsterdam" },
  { id: "sin", label: "APAC" },
  { id: "iad", label: "US-East" },
];

export function CaptainPanel({ state }: { state: MarketState }) {
  const captain = captainReadout(state);
  const worker = dockWorker(state);
  return (
    <section className="panel captain-panel">
      <header className="panel-head">
        <h2>Captain AI</h2>
        <span className="badge ai">AI COMMANDER</span>
      </header>
      <p>{captain.text}</p>
      {state.incident?.commander && <p className="muted">Evidence: {state.incident.commander.rationale}</p>}
      {worker.worker && (
        <p className="worker-line">
          <b>{worker.title}</b>
          <span><span className="badge worker">AI WORKER</span> {worker.worker}</span>
          <small>{worker.reason}</small>
        </p>
      )}
      <p className="captain-validation">{validationReadout(state)}</p>
    </section>
  );
}

export function ModelMarket({ state }: { state: MarketState }) {
  const { models, ranking, selected } = selectionFor(state);
  const winner = currentTask(state)?.winner;
  const chosen = models.find((model) => model.agentId === winner);
  const rows = ranking.length ? ranking : models.map((model) => ({ model, estimatedUsd: 0, qualified: false, reason: "Waiting for Captain AI classification" }));
  const eligible = rows.filter((row) => row.qualified);
  const eliminated = rows.length - eligible.length;
  return (
    <section className="panel model-market">
      <header className="panel-head">
        <h2>Model market</h2>
        <span className="muted">{ranking.length ? `${eligible.length} eligible · ${eliminated} eliminated` : `${models.length} registered`}</span>
      </header>
      {chosen ? <p className="model-choice"><b>Auction winner:</b> {chosen.displayName}</p> : selected && <p className="model-choice"><b>Estimated best fit:</b> {selected.model.displayName}. Waiting for the auction result.</p>}
      <ul className="model-list">
        {rows.map((row) => (
          <li key={row.model.id} className={chosen?.id === row.model.id ? "picked" : row.qualified ? "qualified" : ""}>
            <div className="model-row-head">
              <b>{row.model.displayName}</b>
              <span className={`avail avail-${row.model.availability}`}>{chosen?.id === row.model.id ? "selected" : !ranking.length ? row.model.availability : row.qualified ? "eligible" : "rejected"}</span>
            </div>
            <small>Price {usd(row.estimatedUsd)} · Reliability {(row.model.validationRate * 100).toFixed(0)}%</small>
            <small>{row.model.provider} · {row.model.modelId}</small>
            <small>{row.reason}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EscalationPanel({ state }: { state: MarketState }) {
  const attempts = repairAttempts(state);
  const cost = escalationCost(attempts);
  if (!attempts.length) return null;
  return (
    <section className="panel escalation">
      <header className="panel-head">
        <h2>Validation</h2>
        <span className="muted">{attempts.filter((row) => !row.passed).length} failed</span>
      </header>
      <ol className="attempt-list">
        {attempts.map((row, index) => (
          <li key={`${row.agentId}-${index}`} className={row.passed ? "pass" : "fail"}>
            <b>{row.worker}</b>
            <code>{row.plan}</code>
            <span>{row.passed ? "Sandbox passed" : "Sandbox failed"} · {usd(row.costUsd)}</span>
          </li>
        ))}
      </ol>
      {attempts.length > 1 && (
        <p className="muted">
          Initial attempt {usd(cost.initial)}. Extra cost after escalation {usd(cost.extra)}. Final attempt cost {usd(cost.final)}.
        </p>
      )}
    </section>
  );
}

export function CrewPanel({ state, revision }: { state: MarketState; revision: boolean }) {
  const people = state.incident?.responders?.responders.filter((person) => person.selected) ?? [];
  const status = state.incident?.status ?? "healthy";
  const approvers = new Set(state.incident?.approval?.approvers ?? []);
  return (
    <section className="panel crew-panel">
      <header className="panel-head">
        <h2>Human crew</h2>
        <span className="badge human">HUMAN</span>
      </header>
      {people.length === 0 && <p className="muted">No one is paged yet.</p>}
      {people.length > 0 && <p className="crew-summary">Crew alerted · {people.map((person) => person.name).join(", ")}</p>}
      <ul className="crew-list">
        {people.map((person) => {
          const needs = approvers.has(person.name);
          const phase = status === "restored"
            ? (state.incident?.granted?.approved_by.includes(person.name) ? "approved · complete" : "incident resolved")
            : crewState(status, needs, revision);
          return (
            <li key={person.responder_id}>
              <b>{person.name}</b>
              <span>{person.role}</span>
              <small className={`crew-${phase.replace(" ", "-")}`}>{phase}</small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ChatPanel({
  state,
  note,
}: {
  state: MarketState;
  note: { kind: "revision" | "reject"; persona: string } | null;
}) {
  const lines = incidentChat(state, note);
  return (
    <section className="panel chat-panel">
      <header className="panel-head">
        <h2>Incident chat</h2>
      </header>
      {lines.length === 0 && <p className="muted">Chat lines appear from the incident events.</p>}
      <ol className="chat-list">
        {lines.map((line) => (
          <li key={line.id}>
            <b>{line.who}</b>
            <span className={`badge ${line.badge === "HUMAN" ? "human" : line.badge === "AI WORKER" ? "worker" : "ai"}`}>{line.badge}</span>
            <p>{line.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DecisionPanel({
  state,
  persona,
  approving,
  blocked,
  onApprove,
  onRevise,
  onReject,
  onResume,
}: {
  state: MarketState;
  persona: Persona;
  approving: boolean;
  blocked: "approved" | "rejected" | "review" | null;
  onApprove: () => void;
  onRevise: () => void;
  onReject: () => void;
  onResume: () => void;
}) {
  const approval = state.incident?.approval;
  const severity = state.incident?.commander?.severity ?? null;
  const worker = dockWorker(state);
  const plan = approval ? describePlan(approval.steps) : "";
  const hash = plan ? planHash(plan) : null;
  const awaiting = state.incident?.status === "awaiting_approval" && approval;
  const allowApprove = Boolean(awaiting) && canApprove(persona, severity) && blocked === null && !approving;
  const allowRevise = Boolean(awaiting) && canRevise(persona) && blocked !== "approved";
  const allowReject = Boolean(awaiting) && canReject(persona) && blocked !== "approved";
  const restored = state.incident?.restored;
  if (state.incident?.status === "restored" && restored) return (
    <section className="panel decision-panel">
      <header className="panel-head"><h2>Completed approval receipt</h2><span className="badge human">HUMAN</span></header>
      <div className="approval-receipt">
        <strong>Applied to simulated cluster</strong>
        <span>Approved by {restored.approved_by.join(", ")}</span>
        <span>Plan applied once</span>
        <code>{describePlan(restored.steps)}</code>
        <strong>Deterministic recovery checks {restored.verification.every((check) => check.passed) ? "passed" : "need attention"}</strong>
        <ul>{restored.verification.map((check) => <li key={check.name}>{check.passed ? "✓" : "×"} {check.name}</li>)}</ul>
      </div>
    </section>
  );
  return (
    <section className="panel decision-panel">
      <header className="panel-head">
        <h2>Human approval</h2>
        {hash && <span className="muted">plan {hash}</span>}
      </header>
      {approval && (
        <>
          <p>Review the sandbox-validated plan before applying it to the simulated cluster.</p>
          <p><b>Plan.</b> {plan}</p>
          <p><b>Worker.</b> {worker.worker ?? "—"}</p>
          <p className="muted">{worker.reason}</p>
          <p className="muted">Approvers: {approval.approvers.join(", ")}</p>
        </>
      )}
      {!awaiting && <p className="muted">{state.incident?.status === "restored"
        ? "Repair completed and recovery verified."
        : state.incident?.status === "recovering"
          ? "Approval recorded. Recovery verification is in progress."
          : state.incident?.status === "failed"
            ? "The incident has been escalated to the crew."
            : state.incident?.repairs.at(-1)?.sandbox?.passed
              ? "Sandbox passed. Preparing the approval checklist."
              : "Approval opens after the sandbox passes."}</p>}
      {blocked === "rejected" && <p>You declined this plan in this session. Simulated application remains paused.</p>}
      {blocked === "review" && <p>Plan held for review in this session. Resume when you are ready to decide.</p>}
      {blocked === "approved" && <p>This plan version was approved once.</p>}
      {state.incident?.status === "restored" ? (
        <div className="approval-complete">
          <strong>Approved by {approval?.approvers.join(" and ") ?? "the human crew"}</strong>
          <span>Plan applied once</span>
          <span>Recovery verified</span>
        </div>
      ) : (
        <div className="decision-actions">
          <button type="button" className="approve-button" disabled={!allowApprove} onClick={onApprove}>
            {approving ? "Applying..." : "Approve repair"}
          </button>
          <button type="button" className="ghost" disabled={!allowRevise} onClick={onRevise}>Request revision</button>
          <button type="button" className="ghost" disabled={!allowReject} onClick={onReject}>Reject repair</button>
          {awaiting && (blocked === "review" || blocked === "rejected") && (canRevise(persona) || canReject(persona)) && <button type="button" className="ghost" onClick={onResume}>Resume review</button>}
        </div>
      )}
      {awaiting && !canApprove(persona, severity) && (
        <p className="muted">This demo persona cannot give the final {severity ?? ""} authorization.</p>
      )}
    </section>
  );
}

export function ClusterPanel({ state }: { state: MarketState }) {
  const current = state.incident?.current;
  const region = current?.region;
  const telemetry = current?.telemetry ?? [];
  const changes = current?.config_changes ?? [];
  const logs = current?.logs ?? [];
  return (
    <section className="panel cluster-panel">
      <header className="panel-head">
        <h2>Cluster</h2>
        <span className="muted">seeded evidence</span>
      </header>
      <ul className="region-list">
        {REGIONS.map((item) => (
          <li key={item.id} className={item.id === region ? "here" : ""}>
            <b>{item.label}</b>
            <span>{item.id === region ? "in this package" : "not in this package"}</span>
          </li>
        ))}
      </ul>
      <ul className="metric-pills">
        {telemetry.map((metric) => (
          <li key={metric.key} className={metric.ok ? "ok" : "bad"}>
            {metric.label} {formatMetric(metric)}
          </li>
        ))}
      </ul>
      {changes.length > 0 && (
        <ul className="change-list">
          {changes.map((change) => (
            <li key={change.change_id}>{change.key}: {change.old} → {change.new}</li>
          ))}
        </ul>
      )}
      <ol className="log-list">
        {logs.slice(-6).map((line, index) => (
          <li key={index} className={/error|fail|timeout|lag|unreach/i.test(line) ? "bad" : ""}>{line}</li>
        ))}
      </ol>
    </section>
  );
}

export function PersonaSelect({ persona, onChange }: { persona: Persona; onChange: (persona: Persona) => void }) {
  return (
    <label className="persona">
      Demo persona
      <select value={persona} onChange={(event) => onChange(event.target.value as Persona)} aria-label="Demo persona">
        {PERSONAS.map((item) => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
    </label>
  );
}
