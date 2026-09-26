export type AgentId = 'haiku' | 'sonnet' | 'opus';
export type TaskType = 'research' | 'writing' | 'checking';

export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

export interface Envelope {
  v: number;
  seq: number;
  t: number;
  job_id: string | null;
  type: string;
  data: any;
}

export interface TaskSpec {
  task_id: string;
  type: TaskType;
  title: string;
  brief: string;
  depends_on: string[];
}

export interface BidData {
  task_id: string;
  agent_id: AgentId;
  ok: boolean;
  error: string | null;
  predicted_output_tokens: number | null;
  predicted_cost_usd: number | null;
  promised_quality: number | null;
  pitch: string | null;
  reputation: number | null;
  score: number | null;
}

export interface WonData {
  task_id: string;
  agent_id: AgentId;
  score: number | null;
  runner_up_agent_id: AgentId | null;
  runner_up_score: number | null;
}

export interface DoneData {
  task_id: string;
  agent_id: AgentId;
  output: string;
  predicted_output_tokens: number | null;
  usage: Usage;
}

export interface GradedData {
  task_id: string;
  agent_id: AgentId;
  grade: number;
  promised_quality: number | null;
  rationale: string;
}

export interface RepUpdateData {
  agent_id: AgentId;
  task_type: TaskType;
  old: number;
  new: number;
}

export interface FinalData {
  status: string;
  deliverable_task_id: string | null;
  deliverable: string | null;
  tasks: { task_id: string; type: TaskType; agent_id: AgentId | null; grade: number | null; promised_quality: number | null; cost_usd: number }[];
  total_cost_usd: number;
  mean_grade: number | null;
}
