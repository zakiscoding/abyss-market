import type { IncidentView } from "./reducer";

export interface CrewMember {
  id: string;
  name: string;
  role: string;
  state: string;
}

/** Include step owners paged after classification, as well as alerted responders. */
export function incidentCrew(incident: IncidentView | null, revision = false): CrewMember[] {
  if (!incident) return [];
  const people = new Map((incident.responders?.responders ?? [])
    .filter((person) => person.selected).map((person) => [person.responder_id, person]));
  const assignments = incident.assignments?.assignments ?? [];
  const roster = new Map<string, { name: string; role: string }>(people);
  for (const item of assignments) roster.set(item.responder_id, item);
  const approved = new Set(incident.restored?.approved_by ?? incident.granted?.approved_by ?? []);
  return [...roster].map(([id, person]) => {
    const needs = incident.approval?.approvers.includes(person.name);
    let state = revision && needs ? "Revision requested" : needs ? "Reviewing" : "Watching";
    if (incident.status === "restored" || incident.restored) {
      state = approved.has(person.name) ? "Approved"
        : assignments.some((item) => item.responder_id === id && !item.approval_required) ? "Customer update prepared"
        : id === "alex" ? "Recovery confirmed" : "Technical review complete";
    } else if (approved.has(person.name)) state = "Approved";
    else if (incident.status !== "awaiting_approval") state = "Alerted";
    return { id, name: person.name, role: person.role, state };
  });
}

export function incidentElapsed(incident: IncidentView | null, sinceLastEventMs = 0): number {
  if (incident?.restored) return incident.restored.mttr_ms;
  if (incident?.outageT == null) return 0;
  const active = !["healthy", "restored", "failed"].includes(incident.status);
  return Math.max(0, incident.lastT - incident.outageT + (active ? sinceLastEventMs : 0));
}
