import type { Domain } from "../../contract";
import type { MarketState } from "../../state/reducer";
import { seededDomain } from "./command";

export function alertBadge(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export function stallAlerts(state: MarketState, domain: Domain) {
  const incident = state.incident;
  const alerts = state.history
    .filter((item) => item.outcome === "failed" && item.domain === domain && item.jobId !== incident?.jobId)
    .map((item) => ({ id: item.jobId, service: item.service, message: "Escalated to humans", severity: item.severity }));
  if (incident && !["healthy", "restored"].includes(incident.status)
    && (incident.commander?.domain ?? seededDomain(incident.current.scenario_id)) === domain) {
    alerts.unshift({
      id: incident.jobId ?? "current",
      service: incident.current.service,
      message: incident.status === "awaiting_approval" ? "Waiting for human approval" : incident.current.summary,
      severity: incident.commander?.severity ?? incident.current.severity,
    });
  }
  return alerts;
}
