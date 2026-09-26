import type { AgentId, Domain } from "../../contract";
import { describePlan } from "../../contract";
import { currentTask } from "../../scene/model";
import type { MarketState } from "../../state/reducer";
import { cheapestQualified, modelRegistry, type RankedModel, type RegistryModel } from "./registry";

export type Persona = "commander" | "sre" | "database" | "security" | "payments" | "support" | "viewer";

export const PERSONAS: { id: Persona; label: string }[] = [
  { id: "commander", label: "Incident Commander" },
  { id: "sre", label: "On-call SRE" },
  { id: "database", label: "Database Engineer" },
  { id: "security", label: "Security Engineer" },
  { id: "payments", label: "Payments Engineer" },
  { id: "support", label: "Support Lead" },
  { id: "viewer", label: "Viewer" },
];

export const DOCKS: { domain: Domain; title: string; stall: AgentId | null }[] = [
  { domain: "database", title: "Database Dock", stall: "haiku" },
  { domain: "networking", title: "Network Dock", stall: "sonnet" },
  { domain: "security", title: "Security Dock", stall: "opus" },
  { domain: "payments", title: "Payments Dock", stall: null },
  { domain: "generalist", title: "Generalist Dock", stall: null },
];

const WORKER: Record<AgentId, string> = {
  haiku: "Claude Haiku",
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
};

export function dockTitle(domain: Domain | null): string {
  return DOCKS.find((dock) => dock.domain === domain)?.title ?? "Specialty dock";
}

export function workerName(agentId: AgentId | null): string {
  return agentId ? WORKER[agentId] : "Unassigned";
}

export function planHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

export function canApprove(persona: Persona, severity: string | null): boolean {
  if (persona === "commander") return true;
  return persona === "sre" && severity !== "SEV-1";
}

export function canRevise(persona: Persona): boolean {
  return persona === "commander" || persona === "sre" || persona === "database" || persona === "security" || persona === "payments";
}

export function canReject(persona: Persona): boolean {
  return persona === "commander" || persona === "sre";
}

export interface CaptainLine {
  domain: Domain | null;
  dock: string;
  text: string;
}

export function captainReadout(state: MarketState): CaptainLine {
  const commander = state.incident?.commander;
  if (!commander) {
    return {
      domain: null,
      dock: "Specialty dock",
      text: state.incident?.received ? "Captain AI is reading the evidence package." : "Captain AI is standing by.",
    };
  }
  const dock = dockTitle(commander.domain);
  const evidence = commander.rationale.replace(/\s+/g, " ").trim();
  return {
    domain: commander.domain,
    dock,
    text: `${evidence} Activating ${dock}.`,
  };
}

export function runMode(state: MarketState): "live" | "replay" {
  return state.config?.real_models && !state.config.fake_llm ? "live" : "replay";
}

export function selectionFor(state: MarketState): { selected: RankedModel | null; ranking: RankedModel[]; models: RegistryModel[] } {
  const models = modelRegistry(runMode(state));
  const commander = state.incident?.commander;
  if (!commander) return { selected: null, ranking: [], models };
  const task = currentTask(state);
  const quotes = Object.values(task?.bids ?? {})
    .filter((bid): bid is NonNullable<typeof bid> => Boolean(bid?.ok))
    .map((bid) => ({
      id: `anthropic:${bid.agent_id}`,
      usd: bid.predicted_cost_usd ?? 0,
      quality: bid.promised_quality ?? 0,
      reputation: bid.reputation ?? 0,
    }));
  const { selected, ranking } = cheapestQualified({
    domain: commander.domain,
    severity: commander.severity,
    models,
    quotes,
  });
  return { selected, ranking, models };
}

export interface AttemptRow {
  agentId: AgentId;
  worker: string;
  plan: string;
  passed: boolean;
  costUsd: number;
}

export function repairAttempts(state: MarketState): AttemptRow[] {
  const repairs = state.incident?.repairs ?? [];
  const spent = new Map<string, number>();
  for (const event of state.log) {
    if (event.type !== "done") continue;
    const key = `${event.data.task_id}:${event.data.agent_id}`;
    spent.set(key, (spent.get(key) ?? 0) + event.data.usage.cost_usd);
  }
  return repairs.map((repair) => ({
    agentId: repair.proposal.agent_id,
    worker: workerName(repair.proposal.agent_id),
    plan: repair.proposal.steps.length ? describePlan(repair.proposal.steps) : repair.proposal.reason,
    passed: repair.sandbox?.passed === true,
    costUsd: spent.get(`${repair.proposal.task_id}:${repair.proposal.agent_id}`) ?? 0,
  }));
}

