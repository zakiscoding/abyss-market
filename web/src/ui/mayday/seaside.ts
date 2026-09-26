// What the seaside harbor shows for a MarketState. Positions live in
// SeasideScene; this file only decides labels, lights, and which actors
// are on the dock. Every string comes from the event state.
import { describePlan, type AgentId, type Domain } from "../../contract";
import { harborModel, type Mood, type SandboxLight } from "../../scene/harbor/model";
import { AGENT_ORDER, currentTask, formatCents } from "../../scene/model";
import type { MarketState, TaskView } from "../../state/reducer";

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

function stallBubble(agentId: AgentId, task: TaskView | null): Pick<SeasideStall, "bubble" | "lit" | "winner"> {
  if (!task) return { bubble: null, lit: false, winner: false };
  const winner = task.winner === agentId && task.status !== "open" && task.status !== "failed";
  if (task.status === "open") {
    const bid = task.bids[agentId];
    if (!bid) return { bubble: "...", lit: false, winner: false };
    if (!bid.ok) return { bubble: "PASS", lit: false, winner: false };
    return {
      bubble: `Q${bid.promised_quality} ${formatCents(bid.predicted_cost_usd ?? 0)}`,
      lit: true,
      winner: false,
    };
  }
  if (!winner) return { bubble: null, lit: false, winner: false };
  if (task.status === "assigned") return { bubble: "WON", lit: true, winner: true };
  if (task.status === "working") return { bubble: task.type.toUpperCase(), lit: true, winner: true };
  const grade = task.grade != null ? `${task.grade}/10` : "DONE";
  return { bubble: grade, lit: true, winner: true };
}

export function seasidePicture(state: MarketState): SeasidePicture {
  const incident = state.incident;
  const harbor = harborModel(state);
  const status = incident?.status ?? "healthy";
  const commander = incident?.commander ?? null;
  const task = incident && status !== "healthy" ? currentTask(state) : null;
  const dispatched = incident?.dispatched?.specialists.filter((item) => item.dispatched) ?? [];
  const domain = commander?.domain ?? null;

  const stalls = AGENT_ORDER.map((agentId): SeasideStall => {
    const fromEvent = dispatched.find((item) => item.agent_id === agentId)?.label;
    const agent = state.agents[agentId];
    return {
      agentId,
      sign: fromEvent ?? specialtySign(domain, agentId),
      color: agent?.color ?? "#f4dc97",
      ...stallBubble(agentId, task),
    };
  });

  const last = incident?.repairs.at(-1);
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
