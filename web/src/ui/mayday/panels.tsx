import { useEffect, useMemo, useRef, useState } from "react";

import {
  describePlan,
  formatMetric,
  type AgentId,
  type Briefings,
  type ScenarioId,
  type ScenarioInfo,
} from "../../contract";
import { AGENT_ORDER, currentTask } from "../../scene/model";
import type { HistoryEntry, MarketState } from "../../state/reducer";
import { seededDomain } from "./command";
import { formatDuration, outcome, pipeline, terminal, type TerminalLine } from "./derive";

const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const usd = (value: number) => `$${value.toFixed(4)}`;

export function Inbox({
  state,
  canTrigger,
  pending,
  onTrigger,
}: {
  state: MarketState;
  canTrigger: boolean;
  pending: ScenarioId | null;
  onTrigger: (scenarioId: ScenarioId) => void;
}) {
  const scenarios = state.config?.scenarios ?? [];
  const current = state.incident?.current.scenario_id ?? null;
  const status = state.incident?.status ?? null;
  const running = status !== null && !["healthy", "restored", "failed"].includes(status);
  return (
    <section className="panel inbox">
      <header className="panel-head">
        <h2>Incident inbox</h2>
        <span className="muted">{scenarios.length} sources</span>
      </header>
      <p className="muted">Incidents from different systems enter the same command center. One runs at a time.</p>
      <ul className="inbox-list">
        {scenarios.map((scenario) => {
          const live = current === scenario.scenario_id;
          const past = state.history.find((item) => item.scenarioId === scenario.scenario_id);
          const owners = live
            ? state.incident?.assignments?.required_approvers.join(", ")
            : past?.approvedBy.join(", ");
          return (
            <InboxCard
              key={scenario.scenario_id}
              scenario={scenario}
              current={live}
              running={running && live}
              status={live && status !== "healthy" ? status : past?.outcome ?? "waiting"}
              severity={live ? state.incident?.commander?.severity ?? state.incident?.current.severity ?? null : past?.severity ?? null}
              domain={live ? state.incident?.commander?.domain ?? seededDomain(scenario.scenario_id) : past?.domain ?? seededDomain(scenario.scenario_id)}
              owner={owners || "—"}
              disabled={!canTrigger}
              pending={pending === scenario.scenario_id}
              onTrigger={() => onTrigger(scenario.scenario_id)}
            />
          );
        })}
      </ul>
    </section>
  );
}

function InboxCard({
  scenario,
  current,
  running,
  status,
  severity,
  domain,
  owner,
  disabled,
  pending,
  onTrigger,
}: {
  scenario: ScenarioInfo;
  current: boolean;
  running: boolean;
  status: string | null;
  severity: string | null;
  domain: string;
  owner: string;
  disabled: boolean;
  pending: boolean;
  onTrigger: () => void;
}) {
  return (
    <li className={`inbox-card ${current ? "current" : ""} ${running ? "live" : ""}`}>
      <div>
        <b>{scenario.name}</b>
        <span>{severity ?? "—"} · {scenario.service} · {scenario.region.toUpperCase()}</span>
        <span>{domain} · {(status ?? "waiting").replaceAll("_", " ")} · {owner}</span>
        <small>{scenario.alert}</small>
      </div>
      <button type="button" disabled={disabled} onClick={onTrigger} title="Start a new simulation run; previous results stay in history">
        {pending ? "Triggering..." : running ? (status ?? "live").replace("_", " ") : status === "restored" || status === "failed" ? "Run again" : "Trigger"}
      </button>
    </li>
  );
}

