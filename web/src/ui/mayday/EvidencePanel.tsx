import { useEffect, useRef, useState } from "react";
import { describePlan, formatMetric } from "../../contract";
import type { MarketState } from "../../state/reducer";
import { formatDuration, terminal, type TerminalLine } from "./derive";
import "./side-panels.css";

export function evidenceData(state: MarketState) {
  const incident = state.incident;
  if (!incident?.received || incident.status === "healthy") return null;
  const events = state.log.filter((event) => event.job_id === incident.jobId);
  const outage = events.find((event) => event.type === "incident_status" && event.data.status === "outage");
  return {
    incident, lines: terminal(state),
    before: outage?.type === "incident_status" ? outage.data.telemetry : incident.received.package.breached,
    after: incident.restored?.telemetry,
    changes: incident.received.package.recent_changes,
    excerpts: incident.received.package.log_excerpt,
  };
}

export function evidenceLevel(line: TerminalLine) {
  return line.tone === "error" || line.tone === "fail" ? "ERROR" : line.tone === "warn" ? "WARN"
    : line.tone === "pass" ? "OK" : line.tone === "agent" ? "EVIDENCE" : "INFO";
}

export function EvidencePanel({ state }: { state: MarketState }) {
  return <EvidenceView key={state.incident?.jobId ?? "standby"} state={state} />;
}

function EvidenceView({ state }: { state: MarketState }) {
  const [tab, setTab] = useState("logs");
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("ALL");
  const [snapshot, setSnapshot] = useState<TerminalLine[] | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const ref = useRef<HTMLOListElement>(null);
  const nearBottom = useRef(true);
  const data = evidenceData(state);
  const lines = snapshot ?? data?.lines ?? [];
  useEffect(() => {
    if (!snapshot && autoScroll && nearBottom.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length, snapshot, autoScroll, tab]);
  const filtered = lines.filter((line) => (severity === "ALL" || severity === evidenceLevel(line))
    && line.text.toLowerCase().includes(query.toLowerCase()));
  const incident = data?.incident;
  return <section className="panel live-evidence side-evidence">
    <header className="panel-head"><h2>Live Evidence</h2><span className="evidence-mode">{data ? "Deterministic cluster evidence · Simulation" : "Standby"}</span></header>
    <div className="evidence-tabs" role="tablist" aria-label="Live evidence views">
      {["logs", "metrics", "services", "changes"].map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} aria-controls={`evidence-${name}`} onClick={() => setTab(name)}>{name[0].toUpperCase() + name.slice(1)}</button>)}
    </div>
    {!data ? <p>Trigger an incident to begin streaming evidence.</p> : <div id={`evidence-${tab}`} role="tabpanel" aria-label={tab}>
      {tab === "logs" && <>
        <div className="evidence-controls">
          <input aria-label="Search evidence logs" placeholder="Search logs" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select aria-label="Filter log severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>{["ALL", "ERROR", "WARN", "OK", "INFO", "EVIDENCE"].map((level) => <option key={level}>{level}</option>)}</select>
          <button type="button" onClick={() => setSnapshot(snapshot ? null : [...data.lines])}>{snapshot ? "Resume" : "Pause"}</button>
          <label><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> Auto-scroll</label>
        </div>
        <p className="evidence-summary">{incident?.commander ? `${data.excerpts.length} evidence lines used by Captain AI.` : `${data.excerpts.length} evidence lines supplied to Captain AI; classification pending.`}{snapshot && " Display paused."}</p>
        <ol ref={ref} className="evidence-log" aria-label="Evidence logs" onScroll={(event) => { const e = event.currentTarget; nearBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 32; }}>
          {filtered.map((line, index) => {
            const important = data.excerpts.some((excerpt) => line.text.includes(excerpt));
            return <li key={`${line.t}-${index}`} className={`evidence-${evidenceLevel(line).toLowerCase()} ${important ? "evidence-important" : ""}`}>
              <time title="Elapsed since simulation start">{formatDuration(line.t)}</time><b>{evidenceLevel(line)}</b><span title={incident!.current.service}>{incident!.current.service}</span><span>{incident!.current.region.toUpperCase()}</span>
              <div className="evidence-message">{important && <small>Captain evidence</small>}{line.text.length > 180 ? <details><summary><span>{line.text}</span><small>Expand message</small></summary><code>{line.text}</code></details> : <code>{line.text}</code>}</div>
            </li>;
          })}
        </ol>
        {!filtered.length && <p>No matching evidence lines.</p>}
      </>}
      {tab === "metrics" && <div className="evidence-grid">{data.before.map((metric) => {
        const after = data.after?.find((item) => item.key === metric.key);
        return <div key={metric.key} className={(after ?? metric).ok ? "metric-good" : "metric-bad"}><b>{metric.label}</b><span>Before: {formatMetric(metric)}</span><span>After recovery: {after ? formatMetric(after) : "Pending"}</span></div>;
      })}</div>}
      {tab === "services" && <ul className="evidence-services"><li><b>{incident!.current.service}</b><span>Region: {incident!.current.region.toUpperCase()}</span><span>Health: {incident!.restored ? incident!.restored.verification.every((check) => check.passed) ? "Healthy / restored" : "Recovery needs attention" : "Affected"}</span><small>Dependency topology: not recorded. Evidence source: {incident!.received!.source_system}.</small></li></ul>}
      {tab === "changes" && <ul className="evidence-changes">
        {data.changes.map((change) => <li key={change.change_id} className="correlated"><b>{change.change_id}</b><span>{change.key}: {change.old} → {change.new}</span><small>{change.minutes_ago} minutes before incident · {change.author}</small><small>Correlation: included in Captain evidence; causality requires investigation.</small><small>State: {incident!.restored?.steps.some((step) => step.action === "rollback_config") ? "Rolled back by recorded repair" : incident!.restored ? "Retained (no rollback recorded)" : "No rollback recorded"}</small></li>)}
        {incident!.plan && <li><b>PLAN-{incident!.plan.task_id}</b><span>{incident!.plan.summary}</span><small>Correlation: validated incident remediation</small><small>{incident!.restored ? `Applied to simulated cluster: ${describePlan(incident!.restored.steps)}` : "Awaiting application"}</small><time>{formatDuration(state.log.find((event) => event.job_id === incident!.jobId && event.type === "remediation_plan_created")?.t ?? 0)} elapsed</time></li>}
        {!data.changes.length && <li>No deployment/configuration changes recorded in the incident package.</li>}
      </ul>}
    </div>}
  </section>;
}
