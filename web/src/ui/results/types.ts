// Shape of experiments/results/<stamp>.json written by backend/abyss/experiment.py.
import type { AgentId, JobTaskType } from "../../contract";

export interface ArmResult {
  arm: string;
  price_weight: number | null;
  fixed_agent_id: AgentId | null;
  total_usd: number;
  work_usd: number;
  bid_usd: number;
  review_usd: number;
  mean_grade: number | null;
  graded_tasks: number;
  failed_tasks: number;
  usd_per_grade_point: number | null;
  wins: Record<AgentId, Record<JobTaskType, number>>;
  rep_final: Record<AgentId, Record<JobTaskType, number>> | null;
  per_job: { job_idx: number; job_id: string; status: string; grade_mean: number | null; cost_usd: number }[];
}

export interface ExperimentResults {
  created_utc: string;
  config: {
    real_models: boolean;
    fake_llm: boolean;
    agents: Record<AgentId, string>;
    orchestrator_model: string;
    reviewer_model: string;
    rep_alpha: number;
  };
  jobs: string[];
  split_usd: number;
  split_calls: number;
  arms: ArmResult[];
}

export const AGENT_IDS: AgentId[] = ["haiku", "sonnet", "opus"];
export const TASK_TYPES: JobTaskType[] = ["research", "writing", "checking"];

// Identity colors: market arms share one hue; fixed arms wear their agent's color
// (same entity → same color as the market scene).
export const MARKET_COLOR = "#f0cb68";
export const AGENT_COLOR: Record<AgentId, string> = { haiku: "#4fb3a9", sonnet: "#e8a33d", opus: "#8e6cc9" };

export function armColor(arm: ArmResult): string {
  return arm.fixed_agent_id ? AGENT_COLOR[arm.fixed_agent_id] : MARKET_COLOR;
}

export const INK = { primary: "#ecf4e8", secondary: "#b9ccd3", muted: "#6f919f", grid: "#223e4f" };
