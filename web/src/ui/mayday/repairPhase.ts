import type { MarketState } from "../../state/reducer";
import { currentTask } from "../../scene/model";

export type RepairPhase = "selecting" | "diagnosing" | "preparing" | "sandbox" | "validated" | "retry" | "deploying" | "restored" | "failed";

export function repairShot(state: MarketState): RepairPhase | null {
  const incident = state.incident;
  if (!incident) return null;
  if (incident.status === "restored" || incident.status === "failed") return incident.status;
  if (incident.status === "recovering") return "deploying";
  if (!["investigating", "repairing"].includes(incident.status)) return null;
  const task = currentTask(state);
  if (!task || task.status === "open" || task.status === "pending") return "selecting";
  if (incident.status === "investigating") return "diagnosing";
  const attempt = incident.repairs.at(-1);
  if (!attempt || attempt.proposal.task_id !== task.task_id) return "preparing";
  if (!attempt.sandbox) return "sandbox";
  return attempt.sandbox.passed ? "validated" : "retry";
}

export const REPAIR_COPY: Record<RepairPhase, { chapter: string; title: string; detail: string; action: string }> = {
  selecting: { chapter: "MODEL SELECTION", title: "Fishing for the right model", detail: "Specialists bid on price and quality. Reputation helps decide the winner.", action: "Casting for bids" },
  diagnosing: { chapter: "INVESTIGATION", title: "Finding the cause", detail: "The selected specialist is investigating the incident evidence.", action: "Investigating" },
  preparing: { chapter: "REPAIR PLAN", title: "Preparing the repair", detail: "The selected specialist is building an allowlisted remediation plan.", action: "Preparing the plan" },
  sandbox: { chapter: "VALIDATION", title: "Testing the repair", detail: "The proposed plan is being checked in an isolated sandbox.", action: "Testing in sandbox" },
  validated: { chapter: "VALIDATION", title: "Sandbox passed", detail: "The repair passed validation. Preparing the plan for human review.", action: "Ready for review" },
  retry: { chapter: "REVISION", title: "Reworking the plan", detail: "The sandbox rejected this attempt. Production has not been changed.", action: "Revising the plan" },
  deploying: { chapter: "EXECUTION", title: "Repair in motion", detail: "Human approval received. Applying the plan and verifying recovery.", action: "Verifying recovery" },
  restored: { chapter: "RECOVERY", title: "Service restored", detail: "Recovery checks passed for this service.", action: "Repair verified" },
  failed: { chapter: "HUMAN HANDOFF", title: "Your crew takes over", detail: "The incident has been escalated for human attention.", action: "Handing off to crew" },
};
