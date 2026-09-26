import { incidentCrew, type CrewMember } from "./incident";
import type {
  AbyssEvent,
  AgentId,
  AgentSpec,
  ApprovalGrantedData,
  ApprovalRequiredData,
  BidData,
  CommanderClassifiedData,
  Domain,
  FinalData,
  HelloData,
  HumanAssignmentsData,
  IncidentEscalatedData,
  IncidentReceivedData,
  IncidentState,
  IncidentStatusData,
  RemediationPlanData,
  RemediationProposedData,
  RespondersSelectedData,
  RoutingStatsData,
  SandboxResultData,
  ScenarioId,
  ServiceRestoredData,
  Severity,
  SpecialistsDispatchedData,
  StatsData,
  TaskSpec,
} from "../contract";

export interface RepairAttempt {
  proposal: RemediationProposedData;
  sandbox: SandboxResultData | null;
}

export interface IncidentView {
  /** Null while the service is healthy and no incident has been received. */
  jobId: string | null;
  status: IncidentState;
  current: IncidentStatusData;
  /** Event time of the outage and of the latest incident event (ms since job start). */
  outageT: number | null;
  lastT: number;
  received: IncidentReceivedData | null;
  commander: CommanderClassifiedData | null;
  dispatched: SpecialistsDispatchedData | null;
  responders: RespondersSelectedData | null;
  repairs: RepairAttempt[];
  plan: RemediationPlanData | null;
  assignments: HumanAssignmentsData | null;
  approval: ApprovalRequiredData | null;
  granted: ApprovalGrantedData | null;
  escalated: IncidentEscalatedData | null;
  restored: ServiceRestoredData | null;
  routing: RoutingStatsData | null;
}

export interface HistoryEntry {
  jobId: string;
  scenarioId: ScenarioId;
  name: string;
  service: string;
  domain: Domain | null;
  severity: Severity | null;
  outcome: "restored" | "failed";
  mttrMs: number | null;
  costUsd: number;
  avoidedTokensEst: number | null;
  avoidedCostUsdEst: number | null;
  approvedBy: string[];
  crew: CrewMember[];
}

export type AgentStatus = "idle" | "bidding" | "working";
export type TaskStatus =
  | "pending"
  | "open"
  | "assigned"
  | "working"
  | "done"
  | "graded"
  | "failed";

export interface AgentView extends AgentSpec {
  reputation: Record<string, number>;
  status: AgentStatus;
}

export interface TaskView extends TaskSpec {
  status: TaskStatus;
  bids: Partial<Record<AgentId, BidData>>;
  winner: AgentId | null;
  output: string | null;
  grade: number | null;
  rationale: string | null;
}

export interface MarketState {
  agents: Partial<Record<AgentId, AgentView>>;
  currentJob: {
    jobId: string;
    jobText: string;
    priceWeight: number;
  } | null;
  tasks: Record<string, TaskView>;
  taskOrder: string[];
  stats: StatsData | null;
  final: FinalData | null;
  log: AbyssEvent[];
  connected: boolean;
  config: HelloData["config"] | null;
  jobActive: boolean;
  incident: IncidentView | null;
  /** Finished incidents this session, newest first. Survives reconnects. */
  history: HistoryEntry[];
}

export const initialState: MarketState = {
  agents: {},
  currentJob: null,
  tasks: {},
  taskOrder: [],
  stats: null,
  final: null,
  log: [],
  connected: false,
  config: null,
  jobActive: false,
  incident: null,
  history: [],
};

export function setConnected(state: MarketState, connected: boolean): MarketState {
  return { ...state, connected };
}

