import { afterEach, describe, expect, it, vi } from "vitest";

import ams from "../../../public/fixtures/incident_ams_db_outage.json";
import auth from "../../../public/fixtures/incident_auth_attack.json";
import net from "../../../public/fixtures/incident_network_partition.json";
import pool from "../../../public/fixtures/incident_payments_pool.json";
import type { AbyssEvent } from "../../contract";
import { harborModel } from "../../scene/harbor/model";
import { FixtureSource } from "../../sources/fixture";
import { initialState, reduce, type MarketState } from "../../state/reducer";
import { outcome, pipeline, terminal } from "./derive";

const events = ams as AbyssEvent[];

function play(stream: AbyssEvent[]): MarketState {
  return stream.reduce(reduce, initialState);
}

function upTo(stream: AbyssEvent[], predicate: (event: AbyssEvent) => boolean): MarketState {
  const end = stream.findIndex(predicate);
  return play(stream.slice(0, end + 1));
}

describe("MAYDAY reducer", () => {
  it("reduces the Amsterdam recording to a restored database incident", () => {
    const state = play(events);
    expect(state.incident?.status).toBe("restored");
    expect(state.incident?.commander?.domain).toBe("database");
    expect(state.incident?.dispatched?.eligible).toBe(3);
    expect(state.incident?.repairs.map((r) => r.sandbox?.passed)).toEqual([false, true]);
    expect(state.incident?.assignments?.required_approvers).toEqual(["Maya", "Riley", "Zak"]);
    expect(state.incident?.responders?.responders.filter((r) => r.selected).map((r) => r.name)).toEqual([
      "Zak", "Maya", "Riley", "Jordan",
    ]);
    expect(state.history[0]?.outcome).toBe("restored");
    expect(state.jobActive).toBe(false);
  });

  it("keeps closed incidents in history after a healthy reset", () => {
    const done = play(events);
    const healthy = events.find((event) => event.type === "incident_status" && event.data.status === "healthy")!;
    const reset = reduce(done, { ...healthy, seq: 999 });
    expect(reset.incident?.status).toBe("healthy");
    expect(reset.taskOrder).toEqual([]);
    expect(reset.history).toHaveLength(1);
    expect(reset.agents).toEqual(done.agents);
  });
});

describe("MAYDAY selectors", () => {
  it("pipeline waits on classify, then humans", () => {
    const received = upTo(events, (e) => e.type === "incident_received");
    expect(pipeline(received).find((s) => s.key === "classify")?.state).toBe("active");
    const approval = upTo(events, (e) => e.type === "approval_required");
    expect(Object.fromEntries(pipeline(approval).map((s) => [s.key, s.state]))).toEqual({
      classify: "done", diagnose: "done", remediate: "done", sandbox: "done",
      assign: "done", approve: "active", deploy: "pending",
    });
    expect(harborModel(approval).mood).toBe("alarm");
  });

  it("pipeline is complete after recovery", () => {
    expect(pipeline(play(events)).every((s) => s.state === "done")).toBe(true);
  });

  it("shows the rejected Amsterdam restart in the sandbox", () => {
    const state = upTo(events, (e) => e.type === "sandbox_result");
    expect(pipeline(state).find((s) => s.key === "sandbox")?.state).toBe("failed");
    expect(harborModel(state).sandbox).toBe("fail");
    expect(terminal(state).some((line) => line.text.includes("restart_db(ams)"))).toBe(true);
  });

  it("metrics and routing come from events", () => {
    const state = play(events);
    const result = outcome(state);
    const lastStats = [...events].reverse().find((e) => e.type === "stats")!;
    const restored = events.find((e) => e.type === "service_restored")!;
    const routing = events.find((e) => e.type === "routing_stats")!;
    if (lastStats.type !== "stats" || restored.type !== "service_restored" || routing.type !== "routing_stats") {
      throw new Error("fixture shape");
    }
    expect(result.aiCost).toBe(lastStats.data.total_cost_usd);
    expect(result.confidence).toBe(restored.data.confidence);
    expect(result.attempts).toBe(2);
    expect(result.failedAttempts).toBe(1);
    expect(result.routing?.models_skipped).toBe(routing.data.models_skipped);
    expect(result.routing?.avoided_input_tokens_est).toBeGreaterThan(0);
  });

  it("harbor pages only the selected humans", () => {
    const state = upTo(events, (e) => e.type === "approval_required");
    const humans = harborModel(state).boats.filter((b) => b.kind === "human");
    expect(humans.filter((b) => b.berth === "platform").map((b) => b.id)).toEqual(["zak", "maya", "riley", "jordan"]);
    expect(humans.find((b) => b.id === "sam")?.berth).toBe("dock");
    expect(harborModel(play(events)).mood).toBe("restored");
    expect(harborModel(state).service).toBe("ORDERS API");
  });
});

describe("other scenarios", () => {
  it("classifies security and networking incidents and restores them", () => {
    const security = play(auth as AbyssEvent[]);
    expect(security.incident?.commander?.domain).toBe("security");
    expect(security.incident?.assignments?.required_approvers).toEqual(["Sam"]);
    expect(security.incident?.status).toBe("restored");

    const network = play(net as AbyssEvent[]);
    expect(network.incident?.commander?.domain).toBe("networking");
    expect(network.incident?.assignments?.required_approvers).toEqual(["Riley", "Zak"]);
    expect(network.incident?.status).toBe("restored");

    const payments = play(pool as AbyssEvent[]);
    expect(payments.incident?.commander?.domain).toBe("database");
    expect(payments.incident?.assignments?.required_approvers).toEqual(["Maya", "Zak"]);
    expect(payments.incident?.status).toBe("restored");
  });
});

describe("FixtureSource gates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pauses for Trigger and Approve Repair", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => events }));
    const seen: AbyssEvent[] = [];
    const source = new FixtureSource("/fixtures/incident_ams_db_outage.json", 1e6);
    source.start((event) => seen.push(event));
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    };

    await until(() => source.pausedAt !== null);
    expect(seen.map((e) => e.type)).toEqual(["hello", "incident_status"]);
    expect(source.pausedAt).toBe("start_incident");
    expect(source.send({ type: "approve_repair" })).toBe(false);

    expect(source.send({ type: "start_incident", scenario_id: "ams_db_outage" })).toBe(true);
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
