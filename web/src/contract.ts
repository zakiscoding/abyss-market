// Abyss event contract v1 — mirrored from SPEC.md §7.

export type AgentId = "haiku" | "sonnet" | "opus";
export type JobTaskType = "research" | "writing" | "checking";
export type IncidentTaskType = "diagnose" | "remediate" | "verify";
export type TaskType = JobTaskType | IncidentTaskType;
export type Purpose = "split" | "bid" | "work" | "review";
export type Domain = "database" | "networking" | "security" | "payments" | "generalist";
export type ScenarioId = "payments_pool" | "ams_db_outage" | "auth_attack" | "network_partition";
export type Region = "ams" | "fra" | "iad" | "sin";
export type Severity = "SEV-1" | "SEV-2" | "SEV-3";
export type ActionName =
  | "set_db_pool_size"
  | "restart_service"
  | "rollback_config"
  | "restart_db"
  | "failover_db"
  | "route_traffic"
  | "apply_rate_limit"
  | "block_ips";
export type IncidentState =
  | "healthy"
  | "outage"
  | "investigating"
  | "repairing"
  | "awaiting_approval"
  | "recovering"
  | "restored"
  | "failed";

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

// Keys are job task types ("research") or "{domain}.{incident task type}" ("database.remediate").
export type Reputation = Record<AgentId, Record<string, number>>;

export interface ScenarioInfo {
  scenario_id: ScenarioId;
  name: string;
  service: string;
  region: Region;
  source_system: string;
  alert: string;
  allowed_actions: ActionName[];
}

export interface SpecialistInfo {
  specialist_id: string;
  domain: Domain;
  agent_id: AgentId;
  label: string;
}

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
    rep_keys: string[];
    domains: Domain[];
    specialists: SpecialistInfo[];
    scenarios: ScenarioInfo[];
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
  domain: Domain | null;
}

