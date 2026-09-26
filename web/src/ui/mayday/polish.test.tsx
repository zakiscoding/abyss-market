import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import pool from "../../../public/fixtures/incident_payments_pool.json";
import ams from "../../../public/fixtures/incident_ams_db_outage.json";
import auth from "../../../public/fixtures/incident_auth_attack.json";
import network from "../../../public/fixtures/incident_network_partition.json";
import type { AbyssEvent } from "../../contract";
import { initialState, reduce } from "../../state/reducer";
import { incidentCrew, incidentElapsed } from "../../state/incident";
import { captainReadout, incidentChat } from "./command";
import { CrewPanel } from "./CommandPanels";
import { HistoryPanel, Inbox } from "./panels";
import { IncidentTimer } from "./IncidentTimer";
import { HARBOR_STALLS, specialtyState } from "./harborView";

const recordings = [pool, ams, auth, network] as AbyssEvent[][];
const roles: Record<string, string> = {
  Zak: "Incident Commander", Maya: "Database Engineer", Riley: "Network Engineer",
  Sam: "Security Engineer", Alex: "Payments Engineer", Jordan: "Customer Support Lead",
};

describe.each(recordings.map((events) => ({
  events, scenario: events.find((event) => event.type === "incident_received")!.data.scenario_id,
})))("final polish: $scenario", ({ events, scenario }) => {
  const complete = events.reduce(reduce, initialState);
  const reset = events.find((event) => event.type === "incident_status" && event.data.status === "healthy")!;
  const received = events.find((event) => event.type === "incident_received")!;

  it("keeps active timing, freezes recorded MTTR, and resets without losing history", () => {
    const end = events.findIndex((event) => event.type === "approval_required");
    const active = events.slice(0, end + 1).reduce(reduce, initialState);
    expect(active.incident?.outageT).toBe(received.t);
    expect(incidentElapsed(active.incident, 1250)).toBe(active.incident!.lastT - received.t + 1250);
    expect(renderToStaticMarkup(<IncidentTimer incident={active.incident} />)).not.toContain("00:00");
    const mttr = complete.incident!.restored!.mttr_ms;
    expect(incidentElapsed(complete.incident, 999999)).toBe(mttr);
    // Completion is authoritative even if an older feed lacks outage timing.
    expect(incidentElapsed({ ...complete.incident!, outageT: null })).toBe(mttr);
    expect(renderToStaticMarkup(<IncidentTimer incident={complete.incident} />)).toContain("01:09");
    expect(complete.history[0].mttrMs).toBe(mttr);
    const cleared = reduce(complete, reset);
    expect(incidentElapsed(cleared.incident)).toBe(0);
    expect(renderToStaticMarkup(<IncidentTimer incident={cleared.incident} />)).toContain("00:00");
    expect(cleared.history).toEqual(complete.history);
    const started = reduce(complete, { ...received, job_id: "new-run" });
    expect(incidentElapsed(started.incident)).toBe(0);
    const rerun = events.map((event) => ({ ...event, job_id: event.job_id ? "new-run" : null })).reduce(reduce, cleared);
    expect(rerun.history).toHaveLength(2);
    expect(rerun.history[1]).toEqual(complete.history[0]);
  });

  it("derives outcome, worker, approval, timing and cost from the completed events", () => {
    const summary = captainReadout(complete).text;
    expect(summary).toContain(complete.incident!.received!.name);
    expect(summary).toContain(`Root cause: ${complete.incident!.restored!.domain}`);
    expect(summary).toContain("Claude");
    expect(summary).toContain("Applied to simulated cluster");
    expect(summary).toContain("Deterministic sandbox passed; recovery checks passed");
    for (const name of complete.incident!.restored!.approved_by) expect(summary).toContain(name);
    expect(summary).toContain("MTTR 01:09");
    expect(summary).toContain("Simulated cost");
    const changed = { ...complete, incident: { ...complete.incident!, restored: {
      ...complete.incident!.restored!, mttr_ms: 125000, total_cost_usd: 0.1234,
      verification: [{ name: "test", detail: "test", passed: false }],
    } } };
    expect(captainReadout(changed, "Actual AI cost").text).toContain("MTTR 02:05; Actual AI cost: $0.1234");
    expect(captainReadout(changed).text).toContain("recovery checks need attention");
  });

  it("uses the same final crew states in components, history and chat", () => {
    const crew = incidentCrew(complete.incident);
    expect(crew.length).toBeGreaterThan(0);
    expect(complete.history[0].crew).toEqual(crew);
    const panel = renderToStaticMarkup(<CrewPanel state={complete} revision={false} />);
    const history = renderToStaticMarkup(<HistoryPanel history={complete.history} />);
    for (const person of crew) {
      expect(person.role).toBe(roles[person.name]);
      expect(["Approved", "Technical review complete", "Recovery confirmed", "Customer update prepared", "Not required"]).toContain(person.state);
      expect(panel).toContain(person.state);
      expect(history).toContain(`${person.name}: ${person.state}`);
    }
    expect(incidentChat(complete).some((line) => /watching|reviewing/i.test(line.text))).toBe(false);
    if (scenario === "payments_pool") {
      expect(crew.map((person) => person.name).sort()).toEqual(["Alex", "Jordan", "Maya", "Zak"]);
      expect(crew.find((person) => person.name === "Alex")?.state).toBe("Recovery confirmed");
      expect(crew.find((person) => person.name === "Jordan")?.state).toBe("Customer update prepared");
    }
  });

  it("offers a new simulation run and preserves one primary specialty", () => {
    const html = renderToStaticMarkup(<Inbox state={complete} canTrigger pending={null} onTrigger={() => {}} />);
    expect(html).toContain("Run again");
    expect(html).toContain("Start a new simulation run; previous results stay in history");
    const views = HARBOR_STALLS.map((stall) => specialtyState(complete, stall.domain));
    expect(views.filter((view) => view.primary)).toHaveLength(1);
    expect(views.filter((view) => view.label === "RESTORED")).toHaveLength(1);
    if (scenario === "payments_pool") expect(specialtyState(complete, "payments").label).toBe("RECOVERY CONFIRMED");
    else if (scenario !== "ams_db_outage") expect(views.filter((view) => view.kind !== "idle")).toHaveLength(1);
  });
});
