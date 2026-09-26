import type { Domain } from "../../contract";
import type { MarketState } from "../../state/reducer";

export const HARBOR_STALLS: { domain: Domain; title: string; x: number; color: string }[] = [
  { domain: "database", title: "Database Repair", x: 12.7, color: "#69b4ef" },
  { domain: "payments", title: "Payments Operations", x: 31.9, color: "#edbe52" },
  { domain: "networking", title: "Network Routing", x: 50.3, color: "#ee8782" },
  { domain: "generalist", title: "General Repair", x: 68.3, color: "#69d5c4" },
  { domain: "security", title: "Security Watch", x: 87.5, color: "#c79cee" },
];

export function specialtyState(state: MarketState, domain: Domain) {
  const incident = state.incident;
  if (!incident?.commander || incident.status === "healthy") return { kind: "idle", label: "IDLE", primary: false };
  const primary = incident.commander.domain === domain;
  const affected = !primary && (incident.commander.secondary_domains.includes(domain)
    || (domain === "payments" && incident.current.scenario_id === "payments_pool"));
  if (incident.status === "restored" && (primary || affected)) return { kind: "restored", label: "RESTORED", primary };
  if (primary) return { kind: "active", label: "ACTIVE · ROOT CAUSE", primary };
  if (affected) return { kind: "monitoring", label: "MONITORING · AFFECTED SERVICE", primary: false };
  return { kind: "idle", label: "IDLE", primary: false };
}

export function sandboxState(state: MarketState) {
  const incident = state.incident;
  const last = incident?.repairs.at(-1);
  if (incident?.status === "restored") return { kind: "applied", label: "Applied ✓", detail: "Recovery checks passed" };
  if (last?.sandbox) return last.sandbox.passed
    ? { kind: "passed", label: "Passed", detail: "Ready for human review" }
    : { kind: "rejected", label: "Rejected", detail: "Plan needs revision" };
  if (last) return { kind: "testing", label: "Testing", detail: "Checking isolated copy" };
  return { kind: "waiting", label: "Waiting", detail: "No plan submitted" };
}

export function validationReadout(state: MarketState): string {
  const incident = state.incident;
  if (!incident || incident.status === "healthy") return "Awaiting an incident. No cluster changes have been made.";
  if (incident.status === "restored") return "Applied to simulated cluster. Deterministic recovery checks passed.";
  if (incident.status === "awaiting_approval") return `Sandbox passed. Waiting for ${incident.approval?.approvers.join(", ") ?? "human approval"}.`;
  if (incident.status === "recovering") return "Approval recorded. Verifying the simulated cluster.";
  if (incident.status === "failed") return "Escalated to the human crew.";
  return `${sandboxState(state).label}: ${sandboxState(state).detail}.`;
}