export function reduce(state: MarketState, ev: AbyssEvent): MarketState {
  const withLog = { ...state, log: [...state.log, ev].slice(-200) };
  switch (ev.type) {
    case "hello": {
      const agents: MarketState["agents"] = {};
      for (const agent of ev.data.agents) {
        agents[agent.agent_id] = {
          ...agent,
          reputation: { ...ev.data.reputation[agent.agent_id] },
          status: "idle",
        };
      }
      // A fresh hello means a fresh connection: the server cancels a connection's
      // job when it drops, so nothing can still be running.
      return { ...withLog, agents, connected: true, config: ev.data.config, jobActive: false };
    }
    case "job_split": {
      const tasks = Object.fromEntries(
        ev.data.tasks.map((task) => [task.task_id, createTask(task)]),
      );
      return {
        ...withLog,
        currentJob: {
          jobId: ev.job_id ?? "",
          jobText: ev.data.job_text,
          priceWeight: ev.data.price_weight,
        },
        tasks,
        taskOrder: ev.data.tasks.map((task) => task.task_id),
        stats: null,
        final: null,
        jobActive: true,
      };
    }
    case "task_posted": {
      // Incident tasks are posted one at a time, without a job_split.
      const existing = state.tasks[ev.data.task_id] ?? createTask(ev.data);
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "bidding"),
        tasks: { ...state.tasks, [ev.data.task_id]: { ...existing, ...ev.data, status: "open" } },
        taskOrder: state.taskOrder.includes(ev.data.task_id)
          ? state.taskOrder
          : [...state.taskOrder, ev.data.task_id],
      };
    }
    case "bid": {
      const task = state.tasks[ev.data.task_id];
      if (!task) return withLog;
      return {
        ...withLog,
        tasks: {
          ...state.tasks,
          [ev.data.task_id]: {
            ...task,
            bids: { ...task.bids, [ev.data.agent_id]: ev.data },
          },
        },
      };
    }
    case "won":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        tasks: updateTask(state.tasks, ev.data.task_id, {
          winner: ev.data.agent_id,
          status: "assigned",
        }),
      };
    case "working":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, (agentId) =>
          agentId === ev.data.agent_id ? "working" : "idle",
        ),
        tasks: updateTask(state.tasks, ev.data.task_id, { status: "working" }),
      };
    case "done":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        tasks: updateTask(state.tasks, ev.data.task_id, {
          output: ev.data.output,
          status: "done",
        }),
      };
    case "graded":
      return {
        ...withLog,
        tasks: updateTask(state.tasks, ev.data.task_id, {
          grade: ev.data.grade,
          rationale: ev.data.rationale,
          status: "graded",
        }),
      };
    case "rep_update": {
      const agent = state.agents[ev.data.agent_id];
      if (!agent) return withLog;
      return {
        ...withLog,
        agents: {
          ...state.agents,
          [ev.data.agent_id]: {
            ...agent,
            reputation: {
              ...agent.reputation,
              [ev.data.rep_key]: ev.data.new,
            },
          },
        },
      };
    }
    case "stats":
      return { ...withLog, stats: ev.data };
    case "final": {
      const entry = historyEntry(state.incident, ev.job_id, ev.data);
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        final: ev.data,
        jobActive: false,
        history: entry ? [entry, ...state.history].slice(0, 20) : state.history,
      };
    }
    case "error":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        jobActive: ev.data.fatal ? false : state.jobActive,
        tasks: ev.data.task_id
          ? updateTask(state.tasks, ev.data.task_id, { status: "failed" })
          : state.tasks,
      };
    case "incident_status": {
      const data = ev.data;
      if (data.status === "healthy") {
        return {
          ...withLog,
          agents: mapAgentStatus(state.agents, () => "idle"),
          currentJob: null,
          tasks: {},
          taskOrder: [],
          stats: null,
          final: null,
          jobActive: false,
          incident: freshIncident(data, null, ev.t),
        };
      }
      const known = state.incident && state.incident.jobId === ev.job_id;
      const base = known ? withLog : startIncident(withLog, ev.job_id, data, ev.t, data.summary);
      const incident = base.incident!;
      return {
        ...base,
        incident: {
          ...incident,
          status: data.status,
          current: data,
          outageT: data.status === "outage" ? incident.outageT ?? ev.t : incident.outageT,
          lastT: ev.t,
        },
      };
    }
    case "incident_received": {
      const placeholder: IncidentStatusData = {
        status: "outage", scenario_id: ev.data.scenario_id, service: ev.data.service,
        region: ev.data.region, severity: null, summary: ev.data.alert,
        telemetry: ev.data.package.breached, logs: [], config_changes: [],
      };
      const started = startIncident(withLog, ev.job_id, placeholder, ev.t, ev.data.alert);
      return withIncident(started, ev.t, { received: ev.data, outageT: ev.t });
    }
    case "commander_classified":
      return withIncident(withLog, ev.t, { commander: ev.data });
    case "specialists_dispatched":
      return withIncident(withLog, ev.t, { dispatched: ev.data });
    case "responders_selected":
      return withIncident(withLog, ev.t, { responders: ev.data });
    case "remediation_plan_created":
      return withIncident(withLog, ev.t, { plan: ev.data });
    case "human_assignments_created":
      return withIncident(withLog, ev.t, { assignments: ev.data });
    case "approval_granted":
      return withIncident(withLog, ev.t, { granted: ev.data });
    case "incident_escalated":
      return withIncident(withLog, ev.t, { escalated: ev.data });
    case "routing_stats":
      return withIncident(withLog, ev.t, { routing: ev.data });
    case "remediation_proposed": {
      const repairs = state.incident?.repairs ?? [];
      return withIncident(withLog, ev.t, { repairs: [...repairs, { proposal: ev.data, sandbox: null }] });
    }
    case "sandbox_result": {
      const repairs = (state.incident?.repairs ?? []).map((repair) =>
        repair.proposal.task_id === ev.data.task_id ? { ...repair, sandbox: ev.data } : repair,
      );
      return withIncident(withLog, ev.t, { repairs });
    }
    case "approval_required":
      return withIncident(withLog, ev.t, { approval: ev.data });
    case "service_restored":
      return withIncident(withLog, ev.t, { restored: ev.data });
    default:
      console.warn("Unknown Abyss event type", (ev as { type: string }).type);
      return withLog;
  }
}