export interface BidData {
  task_id: string;
  agent_id: AgentId;
  ok: boolean;
  error: string | null;
  predicted_output_tokens: number | null;
  est_input_tokens: number | null;
  predicted_cost_usd: number | null;
  promised_quality: number | null;
  confidence: number | null;
  eta_ms: number | null;
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
  rep_key: string;
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

export interface Metric {
  key: string;
  label: string;
  value: number;
  unit: "ratio" | "ms" | "per_min" | "count" | "s";
  ok: boolean;
}

export type Telemetry = Metric[];

export interface ConfigChange {
  change_id: string;
  key: string;
  old: string;
  new: string;
  author: string;
  minutes_ago: number;
}

export interface IncidentStatusData {
  status: IncidentState;
  scenario_id: ScenarioId;
  service: string;
  region: Region;
  severity: Severity | null;
  summary: string;
  telemetry: Telemetry;
  logs: string[];
  config_changes: ConfigChange[];
}

export interface IncidentPackage {
  service: string;
  region: Region;
  source_system: string;
  alert: string;
  breached: Metric[];
  log_excerpt: string[];
  recent_changes: ConfigChange[];
}

export interface IncidentReceivedData {
  scenario_id: ScenarioId;
  name: string;
  service: string;
  region: Region;
  source_system: string;
  alert: string;
  allowed_actions: ActionName[];
  package: IncidentPackage;
  package_tokens_est: number;
  full_context_tokens_est: number;
}

export interface CommanderClassifiedData {
  scenario_id: ScenarioId;
  domain: Domain;
  secondary_domains: Domain[];
  severity: Severity;
  required_specialties: string[];
  rationale: string;
  source: "model" | "rules";
  fallback_reason: string | null;
  usage: Usage | null;
}

export interface DispatchedSpecialist extends SpecialistInfo {
  dispatched: boolean;
}

export interface SpecialistsDispatchedData {
  domain: Domain;
  registered: number;
  eligible: number;
  specialists: DispatchedSpecialist[];
  reason: string;
}

export interface Responder {
  responder_id: string;
  name: string;
  role: string;
  selected: boolean;
  score: number;
  matched_skills: string[];
  available: boolean;
  workload: number;
  reason: string;
}

export interface Briefings {
  engineering: string;
  support: string;
  commander: string;
  leadership: string;
}

export interface RespondersSelectedData {
  required_skills: string[];
  responders: Responder[];
  briefings: Briefings;
}

export interface RemediationAction {
  action: ActionName;
  value: number | null;
  region: Region | null;
  ips: string[] | null;
}

export interface RemediationProposedData {
  task_id: string;
  agent_id: AgentId;
  attempt: number;
  steps: RemediationAction[];
  accepted: boolean;
  reason: string;
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
  steps: RemediationAction[];
  passed: boolean;
  checks: Check[];
  telemetry: Telemetry;
}

export interface PlanStep {
  index: number;
  action: RemediationAction;
  description: string;
  owner_domain: Domain;
}

export interface RemediationPlanData {
  task_id: string;
  agent_id: AgentId;
  attempt: number;
  steps: PlanStep[];
  summary: string;
  confidence: number;
}

export interface Assignment {
  assignment_id: string;
  step_index: number | null;
  action: RemediationAction | null;
  description: string;
  responder_id: string;
  name: string;
  role: string;
  reason: string;
  approval_required: boolean;
  status: "pending" | "notify";
}

export interface HumanAssignmentsData {
  task_id: string;
  assignments: Assignment[];
  required_approvers: string[];
}

export interface ApprovalRequiredData {
  task_id: string;
  agent_id: AgentId;
  attempt: number;
  steps: RemediationAction[];
  summary: string;
  approvers: string[];
}

export interface NotificationStatusData {
  channel: "discord";
  status: "queued" | "sent" | "failed" | "disabled";
  recipients: ("Zak" | "Maya" | "Riley" | "Sam" | "Alex" | "Jordan")[];
}

export interface ApprovalGrantedData {
  task_id: string;
  approved: string[];
  approved_by: string[];
}

export interface IncidentEscalatedData {
  reason: string;
  attempts: number;
  escalated_to: string[];
}

export interface RoutingStatsData {
  domain: Domain;
  registered_specialists: number;
  eligible_specialists: number;
  auctions: number;
  models_contacted: number;
  models_skipped: number;
  actual_input_tokens: number;
  actual_output_tokens: number;
  actual_cost_usd: number;
  actual_calls: number;
  commander_package_tokens_est: number;
  full_context_tokens_est: number;
  avoided_input_tokens_est: number;
  avoided_cost_usd_est: number;
  method: string;
}

export interface RepChange {
  agent_id: AgentId;
  task_type: TaskType;
  rep_key: string;
  old: number;
  new: number;
}

export interface ServiceRestoredData {
  scenario_id: ScenarioId;
  domain: Domain;
  mttr_ms: number;
  total_cost_usd: number;
  repair_attempts: number;
  failed_attempts: number;
  steps: RemediationAction[];
  confidence: number;
  approved_by: string[];
  verification: Check[];
  grades: FinalTask[];
  rep_changes: RepChange[];
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
  | Envelope<"incident_received", IncidentReceivedData>
  | Envelope<"commander_classified", CommanderClassifiedData>
  | Envelope<"specialists_dispatched", SpecialistsDispatchedData>
  | Envelope<"responders_selected", RespondersSelectedData>
  | Envelope<"remediation_proposed", RemediationProposedData>
  | Envelope<"sandbox_result", SandboxResultData>
  | Envelope<"remediation_plan_created", RemediationPlanData>
  | Envelope<"human_assignments_created", HumanAssignmentsData>
  | Envelope<"approval_required", ApprovalRequiredData>
  | Envelope<"approval_granted", ApprovalGrantedData>
  | Envelope<"notification_status", NotificationStatusData>
  | Envelope<"incident_escalated", IncidentEscalatedData>
  | Envelope<"service_restored", ServiceRestoredData>
  | Envelope<"routing_stats", RoutingStatsData>;

export type ClientMsg =
  | { type: "start_job"; job: string; price_weight?: number }
  | { type: "reset" }
  | { type: "start_incident"; scenario_id?: ScenarioId; price_weight?: number }
  | { type: "approve_repair" }
  | { type: "reset_incident" };

// Mirrors describe_action / describe_plan in backend/abyss/incident.py.
export function describeAction(step: RemediationAction): string {
  if (step.value !== null) return `${step.action}(${step.value})`;
  if (step.region !== null) return `${step.action}(${step.region})`;
  if (step.ips && step.ips.length) {
    const extra = step.ips.length > 1 ? `, +${step.ips.length - 1}` : "";
    return `${step.action}(${step.ips[0]}${extra})`;
  }
  return step.action;
}

export function describePlan(steps: RemediationAction[]): string {
  return steps.map(describeAction).join(" + ");
}

export function metricValue(telemetry: Telemetry, key: string): number | undefined {
  return telemetry.find((m) => m.key === key)?.value;
}

export function formatMetric(m: Metric): string {
  switch (m.unit) {
    case "ratio":
      return `${(m.value * 100).toFixed(m.value < 0.1 ? 1 : 0)}%`;
    case "ms":
      return `${Math.round(m.value)} ms`;
    case "per_min":
      return `${Math.round(m.value).toLocaleString("en-US")}/min`;
    case "s":
      return `${m.value.toFixed(1)} s`;
    default:
      return `${m.value}`;
  }
}
