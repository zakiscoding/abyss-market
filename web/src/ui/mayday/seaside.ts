// What the seaside harbor shows for a MarketState. Positions live in
// SeasideScene; this file only decides labels, lights, and which actors
// are on the dock. Every string comes from the event state.
import { describePlan, type AgentId, type Domain } from "../../contract";
import { harborModel, type Mood, type SandboxLight } from "../../scene/harbor/model";
import { currentTask } from "../../scene/model";
import type { MarketState } from "../../state/reducer";
import { DOCKS, workerName } from "./command";

const SPECIALTY: Record<Domain, string> = {
  database: "Database Specialist",
  networking: "Networking Specialist",
  security: "Security Specialist",
  payments: "Payments Specialist",
  generalist: "Generalist",
};

const MODEL_NAME: Record<AgentId, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

export type BoatPhase = "calm" | "active" | "restored" | "failed";
export type GatePhase = "idle" | "closed" | "open";

export interface SeasideStall {
  agentId: AgentId;
  sign: string;
  color: string;
  lit: boolean;
  winner: boolean;
  bubble: string | null;
}

export interface SeasideResponder {
  id: string;
  name: string;
  needsApproval: boolean;
}

export interface SeasidePicture {
  mood: Mood;
  boat: BoatPhase;
  service: string;
  region: string;
  severity: string | null;
  status: string;
  classification: string | null;
  stalls: SeasideStall[];
  sandbox: SandboxLight;
  sandboxLabel: string;
  remedyAgent: AgentId | null;
  remedyKey: string | null;
  remedyText: string | null;
  responders: SeasideResponder[];
  gate: GatePhase;
}

export function specialtySign(domain: Domain | null, agentId: AgentId): string {
  const model = MODEL_NAME[agentId];
  if (!domain) return `Specialist · ${model}`;
  return `${SPECIALTY[domain]} · ${model}`;
}

export function seasidePicture(state: MarketState): SeasidePicture {
  const incident = state.incident;
  const harbor = harborModel(state);
  const status = incident?.status ?? "healthy";
  const commander = incident?.commander ?? null;
  const task = incident && status !== "healthy" ? currentTask(state) : null;
  const domain = commander?.domain ?? null;
  const last = incident?.repairs.at(-1);
  const recorded = task?.winner ?? last?.proposal.agent_id ?? null;
  const stalls = DOCKS.flatMap((dock): SeasideStall[] => {
    if (!dock.stall) return [];
    const agentId = dock.stall;
    const active = domain === dock.domain;
    const agent = state.agents[agentId];
    let bubble: string | null = null;
    let lit = false;
    let winner = false;
    if (active && task?.status === "open") {
      bubble = "Evaluating";
      lit = true;
    } else if (active && recorded) {
      bubble = `Worker: ${workerName(recorded)}`;
      lit = true;
      winner = true;
    }
    return [{
      agentId,
      sign: dock.title,
      color: agent?.color ?? "#f4dc97",
      bubble,
      lit,
      winner,
    }];
  });

  const approvers = new Set(incident?.approval?.approvers ?? []);
  const responders = (incident?.responders?.responders ?? [])
    .filter((person) => person.selected)
    .map((person) => ({
      id: person.responder_id,
      name: person.name,
      needsApproval: status === "awaiting_approval" && approvers.has(person.name),
    }));

  let boat: BoatPhase = "calm";
  if (status === "restored") boat = "restored";
  else if (status === "failed") boat = "failed";
  else if (incident?.received || (status !== "healthy" && incident)) boat = "active";

  let gate: GatePhase = "idle";
  if (incident?.granted || status === "recovering" || status === "restored") gate = "open";
  else if (status === "awaiting_approval") gate = "closed";

  const current = incident?.current;
  return {
    mood: harbor.mood,
    boat,
    service: current?.service ?? "Standby",
    region: current?.region?.toUpperCase() ?? "",
    severity: commander?.severity ?? current?.severity ?? null,
    status,
    classification: commander
      ? `${commander.domain} · ${commander.severity}`
      : incident?.received
        ? "Classifying…"
        : null,
    stalls,
    sandbox: harbor.sandbox,
    sandboxLabel: harbor.sandboxLabel === "SANDBOX" ? "Waiting for a plan" : harbor.sandboxLabel,
    remedyAgent: last?.proposal.agent_id ?? null,
    remedyKey: last ? `${last.proposal.task_id}-${last.proposal.attempt}` : null,
    remedyText: last ? (last.proposal.steps.length ? describePlan(last.proposal.steps) : "invalid plan") : null,
    responders,
    gate,
  };
}
