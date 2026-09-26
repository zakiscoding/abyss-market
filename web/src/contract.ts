// Abyss event contract v1 (+ v1.1 MAYDAY additions) — mirrored from SPEC.md §7.

export type AgentId = "haiku" | "sonnet" | "opus";
export type JobTaskType = "research" | "writing" | "checking";
export type IncidentTaskType = "diagnose" | "remediate" | "verify";
export type TaskType = JobTaskType | IncidentTaskType;
export type Purpose = "split" | "bid" | "work" | "review";

export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

export interface AgentSpec {
  agent_id: AgentId;
  display_name: string;
  model: string;
  color: string;
}

export type Reputation = Record<AgentId, Record<TaskType, number>>;

export interface TaskSpec {
  task_id: string;
  type: TaskType;
  title: string;
  brief: string;
  depends_on: string[];
}

export interface HelloData {
  agents: AgentSpec[];
  reputation: Reputation;
  config: {
    price_weight: number;
    rep_init: number;
    rep_alpha: number;
    task_types: TaskType[];
    real_models: boolean;
    fake_llm: boolean;
    orchestrator_model: string;
    reviewer_model: string;
  };
}

export interface JobSplitData {
  job_text: string;
  tasks: TaskSpec[];
  price_weight: number;
  usage: Usage;
}

export interface TaskPostedData extends TaskSpec {
  index: number;
  total: number;
  est_input_tokens: number;
}

export interface BidData {
  task_id: string;
  agent_id: AgentId;
  ok: boolean;
  error: string | null;
  predicted_output_tokens: number | null;
  est_input_tokens: number | null;
  predicted_cost_usd: number | null;
  eta_ms: number | null;
  promised_quality: number | null;
  pitch: string | null;
  reputation: number | null;
  score: number | null;
  usage: Usage | null;
}

export interface WonData {
  task_id: string;
  agent_id: AgentId;
  mode: "auction" | "fixed";
  score: number | null;
  runner_up_agent_id: AgentId | null;
  runner_up_score: number | null;
  scores: Partial<Record<AgentId, number>>;
  price_weight: number;
}

export interface WorkingData {
  task_id: string;
  agent_id: AgentId;
}

export interface DoneData {
  task_id: string;
  agent_id: AgentId;
  output: string;
  predicted_output_tokens: number | null;
  predicted_cost_usd: number | null;
  usage: Usage;
}

export interface GradedData {
  task_id: string;
  agent_id: AgentId;
  grade: number;
  promised_quality: number | null;
  rationale: string;
  usage: Usage;
}

export interface RepUpdateData {
  task_id: string;
  agent_id: AgentId;
  task_type: TaskType;
  old: number;
  new: number;
  ratio: number;
}

export interface StatsData {
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  by_purpose: Record<Purpose, { cost_usd: number; calls: number }>;
  by_agent: Record<
    AgentId,
    {
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      calls: number;
      tasks_won: number;
    }
  >;
}

export interface FinalTask {
  task_id: string;
  type: TaskType;
  agent_id: AgentId | null;
  grade: number | null;
  promised_quality: number | null;
  cost_usd: number;
}

export interface FinalData {
  status: "ok" | "partial" | "error";
  deliverable_task_id: string | null;
  deliverable: string | null;
  tasks: FinalTask[];
  total_cost_usd: number;
  mean_grade: number | null;
  duration_ms: number;
}

export interface ErrorData {
  message: string;
  task_id: string | null;
  fatal: boolean;
}

// ---------------------------------------------------------------- MAYDAY (v1.1)

export type IncidentState =
  | "healthy"
  | "outage"
  | "investigating"
  | "repairing"
  | "awaiting_approval"
  | "recovering"
  | "restored"
  | "failed";
export type Severity = "SEV-1" | "SEV-2" | "SEV-3";

export interface Telemetry {
  db_pool_size: number;
  db_pool_in_use: number;
  db_waiting: number;
  p95_latency_ms: number;
  error_rate: number;
  payment_success_rate: number;
  requests_per_min: number;
  timeouts_per_min: number;
}

export interface LogLine {
  level: "INFO" | "WARN" | "ERROR";
  source: string;
  message: string;
}

export interface ConfigChange {
  key: string;
  old: string;
  new: string;
  author: string;
  minutes_ago: number;
}

export interface IncidentStatusData {
  status: IncidentState;
  service: string;
  severity: Severity | null;
  headline: string;
  telemetry: Telemetry;
  logs: LogLine[];
  config_changes: ConfigChange[];
}

export interface Responder {
  responder_id: string;
  name: string;
  role: string;
  skills: string[];
  available: boolean;
  workload: number;
  score: number;
  selected: boolean;
  reason: string;
}

export interface Briefings {
  engineering: string;
  support: string;
  commander: string;
  leadership: string;
}

export interface RespondersSelectedData {
  severity: Severity;
  required_skills: string[];
  responders: Responder[];
  briefings: Briefings;
}

export interface RemediationAction {
  action: "set_db_pool_size" | "restart_service" | "rollback_config";
  value: number | null;
}

export interface RemediationProposedData {
  task_id: string;
  agent_id: AgentId;
  attempt: number;
  raw: string;
  valid: boolean;
  action: RemediationAction | null;
  rejection: string | null;
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface SandboxResultData {
  task_id: string;
  agent_id: AgentId;
  attempt: number;
  action: RemediationAction | null;
  passed: boolean;
  checks: Check[];
  telemetry: Telemetry;
}

export interface ApprovalRequiredData {
  task_id: string;
  agent_id: AgentId;
  attempt: number;
  action: RemediationAction;
  summary: string;
  approvers: string[];
}

export interface GradeSummary {
  task_id: string;
  type: TaskType;
  agent_id: AgentId;
  grade: number;
  promised_quality: number | null;
}

export interface RepChange {
  task_id: string;
  agent_id: AgentId;
  task_type: TaskType;
  old: number;
  new: number;
}

export interface ServiceRestoredData {
  mttr_ms: number;
  total_cost_usd: number;
  repair_attempts: number;
  failed_attempts: number;
  confidence: number;
  mean_grade: number;
  approved_by: string;
  action: RemediationAction;
  grades: GradeSummary[];
  rep_changes: RepChange[];
  verification: Check[];
  telemetry: Telemetry;
}

type Envelope<T extends string, D> = {
  v: 1;
  seq: number;
  t: number;
  job_id: string | null;
  type: T;
  data: D;
};

export type AbyssEvent =
  | Envelope<"hello", HelloData>
  | Envelope<"job_split", JobSplitData>
  | Envelope<"task_posted", TaskPostedData>
  | Envelope<"bid", BidData>
  | Envelope<"won", WonData>
  | Envelope<"working", WorkingData>
  | Envelope<"done", DoneData>
  | Envelope<"graded", GradedData>
  | Envelope<"rep_update", RepUpdateData>
  | Envelope<"stats", StatsData>
  | Envelope<"final", FinalData>
  | Envelope<"error", ErrorData>
  | Envelope<"incident_status", IncidentStatusData>
  | Envelope<"responders_selected", RespondersSelectedData>
  | Envelope<"remediation_proposed", RemediationProposedData>
  | Envelope<"sandbox_result", SandboxResultData>
  | Envelope<"approval_required", ApprovalRequiredData>
  | Envelope<"service_restored", ServiceRestoredData>;

export type ClientMsg =
  | { type: "start_job"; job: string; price_weight?: number }
  | { type: "reset" }
  | { type: "start_incident" }
  | { type: "approve_repair" }
  | { type: "reset_incident" };
