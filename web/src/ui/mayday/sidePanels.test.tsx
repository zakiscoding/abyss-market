import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import pool from "../../../public/fixtures/incident_payments_pool.json";
import ams from "../../../public/fixtures/incident_ams_db_outage.json";
import auth from "../../../public/fixtures/incident_auth_attack.json";
import network from "../../../public/fixtures/incident_network_partition.json";
import type { AbyssEvent } from "../../contract";
import { initialState, reduce } from "../../state/reducer";
import { EvidencePanel, evidenceData } from "./EvidencePanel";
import { LedgerPanel, auditTimeline, workflowTasks } from "./LedgerPanel";
import { CrewPanel } from "./CommandPanels";
import { terminal } from "./derive";

describe.each([pool, ams, auth, network].map((recording, index) => ({ events: recording as AbyssEvent[], index })))("side panels scenario $index", ({ events }) => {
  const play = (end = events.length) => events.slice(0, end).reduce(reduce, initialState);
  const complete = play();
  const standby = play(2);
  it("hides standby failure evidence and replaces it after triggering", () => {
    expect(evidenceData(standby)).toBeNull();
    expect(terminal(standby)).toEqual([]);
    expect(renderToStaticMarkup(<EvidencePanel state={standby} />)).toContain("Trigger an incident");
    const evidence = evidenceData(complete)!;
    expect(evidence.lines.length).toBeGreaterThan(0);
    expect(evidence.excerpts.length).toBeGreaterThan(0);
    expect(evidence.before.some((metric) => !metric.ok)).toBe(true);
    expect(evidence.after!.every((metric) => metric.ok)).toBe(true);
    const html = renderToStaticMarkup(<EvidencePanel state={complete} />);
    expect(html).toContain("Captain evidence");
    expect(html).toContain("Expand message");
    const reset = reduce(complete, events[1]);
    expect(evidenceData(reset)).toBeNull();
    expect(terminal(reset)).toEqual([]);
  });
  it("derives the task board and preserves raw events while deduplicating connection display", () => {
    expect(workflowTasks(standby)).toEqual([]);
    expect(workflowTasks(complete).every((task) => task.state === "Passed")).toBe(true);
    const failedIndex = events.findIndex((event) => event.type === "sandbox_result" && !event.data.passed);
    expect(workflowTasks(play(failedIndex + 1)).find((task) => task.label === "Validate remediation")?.state).toBe("Failed");
    const duplicate = [events[0], events[0], ...events.slice(1)];
    expect(auditTimeline(duplicate).filter((line) => line.label === "Connected to Abyss")).toHaveLength(1);
    expect(duplicate.length).toBe(events.length + 1);
    expect(auditTimeline(events).some((line) => line.label === "Recovery verified")).toBe(true);
    const html = renderToStaticMarkup(<LedgerPanel state={complete} replay />);
    expect(html).toContain("Model Market");
    expect(html).not.toContain("Agent stalls");
    expect(html).toContain("Developer details");
    expect(html).toContain("Unavailable: no working adapter; no calls made");
    expect(html).toContain("Historical validation rate (retained session)");
  });
  it("records notification states, explains unselected humans and clears notification on reset", () => {
    expect(complete.incident?.notification?.status).toBe("disabled");
    const html = renderToStaticMarkup(<CrewPanel state={complete} revision={false} />);
    for (const text of ["Human", "Why selected", "Why not selected", "Not alerted", "Review responsibility", "Approval state", "Final state", "Disabled"]) expect(html).toContain(text);
    expect(html).not.toContain("Watching");
    const notification = events.find((event) => event.type === "notification_status")!;
    for (const status of ["queued", "sent", "failed"] as const) {
      if (notification.type !== "notification_status") throw new Error("Missing notification");
      const updated = reduce(complete, { ...notification, data: { ...notification.data, status } });
      expect(updated.incident?.notification?.status).toBe(status);
      expect(renderToStaticMarkup(<CrewPanel state={updated} revision={false} />)).toContain(status[0].toUpperCase() + status.slice(1));
    }
    expect(reduce(complete, events[1]).incident?.notification).toBeNull();
  });
});
