// Pure derivation of the MAYDAY harbor picture from MarketState. HarborScene
// only animates toward this; nothing here touches Pixi.
import { describePlan, type AgentId, type IncidentState, type Telemetry } from "../../contract";
import type { MarketState, TaskView } from "../../state/reducer";
import { AGENT_ORDER, currentTask, formatCents } from "../model";

export type Mood = "healthy" | "alarm" | "recovering" | "restored" | "failed";
export type Berth = "dock" | "platform" | "sandbox";
export type SandboxLight = "idle" | "testing" | "pass" | "fail";

export interface BoatModel {
  id: string;
  label: string;
  color: string;
  kind: "agent" | "human";
  berth: Berth;
  bubble: string | null;
  highlight: boolean;
}

export interface HarborModel {
  mood: Mood;
  boats: BoatModel[];
  sandbox: SandboxLight;
  sandboxLabel: string;
  /** 0..1, how hard the platform is burning. */
  damage: number;
  service: string;
}

const MOOD: Record<IncidentState, Mood> = {
  healthy: "healthy",
  outage: "alarm",
  investigating: "alarm",
  repairing: "alarm",
  awaiting_approval: "alarm",
  recovering: "recovering",
  restored: "restored",
  failed: "failed",
};

const HUMAN_COLOR = "#f2f5f7";

function agentBoat(agentId: AgentId, color: string, task: TaskView | null): BoatModel {
  const boat: BoatModel = { id: agentId, label: agentId.toUpperCase(), color, kind: "agent", berth: "dock", bubble: null, highlight: false };
  if (!task) return boat;
  if (task.status === "open") {
    const bid = task.bids[agentId];
    boat.bubble = !bid ? "..." : !bid.ok ? "PASS" : `${formatCents(bid.predicted_cost_usd ?? 0)} Q${bid.promised_quality}`;
    return boat;
  }
  if (task.winner !== agentId) return boat;
  boat.highlight = true;
  if (task.status === "assigned" || task.status === "working" || task.status === "done") {
    boat.berth = task.type === "remediate" ? "sandbox" : "platform";
    boat.bubble = task.status === "assigned" ? "WON" : task.type.toUpperCase();
  } else if (task.status === "graded") {
    boat.bubble = `${task.grade}/10`;
  }
  return boat;
}

export function harborModel(state: MarketState): HarborModel {
  const incident = state.incident;
  const status = incident?.status ?? "healthy";
  const task = incident && status !== "healthy" ? currentTask(state) : null;

  const boats: BoatModel[] = [];
  for (const agentId of AGENT_ORDER) {
    const agent = state.agents[agentId];
    if (agent) boats.push(agentBoat(agentId, agent.color, task));
  }
  const dispatched = status !== "restored" && status !== "healthy";
  for (const person of incident?.responders?.responders ?? []) {
    boats.push({
      id: person.responder_id,
      label: person.name.toUpperCase(),
      color: HUMAN_COLOR,
      kind: "human",
      berth: person.selected && dispatched ? "platform" : "dock",
      bubble: person.selected && status === "awaiting_approval" && incident?.approval?.approvers.includes(person.name) ? "APPROVE?" : null,
      highlight: person.selected,
    });
  }

  const last = incident?.repairs.at(-1);
  let sandbox: SandboxLight = "idle";
  let sandboxLabel = "SANDBOX";
  if (last) {
    const plan = last.proposal.steps.length ? describePlan(last.proposal.steps) : "invalid plan";
    sandbox = !last.sandbox ? "testing" : last.sandbox.passed ? "pass" : "fail";
    sandboxLabel = `${plan} ${sandbox === "testing" ? "..." : sandbox === "pass" ? "PASS" : "REJECTED"}`;
  }

  return {
    mood: MOOD[status],
    boats,
    sandbox,
    sandboxLabel,
    damage: platformDamage(incident?.current.telemetry ?? []),
    service: (incident?.current.service ?? "service").replace(/-/g, " ").toUpperCase(),
  };
}

function platformDamage(telemetry: Telemetry): number {
  const breached = telemetry.find((item) => !item.ok);
  if (!breached) return 0;
  if (breached.unit === "ratio") {
    if (/success|reach/.test(breached.key)) return Math.min(1, 1 - breached.value);
    return Math.min(1, breached.value / 0.5);
  }
  return 0.65;
}
