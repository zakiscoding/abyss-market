// Pure derivations of what the MAYDAY dashboard shows for a MarketState.
// Every number comes from events; nothing here is hardcoded or touches the DOM.
import type { AgentId, IncidentState, RemediationAction, RepChange } from "../contract";
import type { MarketState, TaskView } from "../state/reducer";
import { currentTask } from "../scene/model";

export const AGENT_ORDER: AgentId[] = ["haiku", "sonnet", "opus"];
export const AGENT_LABEL: Record<AgentId, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

export type Mood = "calm" | "alarm" | "repair" | "restored";

export function moodOf(status: IncidentState | null): Mood {
  switch (status) {
    case "outage":
    case "investigating":
    case "failed":
      return "alarm";
    case "repairing":
    case "awaiting_approval":
    case "recovering":
      return "repair";
    case "restored":
      return "restored";
    default:
      return "calm";
  }
}

export const STATUS_LABEL: Record<IncidentState, string> = {
  healthy: "OPERATIONAL",
  outage: "MAJOR OUTAGE",
  investigating: "INVESTIGATING",
  repairing: "REPAIRING",
  awaiting_approval: "AWAITING APPROVAL",
  recovering: "RECOVERING",
  restored: "RESTORED",
  failed: "ESCALATED",
};

export function describeAction(action: RemediationAction | null): string {
  if (!action) return "rejected";
  return action.action === "set_db_pool_size" ? `set_db_pool_size(${action.value})` : action.action;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function formatPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatEta(ms: number | null): string {
  if (ms == null) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ------------------------------------------------------------------ pipeline

export type StageKey = "diagnose" | "remediate" | "sandbox" | "approve" | "deploy";
export type StageState = "todo" | "active" | "done" | "failed";
export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
  detail: string;
}

function tasksOfType(state: MarketState, type: TaskView["type"]): TaskView[] {
  return state.taskOrder.map((id) => state.tasks[id]).filter((task) => task?.type === type);
}

export function pipeline(state: MarketState): Stage[] {
  const status = state.incident.status;
  const inIncident = status !== null && status !== "healthy";
  const diagnose = tasksOfType(state, "diagnose")[0];
  const remediations = tasksOfType(state, "remediate");
  const repairs = state.incident.repairs;
  const lastRepair = repairs[repairs.length - 1];
  const passed = repairs.find((repair) => repair.sandbox?.passed);
  const rejected = repairs.filter((repair) => repair.sandbox && !repair.sandbox.passed).length;
  const approvedStates: (IncidentState | null)[] = ["recovering", "restored"];

  const diagnoseStage: Stage = {
    key: "diagnose",
    label: "DIAGNOSE",
    state: !diagnose ? (status === "investigating" ? "active" : "todo") : diagnose.status === "graded" ? "done" : diagnose.status === "failed" ? "failed" : "active",
    detail: diagnose?.grade != null ? `grade ${diagnose.grade}/10` : diagnose ? "agents bidding" : "",
  };
  const remediateStage: Stage = {
    key: "remediate",
    label: "REMEDIATE",
    state: passed ? "done" : remediations.length ? "active" : "todo",
    detail: remediations.length ? `attempt ${remediations.length}` : "",
  };
  const sandboxStage: Stage = {
    key: "sandbox",
    label: "SANDBOX",
    state: passed
      ? "done"
      : lastRepair?.sandbox && !lastRepair.sandbox.passed && remediations.length === repairs.length
        ? "failed"
        : lastRepair && !lastRepair.sandbox
          ? "active"
          : "todo",
    detail: passed ? `passed${rejected ? `, ${rejected} rejected` : ""}` : rejected ? `${rejected} rejected` : "",
  };
  const approveStage: Stage = {
    key: "approve",
    label: "APPROVE",
    state: approvedStates.includes(status) ? "done" : status === "awaiting_approval" ? "active" : "todo",
    detail: state.incident.restored ? `by ${state.incident.restored.approved_by}` : status === "awaiting_approval" ? "human decision" : "",
  };
  const deployStage: Stage = {
    key: "deploy",
    label: "DEPLOY",
    state: status === "restored" ? "done" : status === "recovering" ? "active" : status === "failed" && inIncident ? "failed" : "todo",
    detail: status === "restored" ? "verified" : status === "recovering" ? "verifying" : "",
  };
  return [diagnoseStage, remediateStage, sandboxStage, approveStage, deployStage];
}

// ------------------------------------------------------------------ bids

export type BidState = "thinking" | "bid" | "pass" | "won" | "lost";
export interface BidCard {
  agentId: AgentId;
  name: string;
  color: string;
  state: BidState;
  cost: number | null;
  etaMs: number | null;
  quality: number | null;
  reputation: number | null;
  score: number | null;
  pitch: string;
}

export function bidRound(state: MarketState): { task: TaskView | null; cards: BidCard[] } {
  const task = currentTask(state);
  const cards = AGENT_ORDER.flatMap((agentId): BidCard[] => {
    const agent = state.agents[agentId];
    if (!agent) return [];
    const bid = task?.bids[agentId];
    let bidState: BidState = "thinking";
    if (bid && !bid.ok) bidState = "pass";
    else if (bid && task?.winner) bidState = task.winner === agentId ? "won" : "lost";
    else if (bid) bidState = "bid";
    return [{
      agentId,
      name: AGENT_LABEL[agentId],
      color: agent.color,
      state: bidState,
      cost: bid?.predicted_cost_usd ?? null,
      etaMs: bid?.eta_ms ?? null,
      quality: bid?.promised_quality ?? null,
      reputation: bid?.reputation ?? (task ? agent.reputation[task.type] : null),
      score: bid?.score ?? null,
      pitch: bid?.pitch ?? bid?.error ?? "",
    }];
  });
  return { task, cards };
}

// ------------------------------------------------------------------ terminal

export type LineTone = "info" | "warn" | "error" | "agent" | "good" | "human";
export interface TermLine {
  tone: LineTone;
  text: string;
}

/** The investigation terminal: service logs plus the market's actions, in order. */
export function terminalLines(state: MarketState): TermLine[] {
  const jobId = state.currentJob?.jobId ?? null;
  const lines: TermLine[] = [];
  let lastLogs = "";
  for (const ev of state.log) {
    if (ev.job_id !== jobId && !(ev.type === "incident_status" && ev.job_id === null)) continue;
    switch (ev.type) {
      case "incident_status": {
        lines.push({ tone: ev.data.status === "restored" ? "good" : ev.data.status === "healthy" ? "info" : "warn", text: `== ${STATUS_LABEL[ev.data.status]}: ${ev.data.headline}` });
        const key = JSON.stringify(ev.data.logs);
        if (key !== lastLogs) {
          lastLogs = key;
          for (const log of ev.data.logs) {
            lines.push({ tone: log.level === "ERROR" ? "error" : log.level === "WARN" ? "warn" : "info", text: `[${log.level}] ${log.source}: ${log.message}` });
          }
        }
        break;
      }
      case "responders_selected": {
        const names = ev.data.responders.filter((r) => r.selected).map((r) => `${r.name} (${r.role})`);
        lines.push({ tone: "human", text: `paging ${names.join(", ")}` });
        break;
      }
      case "task_posted":
        lines.push({ tone: "agent", text: `> market: ${ev.data.task_id} ${ev.data.type.toUpperCase()} posted - "${ev.data.title}"` });
        break;
      case "won":
        lines.push({ tone: "agent", text: `> ${AGENT_LABEL[ev.data.agent_id]} wins ${ev.data.task_id} (score ${ev.data.score ?? "-"})` });
        break;
      case "done": {
        const task = state.tasks[ev.data.task_id];
        if (task?.type !== "remediate") {
          const text = ev.data.output.replace(/\s+/g, " ");
          lines.push({ tone: "agent", text: `${AGENT_LABEL[ev.data.agent_id]}: ${text.length > 220 ? `${text.slice(0, 217)}...` : text}` });
        }
        break;
      }
      case "remediation_proposed":
        lines.push({ tone: ev.data.valid ? "agent" : "error", text: `${AGENT_LABEL[ev.data.agent_id]} proposes ${ev.data.raw}${ev.data.valid ? "  [allowlist OK]" : `  [REJECTED: ${ev.data.rejection}]`}` });
        break;
      case "sandbox_result":
        for (const check of ev.data.checks) {
          lines.push({ tone: check.passed ? "good" : "error", text: `  sandbox ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}` });
        }
        lines.push({ tone: ev.data.passed ? "good" : "error", text: `sandbox ${ev.data.passed ? "PASSED" : "REJECTED"} ${describeAction(ev.data.action)}` });
        break;
      case "graded":
        lines.push({ tone: "info", text: `  grade ${ev.data.grade}/10 (promised ${ev.data.promised_quality ?? "-"}): ${ev.data.rationale}` });
        break;
      case "approval_required":
        lines.push({ tone: "human", text: `awaiting human approval: ${ev.data.summary}` });
        break;
      case "service_restored":
        lines.push({ tone: "good", text: `approved by ${ev.data.approved_by}; production verified in ${formatClock(ev.data.mttr_ms)}` });
        break;
      case "error":
        lines.push({ tone: "error", text: `error: ${ev.data.message}` });
        break;
      default:
        break;
    }
  }
  return lines;
}

// ------------------------------------------------------------------ outcome

export interface Outcome {
  cost: number;
  attempts: number;
  rejected: number;
  confidence: number | null;
  mttrMs: number | null;
  grades: { taskId: string; type: string; agentId: AgentId; grade: number; promised: number | null }[];
  repChanges: RepChange[];
}

export function outcome(state: MarketState): Outcome {
  const { repairs, restored } = state.incident;
  const jobId = state.currentJob?.jobId ?? null;
  const repChanges: RepChange[] = restored?.rep_changes ?? state.log
    .filter((ev) => ev.type === "rep_update" && ev.job_id === jobId)
    .map((ev) => {
      const d = (ev as Extract<typeof ev, { type: "rep_update" }>).data;
      return { task_id: d.task_id, agent_id: d.agent_id, task_type: d.task_type, old: d.old, new: d.new };
    });
  const grades = state.taskOrder
    .map((id) => state.tasks[id])
    .filter((task): task is TaskView => task?.grade != null && task.winner != null)
    .map((task) => ({
      taskId: task.task_id,
      type: task.type,
      agentId: task.winner!,
      grade: task.grade!,
      promised: task.bids[task.winner!]?.promised_quality ?? null,
    }));
  const passing = repairs.find((repair) => repair.sandbox?.passed);
  const passingBid = passing ? state.tasks[passing.taskId]?.bids[passing.agentId] : undefined;
  return {
    cost: state.final?.total_cost_usd ?? state.stats?.total_cost_usd ?? 0,
    attempts: repairs.length,
    rejected: repairs.filter((repair) => repair.sandbox && !repair.sandbox.passed).length,
    confidence: restored?.confidence ?? (passingBid?.promised_quality != null ? passingBid.promised_quality / 10 : null),
    mttrMs: restored?.mttr_ms ?? null,
    grades,
    repChanges,
  };
}

// ------------------------------------------------------------------ harbor

export type BoatSpot = "dock" | "bidding" | "platform" | "sandbox";
export interface HarborBoat {
  agentId: AgentId;
  color: string;
  label: string;
  spot: BoatSpot;
  flag: string | null;
  flagTone: "neutral" | "good" | "bad";
}
export interface HarborResponder {
  id: string;
  name: string;
  spot: "hq" | "launch" | "platform";
}
export interface HarborModel {
  mood: Mood;
  platform: "healthy" | "down" | "restored";
  sandbox: "idle" | "testing" | "fail" | "pass";
  sandboxLabel: string;
  boats: HarborBoat[];
  responders: HarborResponder[];
}

export function harborModel(state: MarketState): HarborModel {
  const status = state.incident.status;
  const mood = moodOf(status);
  const task = currentTask(state);
  const repair = task ? state.incident.repairs.find((r) => r.taskId === task.task_id) : undefined;

  const boats = AGENT_ORDER.flatMap((agentId): HarborBoat[] => {
    const agent = state.agents[agentId];
    if (!agent) return [];
    let spot: BoatSpot = "dock";
    let flag: string | null = null;
    let flagTone: HarborBoat["flagTone"] = "neutral";
    if (task && status !== "healthy" && status !== "restored") {
      const bid = task.bids[agentId];
      if (task.status === "open") {
        spot = "bidding";
        flag = !bid ? "..." : bid.ok ? `$${(bid.predicted_cost_usd ?? 0).toFixed(4)}` : "PASS";
      } else if (task.winner === agentId) {
        spot = task.type === "remediate" ? "sandbox" : "platform";
        flag = task.type.toUpperCase();
        if (repair?.sandbox) {
          flag = repair.sandbox.passed ? "PASS" : "FAIL";
          flagTone = repair.sandbox.passed ? "good" : "bad";
        }
      }
    }
    return [{ agentId, color: agent.color, label: AGENT_LABEL[agentId].toUpperCase(), spot, flag, flagTone }];
  });

  const responders = (state.incident.team?.responders ?? [])
    .filter((r) => r.selected)
    .map((r): HarborResponder => ({
      id: r.responder_id,
      name: r.name,
      spot: status === "recovering" || status === "restored" ? "platform" : "launch",
    }));

  const repairs = state.incident.repairs;
  const last = repairs[repairs.length - 1];
  const sandbox: HarborModel["sandbox"] = !last ? "idle" : !last.sandbox ? "testing" : last.sandbox.passed ? "pass" : "fail";

  return {
    mood,
    platform: status === "restored" ? "restored" : status && status !== "healthy" && status !== "recovering" ? "down" : "healthy",
    sandbox,
    sandboxLabel: last ? describeAction(last.proposal.action) : "SANDBOX",
    boats,
    responders,
  };
}