function freshIncident(data: IncidentStatusData, outageT: number | null, t: number, jobId: string | null = null): IncidentView {
  return {
    jobId,
    status: data.status,
    current: data,
    outageT,
    lastT: t,
    received: null,
    commander: null,
    dispatched: null,
    responders: null,
    repairs: [],
    plan: null,
    assignments: null,
    approval: null,
    granted: null,
    escalated: null,
    restored: null,
    routing: null,
  };
}

function startIncident(
  state: MarketState,
  jobId: string | null,
  data: IncidentStatusData,
  t: number,
  summary: string,
): MarketState {
  return {
    ...state,
    currentJob: { jobId: jobId ?? "", jobText: summary, priceWeight: state.config?.price_weight ?? 1 },
    tasks: {},
    taskOrder: [],
    stats: null,
    final: null,
    jobActive: true,
    incident: freshIncident(data, null, t, jobId),
  };
}

function historyEntry(incident: IncidentView | null, jobId: string | null, final: FinalData): HistoryEntry | null {
  if (!incident || !incident.jobId || incident.jobId !== jobId) return null;
  const restored = incident.restored;
  return {
    jobId: incident.jobId,
    scenarioId: incident.current.scenario_id,
    name: incident.received?.name ?? incident.current.service,
    service: incident.current.service,
    domain: incident.commander?.domain ?? null,
    severity: incident.commander?.severity ?? incident.current.severity,
    outcome: restored && final.status === "ok" ? "restored" : "failed",
    mttrMs: restored?.mttr_ms ?? null,
    costUsd: incident.routing?.actual_cost_usd ?? final.total_cost_usd,
    avoidedTokensEst: incident.routing?.avoided_input_tokens_est ?? null,
    avoidedCostUsdEst: incident.routing?.avoided_cost_usd_est ?? null,
    approvedBy: restored?.approved_by ?? incident.granted?.approved_by ?? [],
    crew: incidentCrew(incident),
  };
}

function withIncident(state: MarketState, t: number, changes: Partial<IncidentView>): MarketState {
  if (!state.incident) return state;
  return { ...state, incident: { ...state.incident, ...changes, lastT: t } };
}

function createTask(task: TaskSpec): TaskView {
  return {
    ...task,
    status: "pending",
    bids: {},
    winner: null,
    output: null,
    grade: null,
    rationale: null,
  };
}

function updateTask(
  tasks: Record<string, TaskView>,
  taskId: string,
  changes: Partial<TaskView>,
): Record<string, TaskView> {
  const current = tasks[taskId];
  if (!current) return tasks;
  return { ...tasks, [taskId]: { ...current, ...changes } };
}

function mapAgentStatus(
  agents: MarketState["agents"],
  status: (agentId: AgentId) => AgentStatus,
): MarketState["agents"] {
  const updated: MarketState["agents"] = {};
  for (const [agentId, agent] of Object.entries(agents) as [
    AgentId,
    AgentView,
  ][]) {
    updated[agentId] = { ...agent, status: status(agentId) };
  }
  return updated;
}
