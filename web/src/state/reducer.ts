import type {
  AbyssEvent,
  AgentId,
  AgentSpec,
  ApprovalRequiredData,
  BidData,
  ConfigChange,
  FinalData,
  HelloData,
  IncidentState,
  LogLine,
  RemediationProposedData,
  RespondersSelectedData,
  SandboxResultData,
  ServiceRestoredData,
  Severity,
  StatsData,
  TaskSpec,
  TaskType,
  Telemetry,
} from "../contract";

export interface RepairAttempt {
  taskId: string;
  attempt: number;
  agentId: AgentId;
  proposal: RemediationProposedData;
  sandbox: SandboxResultData | null;
}

export interface IncidentView {
  /** null until the backend or fixture reports the service state. */
  status: IncidentState | null;
  service: string;
  severity: Severity | null;
  headline: string;
  telemetry: Telemetry | null;
  /** Telemetry at the moment of the outage, kept for before/after comparisons. */
  outageTelemetry: Telemetry | null;
  logs: LogLine[];
  configChanges: ConfigChange[];
  /** Status timeline with the event time (ms since the incident started). */
  history: { status: IncidentState; t: number }[];
  team: RespondersSelectedData | null;
  repairs: RepairAttempt[];
  approval: ApprovalRequiredData | null;
  restored: ServiceRestoredData | null;
}

export const initialIncident: IncidentView = {
  status: null,
  service: "payments-api",
  severity: null,
  headline: "",
  telemetry: null,
  outageTelemetry: null,
  logs: [],
  configChanges: [],
  history: [],
  team: null,
  repairs: [],
  approval: null,
  restored: null,
};

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
  reputation: Record<TaskType, number>;
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
  incident: IncidentView;
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
  incident: initialIncident,
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
      // Incident tasks have no job_split, so the first task_posted creates them.
      const known = ev.data.task_id in state.tasks;
      const tasks = known ? state.tasks : { ...state.tasks, [ev.data.task_id]: createTask(ev.data) };
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "bidding"),
        taskOrder: known ? state.taskOrder : [...state.taskOrder, ev.data.task_id],
        tasks: updateTask(tasks, ev.data.task_id, {
          ...ev.data,
          status: "open",
        }),
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
              [ev.data.task_type]: ev.data.new,
            },
          },
        },
      };
    }
    case "stats":
      return { ...withLog, stats: ev.data };
    case "final":
      return {
        ...withLog,
        agents: mapAgentStatus(state.agents, () => "idle"),
        final: ev.data,
        jobActive: false,
      };
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
      const common = {
        status: data.status,
        service: data.service,
        severity: data.severity,
        headline: data.headline,
        telemetry: data.telemetry,
        logs: data.logs,
        configChanges: data.config_changes,
      };
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
          incident: { ...initialIncident, ...common },
        };
      }
      if (data.status === "outage") {
        return {
          ...withLog,
          currentJob: {
            jobId: ev.job_id ?? "",
            jobText: data.headline,
            priceWeight: state.config?.price_weight ?? 1,
          },
          tasks: {},
          taskOrder: [],
          stats: null,
          final: null,
          jobActive: true,
          incident: {
            ...initialIncident,
            ...common,
            outageTelemetry: data.telemetry,
            history: [{ status: data.status, t: ev.t }],
          },
        };
      }
      return {
        ...withLog,
        incident: {
          ...state.incident,
          ...common,
          history: [...state.incident.history, { status: data.status, t: ev.t }],
        },
      };
    }
    case "responders_selected":
      return { ...withLog, incident: { ...state.incident, team: ev.data } };
    case "remediation_proposed":
      return {
        ...withLog,
        incident: {
          ...state.incident,
          repairs: [
            ...state.incident.repairs,
            {
              taskId: ev.data.task_id,
              attempt: ev.data.attempt,
              agentId: ev.data.agent_id,
              proposal: ev.data,
              sandbox: null,
            },
          ],
        },
      };
    case "sandbox_result":
      return {
        ...withLog,
        incident: {
          ...state.incident,
          repairs: state.incident.repairs.map((repair) =>
            repair.taskId === ev.data.task_id ? { ...repair, sandbox: ev.data } : repair,
          ),
        },
      };
    case "approval_required":
      return { ...withLog, incident: { ...state.incident, approval: ev.data } };
    case "service_restored":
      return { ...withLog, incident: { ...state.incident, restored: ev.data } };
    default:
      console.warn("Unknown Abyss event type", (ev as { type: string }).type);
      return withLog;
  }
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
