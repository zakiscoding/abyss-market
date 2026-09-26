// Pure selectors for the MAYDAY dashboard. Every number shown is read from
// events or calculated here; nothing is hardcoded.
import { describePlan, type AbyssEvent, type Check, type RepChange, type RoutingStatsData } from "../../contract";
import type { MarketState } from "../../state/reducer";

export type StageState = "pending" | "active" | "done" | "failed";
export interface Stage {
  key: "classify" | "diagnose" | "remediate" | "sandbox" | "assign" | "approve" | "deploy";
  label: string;
  state: StageState;
  detail: string;
}

function jobEvents(state: MarketState): AbyssEvent[] {
  const jobId = state.currentJob?.jobId;
  return jobId ? state.log.filter((event) => event.job_id === jobId) : [];
}

export function pipeline(state: MarketState): Stage[] {
  const incident = state.incident;
  const status = incident?.status ?? "healthy";
  const tasks = state.taskOrder.map((id) => state.tasks[id]);
  const diagnose = tasks.find((task) => task.type === "diagnose");
  const repairs = incident?.repairs ?? [];
  const passed = repairs.find((repair) => repair.sandbox?.passed);
  const last = repairs.at(-1);
  const failed = repairs.filter((repair) => repair.sandbox && !repair.sandbox.passed).length;
  const after = (states: string[]) => states.includes(status);
  const commander = incident?.commander ?? null;
  const assignments = incident?.assignments ?? null;
  const approvers = assignments?.required_approvers.length ?? 0;

  const stages: Stage[] = [
    {
      key: "classify",
      label: "Classify",
      state: commander ? "done" : incident?.received ? "active" : "pending",
      detail: commander ? `${commander.domain} · ${commander.severity}` : "",
    },
    {
      key: "diagnose",
      label: "Diagnose",
      state: !diagnose ? "pending" : diagnose.status === "graded" ? "done" : diagnose.status === "failed" ? "failed" : "active",
      detail: diagnose?.winner ? diagnose.winner.toUpperCase() : "",
    },
    {
      key: "remediate",
      label: "Remediate",
      state: passed ? "done" : tasks.some((task) => task.type === "remediate") ? "active" : "pending",
      detail: repairs.length ? `${repairs.length} proposal${repairs.length > 1 ? "s" : ""}` : "",
    },
    {
      key: "sandbox",
      label: "Sandbox",
      state: passed ? "done" : !last ? "pending" : !last.sandbox ? "active" : "failed",
      detail: failed ? `${failed} rejected` : passed ? "passed" : "",
    },
    {
      key: "assign",
      label: "Assign",
      state: assignments ? "done" : incident?.escalated ? "failed" : passed ? "active" : "pending",
      detail: assignments ? `${approvers} approver${approvers > 1 ? "s" : ""}` : incident?.escalated ? "escalated" : "",
    },
    {
      key: "approve",
      label: "Approve",
      state: after(["recovering", "restored"]) ? "done" : status === "awaiting_approval" ? "active" : "pending",
      detail: incident?.granted ? incident.granted.approved_by.join(", ") : status === "awaiting_approval" ? "humans needed" : "",
    },
    {
      key: "deploy",
      label: "Deploy",
      state: status === "restored" ? "done" : status === "recovering" ? "active" : status === "failed" ? "failed" : "pending",
      detail: passed?.proposal.steps.length ? describePlan(passed.proposal.steps) : "",
    },
  ];
  return stages;
}

export interface Outcome {
  aiCost: number;
  attempts: number;
  failedAttempts: number;
  confidence: number | null;
  verification: Check[];
  repChanges: RepChange[];
  meanGrade: number | null;
  routing: RoutingStatsData | null;
}

export function outcome(state: MarketState): Outcome {
  const incident = state.incident;
  const restored = incident?.restored ?? null;
  const events = jobEvents(state);
  const repChanges: RepChange[] = restored?.rep_changes ?? events.flatMap((event) =>
    event.type === "rep_update"
      ? [{ agent_id: event.data.agent_id, task_type: event.data.task_type, rep_key: event.data.rep_key, old: event.data.old, new: event.data.new }]
      : [],
  );
  const grades = events.flatMap((event) => (event.type === "graded" ? [event.data.grade] : []));
  const repairs = incident?.repairs ?? [];
  const passing = repairs.find((repair) => repair.sandbox?.passed);
  let confidence = restored?.confidence ?? null;
  if (confidence === null && passing) {
    confidence = state.tasks[passing.proposal.task_id]?.bids[passing.proposal.agent_id]?.confidence ?? null;
  }
  return {
    aiCost: state.stats?.total_cost_usd ?? 0,
    attempts: repairs.length,
    failedAttempts: repairs.filter((repair) => repair.sandbox && !repair.sandbox.passed).length,
    confidence,
    verification: restored?.verification ?? [],
    repChanges,
    meanGrade: grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : null,
    routing: incident?.routing ?? null,
  };
}

