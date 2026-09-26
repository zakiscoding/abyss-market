import { useEffect, useRef, useState } from "react";

import { describeAction, type AgentId, type Briefings, type Telemetry } from "../../contract";
import { AGENT_ORDER, currentTask } from "../../scene/model";
import type { MarketState } from "../../state/reducer";
import { formatDuration, outcome, pipeline, terminal } from "./derive";

const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const usd = (value: number) => `$${value.toFixed(4)}`;

export function ServiceCard({ state }: { state: MarketState }) {
  const incident = state.incident;
  const t: Telemetry | undefined = incident?.current.telemetry;
  const status = incident?.status ?? "healthy";
  const down = !["healthy", "restored"].includes(status);
  const rows: [string, string, boolean][] = t
    ? [
        ["Error rate", pct(t.error_rate), t.error_rate > 0.01],
        ["p95 latency", `${t.p95_latency_ms} ms`, t.p95_latency_ms > 300],
        ["Payment success", pct(t.payment_success_rate), t.payment_success_rate < 0.99],
        ["Failed payments", `${t.failed_payments_per_min}/min`, t.error_rate > 0.01],
        ["DB timeouts", `${t.timeouts_per_min}/min`, t.timeouts_per_min > 0],
        ["DB pool", `${t.db_connections_in_use}/${t.db_pool_size}`, t.timeouts_per_min > 0],
      ]
    : [];
  return (
    <section className="panel service-card">
      <header className="panel-head">
        <h2>Payments API</h2>
        <span className={`status-pill ${down ? "down" : "up"}`}>{down ? "DEGRADED" : "OPERATIONAL"}</span>
      </header>
      {!t && <p className="muted">Waiting for telemetry...</p>}
      <dl className="metric-grid">
        {rows.map(([name, value, bad]) => (
          <div key={name} className={bad ? "bad" : "good"}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {incident && incident.current.config_changes.length > 0 && (
        <div className="config-change">
          {incident.current.config_changes.map((change) => (
            <div key={change.change_id}>
              <b>{change.change_id}</b> {change.key} {change.old} → {change.new} <em>by {change.author}</em>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function Terminal({ state }: { state: MarketState }) {
  const lines = terminal(state);
  const ref = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <section className="panel terminal">
      <header className="panel-head">
        <h2>Investigation terminal</h2>
        <span className="muted">{lines.length} lines</span>
      </header>
      <ol ref={ref}>
        {lines.map((line, i) => (
          <li key={i} className={`tone-${line.tone}`}>
            <span>{formatDuration(line.t)}</span>
            <code>{line.text}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Pipeline({ state }: { state: MarketState }) {
  return (
    <ol className="pipeline">
      {pipeline(state).map((stage) => (
        <li key={stage.key} className={`stage-${stage.state}`}>
          <b>{stage.label}</b>
          <small>{stage.detail || stage.state}</small>
        </li>
      ))}
    </ol>
  );
}

export function BidCards({ state }: { state: MarketState }) {
  const task = state.incident && state.incident.status !== "healthy" ? currentTask(state) : null;
  if (!task) {
    return (
      <section className="panel bids empty">
        <p className="muted">AI responders bid here once an incident is declared.</p>
      </section>
    );
  }
  return (
    <section className="panel bids">
      <header className="panel-head">
        <h2>{task.task_id.toUpperCase()} · {task.type} · {task.title}</h2>
        <span className="muted">score = quality × reputation − price</span>
      </header>
      <div className="bid-row">
        {AGENT_ORDER.map((agentId: AgentId) => {
          const bid = task.bids[agentId];
          const agent = state.agents[agentId];
          const won = task.winner === agentId && task.status !== "open";
          return (
            <article key={agentId} className={`bid-card ${won ? "won" : ""}`} style={{ borderColor: agent?.color }}>
              <header>
                <strong style={{ color: agent?.color }}>{agent?.display_name ?? agentId}</strong>
                {won && <span className="won-badge">WON</span>}
              </header>
              {!bid && <p className="muted">thinking...</p>}
              {bid && !bid.ok && <p className="bad-text">no bid: {bid.error}</p>}
              {bid && bid.ok && (
                <>
                  <dl>
                    <div><dt>Cost</dt><dd>{usd(bid.predicted_cost_usd ?? 0)}</dd></div>
                    <div><dt>Quality</dt><dd>{bid.promised_quality}/10</dd></div>
                    <div><dt>Confidence</dt><dd>{pct(bid.confidence ?? 0, 0)}</dd></div>
                    <div><dt>ETA</dt><dd>{((bid.eta_ms ?? 0) / 1000).toFixed(1)}s</dd></div>
                    <div><dt>Reputation</dt><dd>{bid.reputation?.toFixed(2)}</dd></div>
                    <div><dt>Score</dt><dd>{bid.score?.toFixed(2)}</dd></div>
                  </dl>
                  <p className="pitch">“{bid.pitch}”</p>
                </>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

const AUDIENCES: { key: keyof Briefings; label: string }[] = [
  { key: "engineering", label: "Engineers" },
  { key: "support", label: "Support" },
  { key: "commander", label: "Commander" },
  { key: "leadership", label: "Leadership" },
];

export function RescueTeam({ state }: { state: MarketState }) {
  const [audience, setAudience] = useState<keyof Briefings>("engineering");
  const data = state.incident?.responders;
  return (
    <section className="panel rescue">
      <header className="panel-head">
        <h2>Human rescue team</h2>
        {data && <span className="muted">{data.responders.filter((r) => r.selected).length} paged</span>}
      </header>
      {!data && <p className="muted">Responders are paged by skill match, availability, severity and workload.</p>}
      {data && (
        <>
          <ul className="responders">
            {data.responders.map((person) => (
              <li key={person.responder_id} className={person.selected ? "selected" : "benched"} title={person.reason}>
                <b>{person.selected ? "●" : "○"} {person.name}</b>
                <span>{person.role}</span>
                <small>{person.reason}</small>
              </li>
            ))}
          </ul>
          <div className="tabs" role="tablist">
            {AUDIENCES.map(({ key, label }) => (
              <button key={key} type="button" role="tab" aria-selected={audience === key}
                className={audience === key ? "active" : ""} onClick={() => setAudience(key)}>
                {label}
              </button>
            ))}
          </div>
          <p className="briefing">{data.briefings[audience]}</p>
        </>
      )}
    </section>
  );
}

export function Repairs({ state, onApprove, approving }: { state: MarketState; onApprove: () => void; approving: boolean }) {
  const incident = state.incident;
  const repairs = incident?.repairs ?? [];
  const awaiting = incident?.status === "awaiting_approval" && incident.approval;
  return (
    <section className={`panel repairs ${awaiting ? "attention" : ""}`}>
      <header className="panel-head">
        <h2>Repairs &amp; sandbox</h2>
        <span className="muted">allowlist: pool size · restart · rollback</span>
      </header>
      {repairs.length === 0 && <p className="muted">No repair proposed yet.</p>}
      <ol className="repair-list">
        {repairs.map((repair) => {
          const verdict = !repair.sandbox ? "testing" : repair.sandbox.passed ? "passed" : "rejected";
          const passedChecks = repair.sandbox?.checks.filter((c) => c.passed).length ?? 0;
          return (
            <li key={repair.proposal.task_id} className={`repair-${verdict}`}>
              <b>#{repair.proposal.attempt} {repair.proposal.agent_id.toUpperCase()}</b>
              <code>{repair.proposal.action ? describeAction(repair.proposal.action) : "invalid action"}</code>
              <span>{verdict.toUpperCase()}{repair.sandbox ? ` ${passedChecks}/${repair.sandbox.checks.length}` : ""}</span>
            </li>
          );
        })}
      </ol>
      {awaiting && incident.approval && (
        <div className="approve-box">
          <p>{incident.approval.summary}</p>
          <p className="muted">Approvers: {incident.approval.approvers.join(", ")}</p>
          <button type="button" className="approve-button" disabled={approving} onClick={onApprove}>
            {approving ? "Deploying..." : "Approve Repair"}
          </button>
        </div>
      )}
    </section>
  );
}

export function OutcomePanel({ state, elapsedMs }: { state: MarketState; elapsedMs: number }) {
  const result = outcome(state);
  const restored = state.incident?.restored ?? null;
  return (
    <section className={`panel outcome ${restored ? "resolved" : ""}`}>
      <header className="panel-head">
        <h2>{restored ? "Incident resolved" : "Incident metrics"}</h2>
      </header>
      <dl className="metric-grid">
        <div><dt>{restored ? "MTTR" : "Elapsed"}</dt><dd>{formatDuration(restored ? restored.mttr_ms : elapsedMs)}</dd></div>
        <div><dt>Total AI cost</dt><dd>{usd(restored?.total_cost_usd ?? result.aiCost)}</dd></div>
        <div><dt>Repair attempts</dt><dd>{result.attempts}{result.failedAttempts ? ` (${result.failedAttempts} rejected)` : ""}</dd></div>
        <div><dt>Repair confidence</dt><dd>{result.confidence === null ? "—" : pct(result.confidence, 0)}</dd></div>
        <div><dt>Mean grade</dt><dd>{result.meanGrade === null ? "—" : `${result.meanGrade.toFixed(1)}/10`}</dd></div>
        <div><dt>Approved by</dt><dd>{restored?.approved_by ?? "—"}</dd></div>
      </dl>
      {result.verification.length > 0 && (
        <ul className="checks">
          {result.verification.map((check) => (
            <li key={check.name} className={check.passed ? "pass" : "fail"}>
              {check.passed ? "✓" : "✗"} {check.name} <em>{check.detail}</em>
            </li>
          ))}
        </ul>
      )}
      {result.repChanges.length > 0 && (
        <ul className="rep-changes">
          {result.repChanges.map((change, i) => {
            const delta = change.new - change.old;
            return (
              <li key={i} className={delta >= 0 ? "up" : "down"}>
                <b>{change.agent_id}</b> {change.task_type} {change.old.toFixed(2)} → {change.new.toFixed(2)}
                <span>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(2)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
