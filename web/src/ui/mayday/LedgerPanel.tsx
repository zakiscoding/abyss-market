import type { AbyssEvent } from "../../contract";
import type { MarketState } from "../../state/reducer";
import { formatDuration } from "./derive";
import { modelRegistry } from "./registry";
import { workerName } from "./command";
import "./side-panels.css";

export function auditTimeline(events: AbyssEvent[]) {
  let connectionShown = false;
  return events.flatMap((event, index) => {
    let label = "";
    switch (event.type) {
      case "hello": if (connectionShown) return []; connectionShown = true; label = "Connected to Abyss"; break;
      case "incident_status": label = event.data.status === "healthy" ? "Simulation initialized"
        : event.data.status === "recovering" ? "Repair applied to simulated cluster" : `Service ${event.data.status.replaceAll("_", " ")}`; break;
      case "incident_received": label = `Incident received: ${event.data.name}`; break;
      case "commander_classified": label = `Captain classified incident: ${event.data.domain} / ${event.data.severity}`; break;
      case "specialists_dispatched": label = `Specialty selected: ${event.data.domain}`; break;
      case "responders_selected": label = `Human crew alerted: ${event.data.responders.filter((person) => person.selected).map((person) => person.name).join(", ")}`; break;
      case "won": label = `Worker selected: ${workerName(event.data.agent_id)} for ${event.data.task_id}`; break;
      case "sandbox_result": label = `Sandbox ${event.data.passed ? "passed" : "rejected"}: attempt ${event.data.attempt}`; break;
      case "approval_required": label = `Awaiting approval: ${event.data.approvers.join(", ")}`; break;
      case "approval_granted": label = `Approval received: ${event.data.approved_by.join(", ")}`; break;
      case "service_restored": label = `Recovery ${event.data.verification.every((check) => check.passed) ? "verified" : "needs attention"}`; break;
      case "notification_status": label = `Discord ${event.data.status}: ${event.data.recipients.join(", ")}`; break;
      case "incident_escalated": label = `Incident escalated: ${event.data.reason}`; break;
      case "rep_update": label = `Reputation updated: ${workerName(event.data.agent_id)} ${event.data.old.toFixed(2)} → ${event.data.new.toFixed(2)}`; break;
      case "final": label = `Run completed: ${event.data.status}`; break;
      case "error": label = "Operation needs attention; see Developer details"; break;
      default: return [];
    }
    return [{ id: `${index}-${event.seq}`, t: event.t, label }];
  });
}

export function workflowTasks(state: MarketState) {
  const i = state.incident;
  if (!i?.received || i.status === "healthy") return [];
  const passed = i.repairs.some((repair) => repair.sandbox?.passed);
  const failed = i.repairs.at(-1)?.sandbox?.passed === false;
  const won = state.taskOrder.some((id) => state.tasks[id].winner);
  const rows = [
    { label: "Classify incident", done: !!i.commander, active: true },
    { label: "Select specialty", done: !!i.dispatched, active: !!i.commander },
    { label: "Evaluate workers", done: won, active: !!i.dispatched },
    { label: "Validate remediation", done: passed, active: !!i.repairs.length, failed },
    { label: "Alert human crew", done: !!i.responders, active: !!i.commander },
    { label: "Await approval", done: !!i.granted, active: !!i.approval },
    { label: "Verify recovery", done: !!i.restored && i.restored.verification.every((check) => check.passed), active: i.status === "recovering", failed: !!i.restored && i.restored.verification.some((check) => !check.passed) },
  ];
  return rows.map((row) => ({ label: row.label, state: row.done ? "Passed" : row.failed ? "Failed" : i.status === "failed" ? "Skipped" : row.active ? "Active" : "Waiting" }));
}

