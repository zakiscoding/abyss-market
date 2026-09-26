import { describe, expect, it } from "vitest";

import ams from "../../../public/fixtures/incident_ams_db_outage.json";
import type { AbyssEvent } from "../../contract";
import { initialState, reduce } from "../../state/reducer";
import {
  canApprove,
  canReject,
  canRevise,
  captainAnswer,
  captainReadout,
  escalationCost,
  incidentChat,
  planHash,
  repairAttempts,
  selectionFor,
} from "./command";
import { cheapestQualified, chooseAutomaticModel, modelRegistry } from "./registry";

const events = ams as AbyssEvent[];

function play(stream: AbyssEvent[]) {
  return stream.reduce(reduce, initialState);
}

function upTo(predicate: (event: AbyssEvent) => boolean) {
  const end = events.findIndex(predicate);
  return play(events.slice(0, end + 1));
}

describe("model registry", () => {
  it("marks only Anthropic as simulated until a live adapter is connected", () => {
    const replay = modelRegistry("replay");
    expect(replay.filter((model) => model.provider === "anthropic").every((model) => model.availability === "simulated")).toBe(true);
    expect(replay.filter((model) => model.provider !== "anthropic").every((model) => model.availability === "unavailable")).toBe(true);
    expect(modelRegistry("live").find((model) => model.id === "anthropic:haiku")?.availability).toBe("connected");
  });

  it("picks the cheapest model that clears the severity bar", () => {
    const models = modelRegistry("replay");
    const { selected, ranking } = cheapestQualified({
      domain: "database",
      severity: "SEV-1",
      models,
      quotes: [
        { id: "anthropic:haiku", usd: 0.002, quality: 8, reputation: 1 },
        { id: "anthropic:sonnet", usd: 0.008, quality: 9, reputation: 1 },
        { id: "anthropic:opus", usd: 0.02, quality: 9, reputation: 1 },
      ],
    });

    expect(selected?.model.id).toBe("anthropic:haiku");
    expect(ranking.find((row) => row.model.provider === "openai")?.qualified).toBe(false);
    const strict = cheapestQualified({
      domain: "database",
      severity: "SEV-1",
      models,
      quotes: [
        { id: "anthropic:haiku", usd: 0.002, quality: 5, reputation: 1 },
        { id: "anthropic:sonnet", usd: 0.008, quality: 9, reputation: 1 },
      ],
    });
    expect(strict.selected?.model.id).toBe("anthropic:sonnet");
  });
  it("automatically eliminates rejected models and returns only eligible survivors", () => {
    const result = chooseAutomaticModel({
      domain: "database",
      severity: "SEV-1",
      models: modelRegistry("replay"),
      quotes: [
        { id: "anthropic:haiku", usd: 0.002, quality: 8, reputation: 1 },
        { id: "anthropic:sonnet", usd: 0.008, quality: 9, reputation: 1 },
        { id: "anthropic:opus", usd: 0.02, quality: 9, reputation: 1 },
      ],
    });
    expect(result.selected?.model.id).toBe("anthropic:haiku");
    expect(result.eligible.map((row) => row.model.id)).toEqual([
      "anthropic:haiku", "anthropic:sonnet", "anthropic:opus",
    ]);
    expect(result.eliminated.every((row) => !row.qualified)).toBe(true);
    expect(result.eliminated.some((row) => row.reason === "No working adapter")).toBe(true);
  });

});

describe("captain and crew workflow", () => {
  it("routes Amsterdam to the Database Repair from the recorded rationale", () => {
    const state = upTo((event) => event.type === "commander_classified");
    const captain = captainReadout(state);
    expect(captain.dock).toBe("Database Repair");
    expect(captain.text).toContain("Routing to Database Repair");
    expect(captain.text.toLowerCase()).not.toContain("eval(");
  });

  it("builds chat from events and prices escalation from usage", () => {
    const state = play(events);
    const chat = incidentChat(state);
    expect(chat.some((line) => line.badge === "AI COMMANDER" && line.text.includes("Database Repair"))).toBe(true);
    expect(chat.some((line) => line.badge === "HUMAN")).toBe(true);
    const attempts = repairAttempts(state);
    expect(attempts.map((row) => row.passed)).toEqual([false, true]);
    const cost = escalationCost(attempts);
    expect(cost.extra).toBeGreaterThan(0);
    expect(cost.final).toBeCloseTo(cost.initial + cost.extra, 6);
  });

  it("answers incident questions from recorded evidence without adding authority", () => {
    const state = upTo((event) => event.type === "approval_required");
    const answer = captainAnswer(state, "Who must approve this repair?");
    expect(answer.answer).toContain("Maya");
    expect(answer.answer).toContain("Zak");
    expect(answer.answer).toContain("cannot approve");
    expect(captainAnswer(state, "Why this worker?").answer).toContain("Claude");
  });

  it("keeps a plan hash stable and limits SEV-1 approval to the commander", () => {
    expect(planHash("failover_db")).toBe(planHash("failover_db"));
    expect(planHash("failover_db")).not.toBe(planHash("restart_db"));
    expect(canApprove("commander", "SEV-1")).toBe(true);
    expect(canApprove("sre", "SEV-1")).toBe(false);
    expect(canApprove("viewer", "SEV-2")).toBe(false);
    expect(canRevise("sre")).toBe(true);
    expect(canRevise("viewer")).toBe(false);
    expect(canReject("support")).toBe(false);
  });

  it("ranks the recorded Amsterdam bids without hiding the auction winner", () => {
    const state = upTo((event) => event.type === "approval_required");
    const pick = selectionFor(state);
    expect(pick.selected?.model.availability).not.toBe("unavailable");
    expect(pick.models.filter((model) => model.availability === "unavailable").length).toBeGreaterThan(0);
  });
});
