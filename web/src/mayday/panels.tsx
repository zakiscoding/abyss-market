import { useEffect, useRef, useState } from "react";

import type { ApprovalRequiredData, Briefings, RespondersSelectedData, Telemetry } from "../contract";
import type { IncidentView, MarketState } from "../state/reducer";
import {
  AGENT_LABEL,
  bidRound,
  describeAction,
  formatClock,
  formatEta,
  formatPct,
  formatUsd,
  outcome,
  pipeline,
  terminalLines,
} from "./model";

// ------------------------------------------------------------------ telemetry

interface Metric {
  label: string;
  value: (t: Telemetry) => string;
  sub?: (t: Telemetry) => string;
}

const METRICS: Metric[] = [
  { label: "ERROR RATE", value: (t) => formatPct(t.error_rate) },
  { label: "P95 LATENCY", value: (t) => `${t.p95_latency_ms}ms` },
  { label: "PAYMENTS OK", value: (t) => formatPct(t.payment_success_rate) },
  { label: "DB POOL", value: (t) => `${t.db_pool_in_use}/${t.db_pool_size}`, sub: (t) => `${t.db_waiting} waiting` },
  { label: "TIMEOUTS", value: (t) => `${t.timeouts_per_min}/min` },
  { label: "TRAFFIC", value: (t) => `${t.requests_per_min}/min` },
];

