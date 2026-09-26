import type { IncidentView } from "../../state/reducer";
import { incidentElapsed } from "../../state/incident";
import { formatDuration } from "./derive";

export function IncidentTimer({ incident, sinceLastEventMs = 0 }: {
  incident: IncidentView | null;
  sinceLastEventMs?: number;
}) {
  return <div className="incident-timer" title="Elapsed recovery time for this simulation run">
    <small>{incident?.status === "restored" ? "MTTR" : "INCIDENT"}</small>
    <b>{formatDuration(incidentElapsed(incident, sinceLastEventMs))}</b>
  </div>;
}
