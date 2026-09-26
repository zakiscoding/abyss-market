import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../../public/fixtures/mayday_run.json";
import type { AbyssEvent } from "../../contract";
import { harborModel } from "../../scene/harbor/model";
import { FixtureSource } from "../../sources/fixture";
import { initialState, reduce, type MarketState } from "../../state/reducer";
import { outcome, pipeline, terminal } from "./derive";

const events = fixture as AbyssEvent[];

function upTo(predicate: (event: AbyssEvent) => boolean): MarketState {
  const end = events.findIndex(predicate);
  return events.slice(0, end + 1).reduce(reduce, initialState);
}

const final = () => events.reduce(reduce, initialState);

describe("MAYDAY reducer", () => {
  it("reduces the recorded incident to a restored service", () => {
    const state = final();
    const restored = events.find((e) => e.type === "service_restored")!;
    expect(state.incident?.status).toBe("restored");
    expect(state.taskOrder).toEqual(["t1", "t2", "t3", "t4"]);
    expect(state.tasks.t2.type).toBe("remediate");
    expect(state.incident?.repairs.map((r) => r.sandbox?.passed)).toEqual([false, true]);
    expect(state.incident?.responders?.responders.filter((r) => r.selected).map((r) => r.name)).toEqual([
      "Zak", "Maya", "Alex", "Jordan",
    ]);
    expect(state.incident?.restored).toEqual(restored.data);
    expect(state.jobActive).toBe(false);
  });

  it("a healthy status after an incident clears the board but keeps reputation", () => {
    const done = final();
    const healthy = events[1];
    const reset = reduce(done, { ...healthy, seq: 999 });
    expect(reset.incident?.status).toBe("healthy");
    expect(reset.taskOrder).toEqual([]);
    expect(reset.final).toBeNull();
    expect(reset.agents).toEqual(done.agents);
  });
});

describe("MAYDAY selectors", () => {
  it("pipeline waits on the human at approval time", () => {
    const state = upTo((e) => e.type === "approval_required");
    expect(Object.fromEntries(pipeline(state).map((s) => [s.key, s.state]))).toEqual({
      diagnose: "done", remediate: "done", sandbox: "done", approve: "active", deploy: "pending",
    });
    expect(harborModel(state).mood).toBe("alarm");
  });

  it("pipeline is complete after recovery", () => {
    expect(pipeline(final()).every((s) => s.state === "done")).toBe(true);
  });

  it("shows the rejected sandbox run", () => {
    const state = upTo((e) => e.type === "sandbox_result");
    expect(pipeline(state).find((s) => s.key === "sandbox")?.state).toBe("failed");
    expect(harborModel(state).sandbox).toBe("fail");
    expect(terminal(state).some((line) => line.tone === "fail" && line.text.includes("sandbox FAIL"))).toBe(true);
  });

  it("metrics are read from events, not constants", () => {
    const state = final();
    const result = outcome(state);
    const lastStats = [...events].reverse().find((e) => e.type === "stats")!;
    const restored = events.find((e) => e.type === "service_restored")!;
    if (lastStats.type !== "stats" || restored.type !== "service_restored") throw new Error("fixture shape");
    expect(result.aiCost).toBe(lastStats.data.total_cost_usd);
    expect(result.confidence).toBe(restored.data.confidence);
    expect(result.attempts).toBe(2);
    expect(result.failedAttempts).toBe(1);
    expect(result.repChanges).toHaveLength(4);
  });

  it("harbor dispatches only the paged humans", () => {
    const state = upTo((e) => e.type === "approval_required");
    const humans = harborModel(state).boats.filter((b) => b.kind === "human");
    expect(humans.filter((b) => b.berth === "platform").map((b) => b.id)).toEqual(["zak", "maya", "alex", "jordan"]);
    expect(humans.find((b) => b.id === "sam")?.berth).toBe("dock");
    expect(harborModel(final()).mood).toBe("restored");
  });
});

describe("FixtureSource gates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pauses for Break Production and Approve Repair", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => events }));
    const seen: AbyssEvent[] = [];
    const source = new FixtureSource("/fixtures/mayday_run.json", 1e6);
    source.start((event) => seen.push(event));
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    };

    await until(() => source.pausedAt !== null);
    expect(seen.map((e) => e.type)).toEqual(["hello", "incident_status"]);
    expect(source.pausedAt).toBe("start_incident");
    expect(source.send({ type: "approve_repair" })).toBe(false);

    expect(source.send({ type: "start_incident" })).toBe(true);
    await until(() => source.pausedAt === "approve_repair");
    expect(seen.at(-1)?.type).toBe("approval_required");
    expect(source.pausedAt).toBe("approve_repair");

    source.send({ type: "approve_repair" });
    await until(() => seen.at(-1)?.type === "final");
    expect(seen.at(-1)?.type).toBe("final");
    expect(seen).toHaveLength(events.length);

    source.send({ type: "reset_incident" });
    await until(() => source.pausedAt === "start_incident");
    expect(seen.slice(events.length).map((e) => e.type)).toEqual(["hello", "incident_status"]);
    source.stop();
  });
});
