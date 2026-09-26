import { describe, expect, it } from "vitest";
import recording from "../../../public/fixtures/incident_payments_pool.json";
import type { AbyssEvent } from "../../contract";
import { initialState, reduce } from "../../state/reducer";
import { HARBOR_STALLS, specialtyState, sandboxState } from "./harborView";
import { captainReadout } from "./command";
import { pipeline } from "./derive";

const events = recording as AbyssEvent[];
const upTo = (type: AbyssEvent["type"]) => events.slice(0, events.findIndex((event) => event.type === type) + 1).reduce(reduce, initialState);
describe("five-stall harbor presentation", () => {
  it("uses five distinct specialty buildings in the requested order", () => {
    expect(HARBOR_STALLS.map((stall) => stall.title)).toEqual(["Database Repair", "Payments Operations", "Network Routing", "General Repair", "Security Watch"]);
    expect(new Set(HARBOR_STALLS.map((stall) => stall.x)).size).toBe(5);
  });
  it("separates Payments impact from database remediation without choosing a second worker", () => {
    const state = upTo("approval_required");
    expect(specialtyState(state, "database").label).toBe("ACTIVE · ROOT CAUSE");
    expect(specialtyState(state, "payments")).toEqual({ kind: "monitoring", label: "MONITORING · AFFECTED SERVICE", primary: false });
    for (const domain of ["networking", "generalist", "security"] as const) expect(specialtyState(state, domain).label).toBe("IDLE");
    expect(captainReadout(state).text).toBe("Payments API is affected, but the root cause is database connection-pool exhaustion. Routing remediation to Database Repair while Payments Operations monitors recovery.");
  });
  it("derives sandbox and restored states exclusively from the recording", () => {
    expect(sandboxState(initialState).kind).toBe("waiting");
    expect(sandboxState(upTo("remediation_proposed")).kind).toBe("testing");
    expect(sandboxState(upTo("sandbox_result")).kind).toBe("rejected");
    expect(sandboxState(upTo("approval_required")).kind).toBe("passed");
    const restored = events.reduce(reduce, initialState);
    expect(sandboxState(restored).kind).toBe("applied");
    expect(specialtyState(restored, "database").kind).toBe("restored");
    expect(specialtyState(restored, "payments").kind).toBe("restored");
    expect(pipeline(restored).map((stage) => stage.label)).toEqual(["Detected", "Classified", "Worker selected", "Sandbox", "Human review", "Restored"]);
    expect(pipeline(restored).every((stage) => stage.state === "done")).toBe(true);
  });
});
