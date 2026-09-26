import { describe, expect, it } from "vitest";
import recording from "../../../public/fixtures/incident_ams_db_outage.json";
import type { AbyssEvent } from "../../contract";
import { initialState, reduce } from "../../state/reducer";
import { alertBadge, stallAlerts } from "./alerts";

const events = recording as AbyssEvent[];
const awaiting = events.slice(0, events.findIndex((event) => event.type === "approval_required") + 1).reduce(reduce, initialState);
const finished = events.reduce(reduce, initialState);

describe("stall alerts", () => {
  it("counts incidents rather than repeated telemetry events and clears on recovery", () => {
    expect(stallAlerts(initialState, "database")).toHaveLength(0);
    expect(stallAlerts(awaiting, "database")).toHaveLength(1);
    expect(stallAlerts(awaiting, "security")).toHaveLength(0);
    expect(stallAlerts(finished, "database")).toHaveLength(0);
  });

  it("keeps escalated incidents visible without counting the current incident twice", () => {
    const failed = { ...finished.history[0], outcome: "failed" as const };
    const state = { ...awaiting, history: [failed] };
    expect(stallAlerts(state, "database")).toHaveLength(1);
    state.history.push({ ...failed, jobId: "earlier-incident" });
    expect(stallAlerts(state, "database")).toHaveLength(2);
  });

  it("caps larger counts at 9+ while retaining every alert in the details", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ ...finished.history[0], jobId: `failed-${i}`, outcome: "failed" as const }));
    const alerts = stallAlerts({ ...initialState, history }, "database");
    expect(alerts).toHaveLength(12);
    expect(alertBadge(alerts.length)).toBe("9+");
    expect(alertBadge(1)).toBe("1");
    expect(alertBadge(9)).toBe("9");
  });
});