export function HistoryPanel({ history }: { history: HistoryEntry[] }) {
  return (
    <section className="panel history">
      <header className="panel-head">
        <h2>This session</h2>
        <span className="muted">{history.length ? `${history.length} closed` : "none yet"}</span>
      </header>
      {history.length === 0 && <p className="muted">Finished incidents stay here until you reload.</p>}
      <ul className="history-list">
        {history.map((item) => (
          <li key={item.jobId} className={item.outcome}>
            <b>{item.outcome === "restored" ? "RESTORED" : "FAILED"}</b>
            <span>{item.name}</span>
            <small>
              {item.severity ?? "—"} · {item.domain ?? "—"} · {usd(item.costUsd)}
              {item.mttrMs != null ? ` · ${formatDuration(item.mttrMs)}` : ""}
            </small>
            <small>{item.crew.map((person) => `${person.name}: ${person.state}`).join("; ")}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ServiceCard({ state }: { state: MarketState }) {
  const incident = state.incident;
  const telemetry = incident?.current.telemetry ?? [];
  const status = incident?.status ?? "healthy";
  const down = !["healthy", "restored"].includes(status);
  return (
    <section className="panel service-card">
      <header className="panel-head">
        <h2>{incident?.current.service ?? "No service"}</h2>
        <span className={`status-pill ${down ? "down" : "up"}`}>
          {incident ? `${incident.current.region.toUpperCase()} · ${down ? "DEGRADED" : "OPERATIONAL"}` : "IDLE"}
        </span>
      </header>
      {!telemetry.length && <p className="muted">Waiting for telemetry...</p>}
      <dl className="metric-grid">
        {telemetry.map((metric) => (
          <div key={metric.key} className={metric.ok ? "good" : "bad"}>
            <dt>{metric.label}</dt>
            <dd>{formatMetric(metric)}</dd>
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

export function CommanderPanel({ state }: { state: MarketState }) {
  const received = state.incident?.received;
  const commander = state.incident?.commander;
  return (
    <section className="panel commander">
      <header className="panel-head">
        <h2>AI Commander</h2>
        <span className="muted">{commander ? commander.source : received ? "classifying" : "idle"}</span>
      </header>
      {!received && <p className="muted">A compressed alert package is classified before any specialist sees the full incident.</p>}
      {received && (
        <p className="package">
          Package ~{received.package_tokens_est} tokens vs ~{received.full_context_tokens_est} for the full context.
          {received.package.breached.length} breached metrics, {received.package.log_excerpt.length} log lines.
        </p>
      )}
      {commander && (
        <dl className="metric-grid">
          <div><dt>Domain</dt><dd>{commander.domain}</dd></div>
          <div><dt>Severity</dt><dd>{commander.severity}</dd></div>
          <div><dt>Secondary</dt><dd>{commander.secondary_domains.join(", ") || "none"}</dd></div>
          <div><dt>Skills</dt><dd>{commander.required_specialties.join(", ")}</dd></div>
        </dl>
      )}
      {commander && <p className="briefing">{commander.rationale}</p>}
      {commander?.fallback_reason && <p className="muted">Fallback: {commander.fallback_reason}</p>}
    </section>
  );
}

export function SpecialistsPanel({ state }: { state: MarketState }) {
  const dispatched = state.incident?.dispatched;
  if (!dispatched) {
    return (
      <section className="panel specialists">
        <header className="panel-head"><h2>Specialist market</h2></header>
        <p className="muted">Only the classified domain receives the full incident prompt.</p>
      </section>
    );
  }
  const sent = dispatched.specialists.filter((item) => item.dispatched);
  const skipped = dispatched.registered - dispatched.eligible;
  return (
    <section className="panel specialists">
      <header className="panel-head">
        <h2>Dispatched specialists</h2>
        <span className="muted">{dispatched.eligible}/{dispatched.registered}</span>
      </header>
      <p className="muted">{dispatched.reason}</p>
      <ul className="specialist-list">
        {sent.map((item) => (
          <li key={item.specialist_id} className="selected">{item.label}</li>
        ))}
        <li className="benched">{skipped} specialists skipped (other domains)</li>
      </ul>
    </section>
  );
}

export function Terminal({ state }: { state: MarketState }) {
  return <LiveEvidence state={state} />;
}

type EvidenceTab = "logs" | "metrics" | "services" | "changes";

function evidenceSeverity(line: TerminalLine): "ERROR" | "WARN" | "OK" | "INFO" | "EVIDENCE" {
  if (line.tone === "error" || line.tone === "fail") return "ERROR";
  if (line.tone === "warn") return "WARN";
  if (line.tone === "pass") return "OK";
  if (line.tone === "agent") return "EVIDENCE";
  return "INFO";
}

function evidenceService(state: MarketState): string {
  return state.incident?.current.service ?? "cluster";
}

function LiveEvidence({ state }: { state: MarketState }) {
  const [tab, setTab] = useState<EvidenceTab>("logs");
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("ALL");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const lines = terminal(state);
  const ref = useRef<HTMLOListElement | null>(null);
  const nearBottom = useRef(true);
  useEffect(() => {
    if (!paused && autoScroll && nearBottom.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length, paused, autoScroll]);
  const incident = state.incident;
  const current = incident?.current;
  const recovery = incident?.restored?.telemetry ?? null;
  const evidenceLines = incident?.received?.package.log_excerpt ?? [];
  const filtered = useMemo(() => lines.map((line, index) => ({
    line,
    index,
    level: evidenceSeverity(line),
    evidence: evidenceLines.some((excerpt) => line.text.includes(excerpt) || excerpt.includes(line.text)),
  })).filter(({ line, level }) =>
    (severity === "ALL" || level === severity)
    && (!query || line.text.toLowerCase().includes(query.toLowerCase())),
  ), [lines, evidenceLines, query, severity]);
  const metrics = current?.telemetry ?? [];
  const changes = current?.config_changes ?? [];
  const dependency = incident?.received?.source_system;
  const deployments = state.log
    .filter((event) => event.job_id === incident?.jobId && event.type === "remediation_plan_created")
    .map((event) => event.type === "remediation_plan_created" ? {
      id: `PLAN-${event.data.task_id}`,
      text: event.data.summary,
      time: formatDuration(event.t),
    } : null)
    .filter((item): item is { id: string; text: string; time: string } => item !== null);
  return (
    <section className="panel live-evidence">
      <header className="panel-head">
        <h2>Live Evidence</h2>
        <span className="evidence-mode">Seeded cluster evidence · Simulation mode</span>
      </header>
      <div className="evidence-tabs" role="tablist" aria-label="Live evidence views">
        {(["logs", "metrics", "services", "changes"] as EvidenceTab[]).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={tab === item}
            className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>
      {tab === "logs" && (
        <>
          <div className="evidence-controls">
            <input aria-label="Search evidence logs" placeholder="Search logs" value={query} onChange={(event) => setQuery(event.target.value)} />
            <select aria-label="Filter log severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
              {["ALL", "ERROR", "WARN", "OK", "INFO", "EVIDENCE"].map((item) => <option key={item}>{item}</option>)}
            </select>
            <button type="button" onClick={() => setPaused((value) => !value)}>{paused ? "Resume" : "Pause"}</button>
            <label><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> Auto-scroll</label>
          </div>
          <p className="evidence-summary">
            {evidenceLines.length} evidence lines used by Captain AI.
            {incident?.commander && ` Classified as ${incident.commander.domain} (${incident.commander.severity}) because ${incident.commander.rationale}`}
          </p>
          <ol ref={ref} className="evidence-log" onScroll={(event) => {
            const element = event.currentTarget;
            nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
          }}>
            {filtered.map(({ line, index, level, evidence }) => (
              <li key={`${index}-${line.t}`} className={`evidence-${level.toLowerCase()} ${evidence ? "evidence-important" : ""}`}>
                <time>{formatDuration(line.t)}</time><b>{level}</b><span>{evidenceService(state)}</span><span>{current?.region.toUpperCase() ?? "—"}</span><code>{line.text}</code>
              </li>
            ))}
          </ol>
        </>
      )}
      {tab === "metrics" && (
        <div className="evidence-grid">
          {metrics.map((metric) => {
            const after = recovery?.find((item) => item.key === metric.key);
            return <div key={metric.key} className={metric.ok ? "metric-good" : "metric-bad"}><b>{metric.label}</b><span>Before {formatMetric(metric)}</span><span>After {after ? formatMetric(after) : "—"}</span></div>;
          })}
        </div>
      )}
      {tab === "services" && (
        <ul className="evidence-services">
          <li><i className={incident?.status === "restored" ? "health-green" : incident ? "health-red" : "health-yellow"} /> <b>{current?.service ?? "No active service"}</b><span>{current?.region.toUpperCase() ?? "—"} · {incident?.status ?? "standby"}</span><small>Dependency: {dependency ?? "No incident package received"}</small></li>
        </ul>
      )}
      {tab === "changes" && (
        <ul className="evidence-changes">
          {deployments.map((deployment) => <li key={deployment.id}><b>{deployment.id}</b><span>Deployment plan: {deployment.text}</span><small>{deployment.time} · Captain AI repair plan</small></li>)}
          {changes.map((change) => <li key={change.change_id} className={incident?.received?.package.recent_changes.some((item) => item.change_id === change.change_id) ? "correlated" : ""}><b>{change.change_id}</b><span>{change.key}: {change.old} → {change.new}</span><small>{change.minutes_ago} min ago · {change.author}</small></li>)}
          {!changes.length && <li className="muted">No configuration changes in this incident package.</li>}
        </ul>
      )}
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
  const labels = Object.fromEntries(
    (state.incident?.dispatched?.specialists ?? [])
      .filter((item) => item.dispatched)
      .map((item) => [item.agent_id, item.label]),
  );
  if (!task) {
    return (
      <section className="panel bids empty">
        <p className="muted">Specialists bid here after the Commander picks a domain.</p>
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
                <strong style={{ color: agent?.color }}>{labels[agentId] ?? agent?.display_name ?? agentId}</strong>
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

export function Repairs({ state }: { state: MarketState }) {
  const incident = state.incident;
  const repairs = incident?.repairs ?? [];
  const awaiting = incident?.status === "awaiting_approval" && incident.approval;
  const assignments = incident?.assignments;
  const granted = new Set(incident?.granted?.approved ?? []);
  return (
    <section className={`panel repairs ${awaiting ? "attention" : ""}`}>
      <header className="panel-head">
        <h2>Repairs &amp; assignments</h2>
        <span className="muted">allowlisted plans only</span>
      </header>
      {repairs.length === 0 && <p className="muted">No repair proposed yet.</p>}
      <ol className="repair-list">
        {repairs.map((repair) => {
          const verdict = !repair.sandbox ? "testing" : repair.sandbox.passed ? "passed" : "rejected";
          const passedChecks = repair.sandbox?.checks.filter((c) => c.passed).length ?? 0;
          return (
            <li key={repair.proposal.task_id} className={`repair-${verdict}`}>
              <b>#{repair.proposal.attempt} {repair.proposal.agent_id.toUpperCase()}</b>
              <code>{repair.proposal.steps.length ? describePlan(repair.proposal.steps) : "invalid plan"}</code>
              <span>{verdict.toUpperCase()}{repair.sandbox ? ` ${passedChecks}/${repair.sandbox.checks.length}` : ""}</span>
            </li>
          );
        })}
      </ol>
      {assignments && (
        <ul className="assignment-list">
          {assignments.assignments.map((item) => {
            const done = item.approval_required ? granted.has(item.assignment_id) || Boolean(incident?.granted) : true;
            return (
              <li key={item.assignment_id} className={done ? "done" : item.approval_required ? "needed" : "notify"}>
                <b>{item.name}</b>
                <span>{item.description}</span>
                <small>
                  {item.approval_required ? (done ? "approved" : "approval required") : "notify"} · {item.reason}
                </small>
              </li>
            );
          })}
        </ul>
      )}
      {awaiting && incident.approval && (
        <div className="approve-box">
          <p>{incident.approval.summary}</p>
          <p className="muted">Required: {incident.approval.approvers.join(", ")}</p>
          <p className="muted">Use Approve repair, Request revision, or Reject repair in the decision panel.</p>
        </div>
      )}
    </section>
  );
}

export function OutcomePanel({ state, elapsedMs, costLabel = "Simulated cost" }: { state: MarketState; elapsedMs: number; costLabel?: string }) {
  const result = outcome(state);
  const restored = state.incident?.restored ?? null;
  const routing = result.routing;
  return (
    <section className={`panel outcome ${restored ? "resolved" : ""}`}>
      <header className="panel-head">
        <h2>{restored ? "Incident resolved" : "Incident metrics"}</h2>
      </header>
      {restored && <p className="outcome-applied">Applied to simulated cluster</p>}
      <dl className="metric-grid">
        <div><dt>{restored ? "MTTR" : "Elapsed"}</dt><dd>{formatDuration(restored ? restored.mttr_ms : elapsedMs)}</dd></div>
        <div><dt>{costLabel}</dt><dd>{usd(restored?.total_cost_usd ?? result.aiCost)}</dd></div>
        <div><dt>Repair attempts</dt><dd>{result.attempts}{result.failedAttempts ? ` (${result.failedAttempts} rejected)` : ""}</dd></div>
        <div><dt>Repair confidence</dt><dd>{result.confidence === null ? "—" : pct(result.confidence, 0)}</dd></div>
        <div><dt>Mean grade</dt><dd>{result.meanGrade === null ? "—" : `${result.meanGrade.toFixed(1)}/10`}</dd></div>
        <div><dt>Approved by</dt><dd>{restored?.approved_by.join(", ") ?? "—"}</dd></div>
      </dl>
      {routing && (
        <dl className="metric-grid routing">
          <div><dt>Models contacted</dt><dd>{routing.models_contacted}</dd></div>
          <div><dt>Models skipped</dt><dd>{routing.models_skipped}</dd></div>
          <div><dt>Actual tokens in/out</dt><dd>{routing.actual_input_tokens}/{routing.actual_output_tokens}</dd></div>
          <div><dt>Est. tokens avoided</dt><dd>{routing.avoided_input_tokens_est}</dd></div>
          <div><dt>Estimated savings</dt><dd>{usd(routing.avoided_cost_usd_est)}</dd></div>
          <div><dt>Actual calls</dt><dd>{routing.actual_calls}</dd></div>
        </dl>
      )}
      {routing && <p className="muted estimate">{routing.method}</p>}
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
                <b>{change.agent_id}</b> {change.rep_key} {change.old.toFixed(2)} → {change.new.toFixed(2)}
                <span>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(2)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
