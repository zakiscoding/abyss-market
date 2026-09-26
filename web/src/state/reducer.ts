import type {
  AbyssEvent,
  AgentId,
  AgentSpec,
  ApprovalRequiredData,
  BidData,
  FinalData,
  HelloData,
  IncidentState,
  IncidentStatusData,
  RemediationProposedData,
  RespondersSelectedData,
  SandboxResultData,
  ServiceRestoredData,
  StatsData,
  TaskSpec,
  TaskType,
} from "../contract";

export interface RepairAttempt {
  proposal: RemediationProposedData;
  sandbox: SandboxResultData | null;
}

export interface IncidentView {
  status: IncidentState;
  current: IncidentStatusData;
  /** Event time of the outage and of the latest incident event (ms since job start). */
  outageT: number | null;
  lastT: number;
  responders: RespondersSelectedData | null;
  repairs: RepairAttempt[];
  approval: ApprovalRequiredData | null;
  restored: ServiceRestoredData | null;
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
  incident: IncidentView | null;
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
      if (data.status === "outage") {
        return {
          ...withLog,
          currentJob: { jobId: ev.job_id ?? "", jobText: data.summary, priceWeight: state.config?.price_weight ?? 1 },
          tasks: {},
          taskOrder: [],
          stats: null,
          final: null,
          jobActive: true,
          incident: freshIncident(data, ev.t, ev.t),
        };
      }
      const incident = state.incident ?? freshIncident(data, ev.t, ev.t);
      return {
        ...withLog,
        incident: { ...incident, status: data.status, current: data, lastT: ev.t },
      };
    }
    case "responders_selected":
      return withIncident(withLog, ev.t, { responders: ev.data });
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

function freshIncident(data: IncidentStatusData, outageT: number | null, t: number): IncidentView {
  return {
    status: data.status,
    current: data,
    outageT,
    lastT: t,
    responders: null,
    repairs: [],
    approval: null,
    restored: null,
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
