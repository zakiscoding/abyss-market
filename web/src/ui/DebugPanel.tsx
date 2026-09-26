import type { AgentId, TaskType } from "../contract";
import type { MarketState } from "../state/reducer";

const taskTypes: { key: TaskType; label: string }[] = [
  { key: "research", label: "R" },
  { key: "writing", label: "W" },
  { key: "checking", label: "C" },
  { key: "diagnose", label: "D" },
  { key: "remediate", label: "F" },
  { key: "verify", label: "V" },
];

export function DebugPanel({ state }: { state: MarketState }) {
  return (
    <aside className="debug-panel">
      <header className="debug-header">
        <div>
          <span className={`connection-dot ${state.connected ? "online" : ""}`} />
          {state.connected ? "ONLINE" : "WAITING"}
        </div>
        <strong>ABYSS LEDGER</strong>
      </header>

      <section>
        <h2>Agent stalls</h2>
        <div className="agent-grid">
          {(Object.entries(state.agents) as [AgentId, NonNullable<(typeof state.agents)[AgentId]>][]).map(
            ([agentId, agent]) => (
              <article className="agent-card" key={agentId}>
                <div className="agent-title">
                  <span className="agent-swatch" style={{ background: agent.color }} />
                  <strong>{agent.display_name}</strong>
                  <em>{agent.status}</em>
                </div>
                {taskTypes.map(({ key, label }) => (
                  <div className="rep-row" key={key}>
                    <span>{label}</span>
                    <div className="rep-track">
                      <i
                        style={{
                          width: `${Math.min(100, Math.max(0, agent.reputation[key] * 50))}%`,
                          background: agent.color,
                        }}
                      />
                    </div>
                    <b>{agent.reputation[key].toFixed(3)}</b>
                  </div>
                ))}
              </article>
            ),
          )}
        </div>
      </section>

      <section>
        <h2>Task board</h2>
        <div className="task-list">
          {state.taskOrder.map((taskId) => {
            const task = state.tasks[taskId];
            return (
              <article className={`task-card task-${task.type}`} key={taskId}>
                <div className="task-heading">
                  <strong>{taskId} · {task.title}</strong>
                  <span>{task.status}</span>
                </div>
                <p>{task.brief}</p>
                <div className="bid-list">
                  {(Object.entries(task.bids) as [AgentId, NonNullable<(typeof task.bids)[AgentId]>][]).map(
                    ([agentId, bid]) => (
                      <span className={task.winner === agentId ? "winning-bid" : ""} key={agentId}>
                        {agentId}: {bid.ok ? `q${bid.promised_quality} · $${bid.predicted_cost_usd?.toFixed(4)}` : "failed"}
                      </span>
                    ),
                  )}
                </div>
                {task.grade !== null && (
                  <div className="grade-line">GRADE {task.grade}/10 · {task.rationale}</div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {state.stats && (
        <section>
          <h2>Market totals</h2>
          <div className="totals-strip">
            <span>${state.stats.total_cost_usd.toFixed(5)}</span>
            <span>{state.stats.calls} calls</span>
            <span>{state.stats.input_tokens + state.stats.output_tokens} tokens</span>
          </div>
          <table>
            <thead><tr><th>Purpose</th><th>Calls</th><th>Cost</th></tr></thead>
            <tbody>
              {Object.entries(state.stats.by_purpose).map(([purpose, values]) => (
                <tr key={purpose}><td>{purpose}</td><td>{values.calls}</td><td>${values.cost_usd.toFixed(6)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {state.final && (
        <section className="deliverable">
          <h2>Final deliverable</h2>
          <div className="final-meta">
            {state.final.status} · mean grade {state.final.mean_grade ?? "—"} · ${state.final.total_cost_usd.toFixed(5)}
          </div>
          <p>{state.final.deliverable ?? "No deliverable produced."}</p>
        </section>
      )}

      <section>
        <h2>Event log</h2>
        <ol className="event-log">
          {state.log.map((event) => (
            <li key={`${event.seq}-${event.type}`}>
              <span>{String(event.seq).padStart(2, "0")}</span>
              <b>{event.type}</b>
              <em>{event.job_id ?? "connection"}</em>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}
