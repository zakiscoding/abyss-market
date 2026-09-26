import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../public/fixtures/mayday_run.json";
import type { AbyssEvent } from "../contract";
import { FixtureSource } from "../sources/fixture";
import { initialState, reduce, type MarketState } from "../state/reducer";
import { harborModel, outcome, pipeline, terminalLines } from "./model";

const events = fixture as AbyssEvent[];

function upTo(predicate: (ev: AbyssEvent) => boolean): MarketState {
  const end = events.findIndex(predicate);
  return events.slice(0, end + 1).reduce(reduce, initialState);
}

const stageStates = (state: MarketState) => Object.fromEntries(pipeline(state).map((s) => [s.key, s.state]));

describe("MAYDAY reducer", () => {
  it("reduces the incident fixture to a restored service", () => {
    const state = events.reduce(reduce, initialState);
    expect(state.incident.status).toBe("restored");
    expect(state.taskOrder).toEqual(["t1", "t2", "t3", "t4"]);
    expect(state.tasks.t2.type).toBe("remediate");
    expect(state.incident.repairs.map((r) => r.sandbox?.passed)).toEqual([false, true]);
    expect(state.incident.team?.responders.filter((r) => r.selected).map((r) => r.role)).toEqual([
      "Incident Commander",
      "Database Engineer",
      "Backend Engineer",
      "Customer Support",
    ]);
    expect(state.incident.history.map((h) => h.status)).toEqual([
      "outage", "investigating", "repairing", "awaiting_approval", "recovering", "restored",
    ]);
    expect(state.jobActive).toBe(false);
  });

  it("a healthy status clears the previous incident", () => {
    const done = events.reduce(reduce, initialState);
    const healthy = events.find((ev) => ev.type === "incident_status" && ev.data.status === "healthy")!;
    const reset = reduce(done, healthy);
    expect(reset.incident.status).toBe("healthy");
    expect(reset.incident.repairs).toEqual([]);
    expect(reset.taskOrder).toEqual([]);
    expect(reset.final).toBeNull();
  });
});

describe("MAYDAY pipeline", () => {
  it("shows the first sandbox rejection", () => {
    const state = upTo((ev) => ev.type === "sandbox_result");
    expect(stageStates(state)).toMatchObject({ diagnose: "done", remediate: "active", sandbox: "failed", approve: "todo" });
    expect(harborModel(state).sandbox).toBe("fail");
    expect(terminalLines(state).some((l) => l.text.startsWith("sandbox REJECTED restart_service"))).toBe(true);
  });

  it("waits for a human after the sandbox passes", () => {
    const state = upTo((ev) => ev.type === "approval_required");
    expect(stageStates(state)).toMatchObject({ remediate: "done", sandbox: "done", approve: "active", deploy: "todo" });
    expect(state.incident.approval?.action).toEqual({ action: "set_db_pool_size", value: 20 });
    expect(harborModel(state).platform).toBe("down");
  });

  it("finishes with every stage done", () => {
    const state = events.reduce(reduce, initialState);
    expect(Object.values(stageStates(state))).toEqual(["done", "done", "done", "done", "done"]);
    expect(harborModel(state).platform).toBe("restored");
    expect(harborModel(state).mood).toBe("restored");
  });
});

describe("MAYDAY outcome", () => {
  it("derives every metric from events", () => {
    const state = events.reduce(reduce, initialState);
    const o = outcome(state);
    const restored = state.incident.restored!;
    expect(o.cost).toBe(state.final!.total_cost_usd);
    expect(o.cost).toBe(restored.total_cost_usd);
    expect(o.attempts).toBe(restored.repair_attempts);
    expect(o.rejected).toBe(restored.failed_attempts);
    expect(o.mttrMs).toBe(restored.mttr_ms);
    const winningBid = state.tasks.t3.bids[state.tasks.t3.winner!]!;
    expect(o.confidence).toBe(winningBid.promised_quality! / 10);
    expect(o.grades.map((g) => g.grade)).toEqual(restored.grades.map((g) => g.grade));
    const failedRep = o.repChanges.find((r) => r.task_id === "t2")!;
    expect(failedRep.new).toBeLessThan(failedRep.old);
  });

  it("shows reputation changes live, before the incident is restored", () => {
    const state = upTo((ev) => ev.type === "approval_required");
    expect(outcome(state).repChanges.map((r) => r.task_id)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("interactive fixture replay", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pauses for Break Production and Approve Repair", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => events }));
    const seen: AbyssEvent[] = [];
    const source = new FixtureSource("/fixtures/mayday_run.json", 10_000, true);
    source.start((ev) => seen.push(ev));
    const lastType = () => seen[seen.length - 1]?.type;
    const until = async (type: string) => {
      for (let i = 0; i < 200 && lastType() !== type; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Give a gated replay the chance to (wrongly) run past this point.
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    await until("incident_status");
    expect(seen.map((ev) => ev.type)).toEqual(["hello", "incident_status"]);
    expect(source.send({ type: "approve_repair" })).toBe(false);

    expect(source.send({ type: "start_incident" })).toBe(true);
    await until("approval_required");
    expect(lastType()).toBe("approval_required");

    expect(source.send({ type: "approve_repair" })).toBe(true);
    await until("final");
    expect(lastType()).toBe("final");
    expect(seen).toHaveLength(events.length);
    source.stop();
  });
});
