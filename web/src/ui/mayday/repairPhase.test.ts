import { describe, expect, it } from "vitest";
import recording from "../../../public/fixtures/incident_ams_db_outage.json";
import type { AbyssEvent } from "../../contract";
import { initialState, reduce } from "../../state/reducer";
import { repairShot } from "./repairPhase";

const events = recording as AbyssEvent[];
describe("consistent repair presentation", () => {
  it("shows sandbox results as soon as they arrive and keeps approval accessible", () => {
    let state = initialState;
    const seen = new Set<string | null>();
    for (const event of events) {
      state = reduce(state, event);
      const phase = repairShot(state);
      seen.add(phase);
      if (event.type === "sandbox_result") expect(phase).toBe(event.data.passed ? "validated" : "retry");
      if (state.incident?.status === "awaiting_approval") expect(phase).toBeNull();
      if (state.incident?.status === "restored") expect(phase).toBe("restored");
    }
    expect(seen.has("selecting")).toBe(true);
    expect(seen.has("diagnosing")).toBe(true);
    expect(seen.has("preparing")).toBe(true);
    expect(seen.has("validated")).toBe(true);
    expect(seen.has("retry")).toBe(true);
  });
});