export function LedgerPanel({ state, replay = false }: { state: MarketState; replay?: boolean }) {
  const simulated = replay || !state.config || state.config.fake_llm;
  const catalog = modelRegistry(simulated ? "replay" : "live");
  const agents = Object.values(state.agents).filter((agent) => !!agent);
  const actualModel = (model: string) => !simulated && !state.config?.real_models ? "claude-haiku-4-5" : model;
  const unique = new Set(agents.map((agent) => actualModel(agent.model)));
  const events = state.log.filter((event) => event.job_id === state.incident?.jobId);
  const contacted = new Set(events.flatMap((event) => event.type === "bid" ? [actualModel(state.agents[event.data.agent_id]?.model ?? event.data.agent_id)] : []));
  const tasks = workflowTasks(state);
  return <section className="panel side-ledger">
    <header className="panel-head"><h2>Model Market</h2><span>{simulated ? "Simulation" : "Provider mode"}</span></header>
    <p>Models are AI workers. Harbor buildings are specialty stalls.</p>
    {!simulated && !state.config?.real_models && <p>Haiku test mode: every Anthropic worker role uses claude-haiku-4-5.</p>}
    <dl><dt>Unique foundation models in configured routes</dt><dd>{unique.size}</dd><dt>Registered specialty routes</dt><dd>{state.config?.specialists.length ?? 0}</dd><dt>Unique models contacted this run</dt><dd>{contacted.size}{simulated ? " (simulated)" : ""}</dd><dt>Specialist routes contacted / skipped across auctions</dt><dd>{state.incident?.routing ? `${state.incident.routing.models_contacted} / ${state.incident.routing.models_skipped}` : "Pending routing totals"}</dd></dl>
    {catalog.map((model) => {
      const agent = model.agentId ? state.agents[model.agentId] : null;
      const checks = state.log.filter((event) => event.type === "sandbox_result" && event.data.agent_id === model.agentId);
      const passed = checks.filter((event) => event.type === "sandbox_result" && event.data.passed).length;
      const domain = state.incident?.commander?.domain;
      const reputation = Object.entries(agent?.reputation ?? {}).filter(([key]) => domain ? key.startsWith(`${domain}.`) : key.includes("."));
      const history = state.taskOrder.flatMap((id) => {
        const task = state.tasks[id];
        const bid = model.agentId ? task.bids[model.agentId] : null;
        return bid ? [`${task.title}: ${task.winner === model.agentId ? "Selected" : !bid.ok ? "Bid rejected" : task.winner ? "Not selected" : "Evaluating"}${bid.predicted_cost_usd != null ? ` ($${bid.predicted_cost_usd.toFixed(4)} estimated)` : ""}`] : [];
      });
      return <article key={model.id}><h3>{model.displayName}</h3><dl>
        <dt>Provider / model</dt><dd>{model.provider} / {agent ? actualModel(agent.model) : model.modelId}</dd>
        <dt>Availability</dt><dd>{model.availability}</dd><dt>Eligible domains</dt><dd>{model.domains.join(", ")}</dd>
        <dt title="Stored reputation by specialty and task type, updated by recorded grades">Domain reputation</dt><dd>{reputation.length ? reputation.map(([key, value]) => `${key.replace(".diagnose", " diagnosis").replace(".remediate", " remediation").replace(".verify", " verification")}: ${value.toFixed(3)}`).join("; ") : "No recorded domain reputation"}</dd>
        <dt title="Observed deterministic sandbox outcomes in the retained session events, not a provider reliability claim">Historical validation rate (retained session)</dt><dd>{checks.length ? `${passed}/${checks.length} passed (${Math.round(passed / checks.length * 100)}%)` : "No recorded validations"}</dd>
        <dt>Estimated input / output cost per million tokens</dt><dd>{agent && actualModel(agent.model) !== model.modelId ? "Catalog estimate unavailable for configured model" : `$${model.inputPerM} / $${model.outputPerM} (catalog estimate)`}</dd>
        <dt>Selection / rejection history</dt><dd>{history.length ? history.join("; ") : model.availability === "unavailable" ? "Unavailable: no working adapter; no calls made" : "No bids recorded this run"}</dd>
      </dl></article>;
    })}
    {tasks.length > 0 && <section><h2>Task Board</h2><ol>{tasks.map((task) => <li key={task.label}><b>{task.label}</b> — {task.state}</li>)}</ol></section>}
    {state.stats && <p>{simulated ? "Simulated cost" : "Actual AI cost"}: ${state.stats.total_cost_usd.toFixed(5)} · {state.stats.calls} calls · {state.stats.input_tokens + state.stats.output_tokens} tokens</p>}
    <section><h2>Audit timeline</h2><ol className="audit-timeline">{auditTimeline(state.log).map((line) => <li key={line.id}><time>{formatDuration(line.t)}</time> {line.label}</li>)}</ol></section>
    <details><summary>Developer details</summary><p>Raw retained events, including connection/setup repetitions.</p><pre>{JSON.stringify(state.log, null, 2)}</pre></details>
  </section>;
}