export function escalationCost(attempts: AttemptRow[]): { initial: number; extra: number; final: number } {
  if (!attempts.length) return { initial: 0, extra: 0, final: 0 };
  const initial = attempts[0].costUsd;
  const final = attempts.reduce((sum, row) => sum + row.costUsd, 0);
  return { initial, extra: Math.max(0, final - initial), final };
}

export type CrewState = "alerted" | "watching" | "reviewing" | "approved" | "revision requested";

export function crewState(status: string, needsApproval: boolean, revision: boolean): CrewState {
  if (revision && needsApproval) return "revision requested";
  if (status === "restored" || status === "recovering") return "approved";
  if (status === "awaiting_approval" && needsApproval) return "reviewing";
  if (status === "awaiting_approval") return "watching";
  return "alerted";
}

export interface ChatLine {
  id: string;
  who: string;
  badge: "AI COMMANDER" | "AI WORKER" | "HUMAN";
  text: string;
}

export function incidentChat(state: MarketState, note?: { kind: "revision" | "reject"; persona: string } | null): ChatLine[] {
  const incident = state.incident;
  if (!incident?.received && !incident?.current) return [];
  const lines: ChatLine[] = [];
  const push = (who: string, badge: ChatLine["badge"], text: string) => {
    lines.push({ id: `${lines.length}-${who}`, who, badge, text });
  };
  if (incident.received) push("Captain AI", "AI COMMANDER", incident.received.alert);
  const captain = captainReadout(state);
  if (incident.commander) push("Captain AI", "AI COMMANDER", captain.text);
  const dock = dockTitle(incident.commander?.domain ?? null);
  if (incident.dispatched) push("Captain AI", "AI COMMANDER", `${dock} is evaluating qualified workers.`);
  for (const person of incident.responders?.responders.filter((item) => item.selected) ?? []) {
    push(person.name, "HUMAN", `Watching ${person.role.toLowerCase()}.`);
  }
  for (const repair of incident.repairs) {
    const plan = repair.proposal.steps.length ? describePlan(repair.proposal.steps) : "the proposed plan";
    const worker = workerName(repair.proposal.agent_id);
    if (repair.sandbox && !repair.sandbox.passed) {
      push(worker, "AI WORKER", `Sandbox rejected ${plan}.`);
      push("Captain AI", "AI COMMANDER", `${worker} failed validation. Selecting the next qualified model.`);
    } else if (repair.sandbox?.passed) {
      push(worker, "AI WORKER", `Sandbox passed ${plan}.`);
      push("Captain AI", "AI COMMANDER", "Sandbox passed. Human authorization required.");
    }
  }
  for (const assignment of incident.assignments?.assignments ?? []) {
    if (assignment.approval_required) push(assignment.name, "HUMAN", `Reviewing ${assignment.description}.`);
  }
  if (note?.kind === "revision") push(note.persona, "HUMAN", "Revision requested. The prior approval is cleared.");
  if (note?.kind === "reject") push(note.persona, "HUMAN", "Repair rejected. The cluster stays unchanged.");
  if (incident.status === "restored") push("Captain AI", "AI COMMANDER", "Recovery checks passed. The service is restored.");
  if (lines.length <= 12) return lines;
  const route = lines.find((line) => line.text.includes("Activating"));
  const tail = lines.slice(-10);
  return route && !tail.includes(route) ? [lines[0], route, ...tail].slice(0, 12) : [lines[0], ...lines.slice(-11)];
}

export function dockWorker(state: MarketState): { title: string; worker: string | null; reason: string } {
  const captain = captainReadout(state);
  const pick = selectionFor(state);
  const task = currentTask(state);
  const recorded = task?.winner ?? state.incident?.repairs.at(-1)?.proposal.agent_id ?? null;
  if (!recorded) {
    return { title: captain.dock, worker: null, reason: state.incident?.dispatched ? `${captain.dock} is evaluating qualified workers.` : captain.text };
  }
  const name = workerName(recorded);
  const cheapest = pick.selected;
  let reason = `Recorded assignment: ${name}.`;
  if (cheapest && cheapest.model.agentId === recorded) reason = cheapest.reason;
  else if (cheapest) reason = `Recorded assignment: ${name}. Cheapest qualified bid: ${cheapest.model.displayName}.`;
  return { title: captain.dock, worker: name, reason };
}

export function seededDomain(scenarioId: string): string {
  if (scenarioId.includes("auth")) return "security";
  if (scenarioId.includes("network")) return "networking";
  return "database";
}