export interface TerminalLine {
  t: number;
  tone: "info" | "warn" | "error" | "agent" | "pass" | "fail" | "human";
  text: string;
}

function logTone(line: string): TerminalLine["tone"] {
  if (line.startsWith("ERROR")) return "error";
  if (line.startsWith("WARN")) return "warn";
  return "info";
}

export function terminal(state: MarketState): TerminalLine[] {
  const lines: TerminalLine[] = [];
  const incident = state.incident;
  if (!incident) return lines;
  if (incident.status === "healthy" && !incident.received) {
    return incident.current.logs.map((text) => ({ t: 0, tone: logTone(text), text }));
  }
  for (const event of jobEvents(state)) {
    const t = event.t;
    switch (event.type) {
      case "incident_received":
        lines.push({ t, tone: "warn", text: `ALERT ${event.data.source_system}: ${event.data.alert}` });
        break;
      case "incident_status":
        if (event.data.status === "outage") {
          lines.push(...event.data.logs.map((text) => ({ t, tone: logTone(text), text })));
        }
        lines.push({ t, tone: event.data.status === "restored" ? "pass" : event.data.status === "failed" ? "error" : "warn", text: `== ${event.data.status.toUpperCase()}: ${event.data.summary}` });
        break;
      case "commander_classified": {
        const source = event.data.source === "rules" ? `rules fallback: ${event.data.fallback_reason}` : "model";
        lines.push({ t, tone: "agent", text: `commander> ${event.data.domain} · ${event.data.severity} (${source}). ${event.data.rationale}` });
        break;
      }
      case "specialists_dispatched": {
        const sent = event.data.specialists.filter((s) => s.dispatched).map((s) => s.label);
        lines.push({ t, tone: "agent", text: `DISPATCH ${sent.join(", ")} (${event.data.eligible} of ${event.data.registered} specialists)` });
        break;
      }
      case "responders_selected":
        lines.push({ t, tone: "human", text: `PAGED ${event.data.responders.filter((r) => r.selected).map((r) => r.name).join(", ")}` });
        break;
      case "won":
        lines.push({ t, tone: "agent", text: `${event.data.task_id} awarded to ${event.data.agent_id} (score ${event.data.score})` });
        break;
      case "done":
        lines.push({ t, tone: "agent", text: `${event.data.agent_id}> ${event.data.output}` });
        break;
      case "remediation_proposed":
        lines.push({ t, tone: event.data.accepted ? "agent" : "fail", text: `allowlist: ${event.data.reason}` });
        break;
      case "sandbox_result":
        for (const check of event.data.checks) {
          lines.push({ t, tone: check.passed ? "pass" : "fail", text: `sandbox ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}` });
        }
        break;
      case "remediation_plan_created":
        lines.push({ t, tone: "pass", text: `PLAN ${event.data.summary}` });
        break;
      case "human_assignments_created":
        for (const item of event.data.assignments) {
          lines.push({ t, tone: "human", text: `ASSIGN ${item.name} (${item.role}): ${item.description}${item.approval_required ? " [approval]" : ""}` });
        }
        break;
      case "approval_required":
        lines.push({ t, tone: "human", text: `APPROVAL NEEDED from ${event.data.approvers.join(", ")}: ${event.data.summary}` });
        break;
      case "approval_granted":
        lines.push({ t, tone: "pass", text: `APPROVED by ${event.data.approved_by.join(", ")}` });
        break;
      case "incident_escalated":
        lines.push({ t, tone: "error", text: `ESCALATED to ${event.data.escalated_to.join(", ")}: ${event.data.reason}` });
        break;
      case "graded":
        lines.push({ t, tone: "info", text: `${event.data.task_id} graded ${event.data.grade}/10: ${event.data.rationale}` });
        break;
      default:
        break;
    }
  }
  return lines;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