export function TelemetryPanel({ incident }: { incident: IncidentView }) {
  const t = incident.telemetry;
  const before = incident.outageTelemetry;
  return (
    <section className="md-panel md-telemetry">
      <h2>
        Telemetry <span>{incident.service}</span>
      </h2>
      <div className="md-metrics">
        {METRICS.map((metric) => {
          const now = t ? metric.value(t) : "--";
          const was = before && t && before !== t ? metric.value(before) : null;
          return (
            <div className="md-metric" key={metric.label}>
              <small>{metric.label}</small>
              <strong>{now}</strong>
              <em>
                {was && was !== now ? `was ${was}` : t && metric.sub ? metric.sub(t) : "\u00a0"}
              </em>
            </div>
          );
        })}
      </div>
      {incident.configChanges.length > 0 && (
        <div className="md-changes">
          <small>RECENT CONFIG CHANGES</small>
          {incident.configChanges.map((change, i) => (
            <div key={i} className="md-change">
              <code>{change.key}</code> {change.old} {"->"} {change.new}
              <span>
                {change.author}
                {change.minutes_ago ? `, ${change.minutes_ago}m ago` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ terminal

export function Terminal({ state }: { state: MarketState }) {
  const lines = terminalLines(state);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <section className="md-panel md-terminal">
      <h2>
        Investigation <span>live feed</span>
      </h2>
      <div className="md-term" ref={ref}>
        {lines.length === 0 && <div className="line info">waiting for telemetry...</div>}
        {lines.map((line, i) => (
          <div key={i} className={`line ${line.tone}`}>
            {line.text}
          </div>
        ))}
        <div className="line cursor">_</div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ pipeline

export function PipelineBar({ state }: { state: MarketState }) {
  return (
    <nav className="md-pipeline" aria-label="Incident pipeline">
      {pipeline(state).map((stage, i) => (
        <div key={stage.key} className={`md-stage-step ${stage.state}`}>
          <span className="n">{i + 1}</span>
          <div>
            <strong>{stage.label}</strong>
            <small>{stage.detail || "\u00a0"}</small>
          </div>
        </div>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------------ bids

export function BidsPanel({ state }: { state: MarketState }) {
  const { task, cards } = bidRound(state);
  const active = task && state.incident.status && state.incident.status !== "healthy";
  return (
    <section className="md-panel md-bids">
      <h2>
        Agent bids <span>{active ? `${task!.task_id} ${task!.type.toUpperCase()}` : "market idle"}</span>
      </h2>
      {!active && <p className="md-empty">Break production to open the market. Three AI agents will bid on each step.</p>}
      {active && (
        <div className="md-bid-list">
          {cards.map((card) => (
            <article key={card.agentId} className={`md-bid ${card.state}`} style={{ ["--agent" as string]: card.color }}>
              <header>
                <span className="swatch" />
                <strong>{card.name}</strong>
                <em>{card.state === "won" ? "WINNER" : card.state === "thinking" ? "bidding..." : card.state === "pass" ? "PASS" : ""}</em>
              </header>
              <dl>
                <div>
                  <dt>COST</dt>
                  <dd>{card.cost != null ? formatUsd(card.cost) : "-"}</dd>
                </div>
                <div>
                  <dt>ETA</dt>
                  <dd>{formatEta(card.etaMs)}</dd>
                </div>
                <div>
                  <dt>CONF</dt>
                  <dd>{card.quality != null ? `${card.quality * 10}%` : "-"}</dd>
                </div>
                <div>
                  <dt>REP</dt>
                  <dd>{card.reputation != null ? card.reputation.toFixed(2) : "-"}</dd>
                </div>
                <div>
                  <dt>SCORE</dt>
                  <dd>{card.score != null ? card.score.toFixed(2) : "-"}</dd>
                </div>
              </dl>
              {card.pitch && <p>"{card.pitch}"</p>}
            </article>
          ))}
        </div>
      )}
      {active && <p className="md-formula">score = confidence x reputation - price</p>}
    </section>
  );
}

// ------------------------------------------------------------------ team

const AUDIENCES: { key: keyof Briefings; label: string }[] = [
  { key: "engineering", label: "Engineers" },
  { key: "support", label: "Support" },
  { key: "commander", label: "Commander" },
  { key: "leadership", label: "Leadership" },
];

export function TeamPanel({ incident }: { incident: IncidentView }) {
  const [audience, setAudience] = useState<keyof Briefings>("engineering");
  const team = incident.team;
  return (
    <section className="md-panel md-team">
      <h2>
        Rescue team <span>{team ? `needs ${team.required_skills.join(", ")}` : "on standby"}</span>
      </h2>
      {!team && <p className="md-empty">Humans are paged by skill match, availability, severity and workload.</p>}
      {team && (
        <>
          <ul className="md-people">
            {team.responders.map((r) => (
              <li key={r.responder_id} className={r.selected ? "selected" : "standby"} title={r.reason}>
                <span className="avatar">{r.name[0]}</span>
                <div>
                  <strong>
                    {r.name} <em>{r.role}</em>
                  </strong>
                  <small>{r.reason}</small>
                </div>
                <b>{r.selected ? "PAGED" : "STANDBY"}</b>
              </li>
            ))}
          </ul>
          <div className="md-briefing">
            <div className="tabs" role="tablist">
              {AUDIENCES.map((a) => (
                <button key={a.key} type="button" role="tab" aria-selected={audience === a.key} className={audience === a.key ? "on" : ""} onClick={() => setAudience(a.key)}>
                  {a.label}
                </button>
              ))}
            </div>
            <p>{team.briefings[audience]}</p>
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ approval

export function ApprovalCard({
  approval,
  team,
  sent,
  onApprove,
}: {
  approval: ApprovalRequiredData;
  team: RespondersSelectedData | null;
  sent: boolean;
  onApprove: () => void;
}) {
  const reviewers = team?.responders.filter((r) => r.selected).map((r) => r.name) ?? [];
  return (
    <div className="md-approval" role="dialog" aria-label="Approve repair">
      <small>HUMAN APPROVAL REQUIRED</small>
      <h3>{describeAction(approval.action)}</h3>
      <p>{approval.summary}</p>
      <p className="who">
        Proposed by {AGENT_LABEL[approval.agent_id]} (attempt {approval.attempt}). Approver: {approval.approvers.join(", ") || "on-call"}.
        {reviewers.length ? ` Team on the line: ${reviewers.join(", ")}.` : ""}
      </p>
      <button type="button" className="md-approve" disabled={sent} onClick={onApprove}>
        {sent ? "Deploying..." : "Approve Repair"}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ outcome

export function OutcomePanel({ state }: { state: MarketState }) {
  const o = outcome(state);
  const restored = state.incident.restored;
  const meanGrade = o.grades.length ? o.grades.reduce((sum, g) => sum + g.grade, 0) / o.grades.length : null;
  return (
    <section className="md-outcome">
      <div className="md-kpi">
        <small>MTTR</small>
        <strong>{o.mttrMs != null ? formatClock(o.mttrMs) : "--:--"}</strong>
        <em>{restored ? "outage to verified" : "pending"}</em>
      </div>
      <div className="md-kpi">
        <small>TOTAL AI COST</small>
        <strong>{formatUsd(o.cost)}</strong>
        <em>{state.stats ? `${state.stats.calls} model calls` : "\u00a0"}</em>
      </div>
      <div className="md-kpi">
        <small>REPAIR ATTEMPTS</small>
        <strong>{o.attempts}</strong>
        <em>{o.rejected ? `${o.rejected} rejected by sandbox` : "\u00a0"}</em>
      </div>
      <div className="md-kpi">
        <small>CONFIDENCE</small>
        <strong>{o.confidence != null ? formatPct(o.confidence, 0) : "--"}</strong>
        <em>winning repair bid</em>
      </div>
      <div className="md-kpi wide">
        <small>GRADES {meanGrade != null ? `(mean ${meanGrade.toFixed(2)})` : ""}</small>
        <div className="chips">
          {o.grades.length === 0 && <em>none yet</em>}
          {o.grades.map((g) => (
            <span key={g.taskId} className={`chip ${g.promised != null && g.grade < g.promised ? "bad" : "good"}`} title={`${AGENT_LABEL[g.agentId]}, promised ${g.promised ?? "-"}`}>
              {g.taskId} {g.type} {g.grade}/10
            </span>
          ))}
        </div>
      </div>
      <div className="md-kpi wide">
        <small>REPUTATION CHANGES</small>
        <div className="chips">
          {o.repChanges.length === 0 && <em>none yet</em>}
          {o.repChanges.map((r) => (
            <span key={r.task_id} className={`chip ${r.new < r.old ? "bad" : "good"}`}>
              {AGENT_LABEL[r.agent_id]} {r.task_type} {r.old.toFixed(2)}
              {r.new < r.old ? " v " : " ^ "}
              {r.new.toFixed(2)}
            </span>
          ))}
        </div>
      </div>
      <div className="md-kpi wide">
        <small>VERIFICATION</small>
        <div className="chips">
          {!restored && <em>{state.incident.status === "recovering" ? "verifying production..." : "not deployed"}</em>}
          {restored?.verification.map((check) => (
            <span key={check.name} className={`chip ${check.passed ? "good" : "bad"}`} title={check.detail}>
              {check.passed ? "PASS" : "FAIL"} {check.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
