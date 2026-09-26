# Abyss — SPEC

**Contract version:** `v: 1` — **FROZEN** at H0.
Changes need orchestrator sign-off. They must be recorded in §10 and made in `fixtures/make_fake_run.py`, backend `contract.py` and `web/src/contract.ts` in the same commit.

Abyss is a marketplace where AI agents bid on work. An orchestrator LLM splits a job into typed subtasks. For each subtask, three worker agents bid a predicted cost and a promised quality. A scoring function picks the winner, and the winner does the work. A blind reviewer grades the output. Reputation per (agent, task type) moves toward what the agent actually delivered. A ledger records the real token usage of **every** LLM call. Everything streams over one WebSocket to a PixiJS pixel-art seaside market.

---

## 1. Fixed constants

### 1.1 Agents (frozen ids; array order = stall order left→right = tie-break order)

| agent_id | display_name | model (nominal) | color |
|---|---|---|---|
| `haiku` | Haiku 4.5 | `claude-haiku-4-5` | `#4fb3a9` |
| `sonnet` | Sonnet 5 | `claude-sonnet-5` | `#e8a33d` |
| `opus` | Opus 5 | `claude-opus-5` | `#8e6cc9` |

Non-agent roles: **orchestrator** `claude-sonnet-5`, **reviewer** `claude-sonnet-5`. These are configurable and are not agents: they never bid and have no reputation.

### 1.2 Prices (USD per 1M tokens)

| model | input | output | supports `effort` |
|---|---|---|---|
| `claude-haiku-4-5` | 1.00 | 5.00 | no (sending it errors) |
| `claude-sonnet-5` | 2.00 | 10.00 | yes |
| `claude-opus-5` | 5.00 | 25.00 | yes |

Cache reads cost 0.1× the input price and cache writes cost 1.25× the input price. We don't plan to use caching, but the ledger records both fields anyway.

### 1.3 Task types
Job task types: `research`, `writing`, `checking`. Only these come out of a job split.
Incident task types (MAYDAY, §11): `diagnose`, `remediate`, `verify`. Reputation is tracked for all six, in that order.

### 1.4 Tunables (`backend/abyss/config.py`, env-overridable)

| name | default | env |
|---|---|---|
| `PRICE_WEIGHT` | `1.0` (per US cent) | `ABYSS_PRICE_WEIGHT` |
| `REP_INIT` | `1.0` | — |
| `REP_ALPHA` | `0.3` | — |
| `REP_MIN`, `REP_MAX` | `0.0`, `2.0` | — |
| `MAX_TASKS` | `5` (min 2) | — |
| `WORK_EFFORT` | `"medium"` (only sent to models that support effort) | — |
| `BID_EFFORT`, `REVIEW_EFFORT`, `SPLIT_EFFORT` | `"low"` | — |

### 1.5 Run modes (cost safety)

| env | effect |
|---|---|
| *(default)* | **Haiku test mode.** Every LLM call is sent to `claude-haiku-4-5`, whatever role or agent makes it. |
| `ABYSS_REAL_MODELS=1` | Calls go to each role's real model. Required for demos and the experiment. |
| `ABYSS_FAKE_LLM=1` | No network. A deterministic fake returns canned outputs and synthetic usage. Used for tests, WS work and frontend dev. |
| `ABYSS_FAKE_DELAY` | Seconds per fake call (default `0.3`). |
| `ABYSS_LEDGER_PATH` | Append-only JSONL ledger (default `runs/ledger.jsonl`). |
| `ABYSS_REP_PATH` | Reputation persistence file (default `runs/reputation.json`). |

In Haiku test mode:
- The **ledger** prices each call at the model that was **actually called** (the truth).
- The **auction** prices bids at the agent's **nominal** model (§3), so market dynamics look the same as in a real run.
- `usage.model` always reports the model that was actually called.

---

## 2. Money and rounding

```
cost_usd(model, in, out, cache_read=0, cache_write=0)
  = (in*P_in + out*P_out + cache_read*P_in*0.1 + cache_write*P_in*1.25) / 1_000_000
```
- USD values are rounded to **6** decimals when emitted.
- Scores are rounded to **3** decimals.
- Reputation and ratios are rounded to **4** decimals.
- `output_tokens` from `resp.usage` already includes thinking tokens. That's intended: thinking is real cost.

## 3. Auction

1. The market computes `est_input_tokens = ceil(len(work_prompt_chars) / 4)` for the task. `work_prompt_chars` is the exact system + user text the winner would receive, including dependency outputs. The number is the same for every bidder.
2. Each agent bids concurrently (`asyncio.gather`) with one LLM call. The call returns `{predicted_output_tokens:int, promised_quality:int, pitch:str}`, which the market clamps:
   - tokens to [50, 4000]
   - quality to an int in [1, 10]
   - pitch truncated to 80 chars

   The bid prompt includes the job, the task brief, the character sizes of the dependency outputs (**not** their contents, to keep bid calls cheap) and the agent's current reputation for this task type, with the note "1.0 = you deliver what you promise".
3. `predicted_cost_usd = cost_usd(nominal_model(agent), est_input_tokens, predicted_output_tokens)`
4. `score = promised_quality × reputation[agent][type] − PRICE_WEIGHT × predicted_cost_usd × 100`
5. The winner is the highest score. Ties go to the lower `predicted_cost_usd`, then to agent order (§1.1).
6. A bid that fails (API error, refusal, unparseable) gets `ok:false` and is excluded. If no bid is valid, the task fails (see §6).

## 4. Work, review, reputation

- **Work.** The winner gets the job text, the task brief and the full outputs of its `depends_on` tasks. Output is plain text. The prompt caps length (≤250 words; research ≤200 words as bullets).
- **Review.** The reviewer is **blind**: it doesn't see the agent identity or the promised quality. It sees the job, the task type and brief, dependency outputs (checking tasks need them) and the output. It returns `{grade:int 1–10, rationale:str}`, clamped, with the rationale truncated to 200 chars. Each type has its own rubric:
  - research: accuracy, relevance, specificity, no padding
  - writing: meets the brief and the job's constraints (length/format), clarity, correct use of the research
  - checking: finds real errors, gives a clear verdict, invents no issues
- **Reputation update** (winner only, only for the task's type):
  ```
  ratio = clamp(grade / promised_quality, REP_MIN, REP_MAX)
  new   = old + REP_ALPHA × (ratio − old)
  ```
  So `promised_quality × reputation` ≈ the quality the agent is expected to deliver. Overpromisers get discounted, and honest agents stay near 1.0.
- **Deliverable** = the output of the last *successfully done* `writing` task. If there is none, it's the last successfully done task of any type. If there is none of those either, it's `null`.
- **Order.** Tasks run **sequentially** in split order. Every event still carries `task_id`, so the frontend must key everything by `task_id` and must not assume order.

## 5. Ledger

One entry per LLM call, **including calls that fail**. `backend/abyss/llm.py` is the **only** module that imports `anthropic`, and it writes the ledger entry for every call itself. No other code path may call a model.

```json
{
  "id": "c_0001", "ts": 1759000000.123, "job_id": "j_7f3a91c2",
  "task_id": "t1" | null, "agent_id": "haiku" | null,
  "purpose": "split" | "bid" | "work" | "review",
  "model": "claude-haiku-4-5",
  "input_tokens": 350, "output_tokens": 60,
  "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
  "cost_usd": 0.00065, "ok": true, "stop_reason": "end_turn", "error": null,
  "duration_ms": 1200
}
```
- `agent_id` is set only for `bid` and `work` calls.
- A failure with no response has `ok:false`, 0 tokens and `error` set.
- Each job has its own in-memory `Ledger`, and every entry is also appended to `ABYSS_LEDGER_PATH`.

## 6. Failure policy (boring on purpose)

| failure | behavior |
|---|---|
| Split fails (after 1 retry) | `error{fatal:true}`, then `final{status:"error"}`. |
| Single bid fails | `bid{ok:false}`; the auction continues with the rest. |
| All bids fail | `error{fatal:false, task_id}`; the task is marked failed; continue. |
| Work fails (after 1 retry) | `error{fatal:false, task_id}`; no `done/graded/rep_update`; **no rep change** (API errors aren't the agent's fault); continue. |
| Review fails (after 1 retry) | `error{fatal:false, task_id}`; the task counts as done but ungraded; no rep change. |
| `stop_reason == "refusal"` | Treated as a failed call. We do **not** use server-side fallbacks, because a fallback would silently change which model did the work and corrupt per-agent data. |
| Any task failed | `final.status = "partial"`. |

The SDK already retries 429/5xx. Our "1 retry" covers parse or validation failures only.

---

## 7. Event contract (server → client)

### 7.1 Envelope

```json
{ "v": 1, "seq": 12, "t": 11250, "job_id": "j_7f3a91c2", "type": "graded", "data": { ... } }
```
- `seq`: int, strictly increasing per WebSocket connection (or per recording), starting at `0` with `hello`.
- `t`: int ms since the current job started (`start_job` received). `hello` has `t: 0`.
- `job_id`: `"j_" + 8 hex`, or `null` for `hello` and for `error`s outside a job.
- `data`: every key listed below is **always present**. Use `null`, never omit a key.
- Unknown `type`: the frontend must log and ignore it.

### 7.2 Per-job order

```
job_split → stats
for each task (sequential):
  task_posted → bid ×3 (any order) → won → stats
  → working → done → graded → rep_update → stats
final
```
`error` may appear anywhere. On failures the sequence for that task stops early (§6), then emits `stats` as the last event in the task segment. A review failure makes `final.status` `"partial"`.
In fixed mode (experiment only, `won.mode == "fixed"`), there are no `bid` events and no `rep_update`, and `graded.promised_quality` is `null`.
`stats` is a **full snapshot of the current job**, never a delta. Clients replace their copy.

### 7.3 Shared shapes

```ts
type AgentId  = "haiku" | "sonnet" | "opus";
type TaskType = "research" | "writing" | "checking" | "diagnose" | "remediate" | "verify";
type Usage = {                // one LLM call, from resp.usage
  model: string;              // model actually called
  input_tokens: number; output_tokens: number;
  cost_usd: number; duration_ms: number;
};
```

### 7.4 Events

| type | data |
|---|---|
| `hello` | `{ agents: [{agent_id, display_name, model, color}], reputation: {[AgentId]: {[rep_key]: number}}, config: {price_weight, rep_init, rep_alpha, task_types: TaskType[], rep_keys, domains, specialists, scenarios, real_models: bool, fake_llm: bool, orchestrator_model, reviewer_model} }`. Sent on connect, and again after `reset`. |
| `job_split` | `{ job_text, tasks: [{task_id, type, title, brief, depends_on: string[]}], price_weight, usage: Usage }`. `task_id`s are `t1..tN` in execution order. `depends_on` only references earlier tasks. |
| `task_posted` | `{ task_id, type, title, brief, depends_on, index, total, est_input_tokens }`. The task is open for bidding. `index` is 0-based. |
| `bid` | `{ task_id, agent_id, ok, error: string\|null, predicted_output_tokens, est_input_tokens, predicted_cost_usd, promised_quality, confidence, eta_ms, pitch, reputation, score, usage: Usage\|null }`. When `ok:false`, the bid fields are `null`. `reputation` is the value used in the score. `confidence` (0–1) is the agent's own estimate that it will succeed and doesn't affect the score. `eta_ms = round(predicted_output_tokens / TOKENS_PER_SEC[model] × 1000)`. |
| `won` | `{ task_id, agent_id, mode: "auction"\|"fixed", score\|null, runner_up_agent_id\|null, runner_up_score\|null, scores: {[AgentId]: number}, price_weight }`. `mode:"fixed"` is used only by the experiment's fixed arms: there's no bidding, `score` is null and `scores` is `{}`. |
| `working` | `{ task_id, agent_id }`. The work call has started. |
| `done` | `{ task_id, agent_id, output, predicted_output_tokens\|null, predicted_cost_usd\|null, usage: Usage }`. The actual tokens are in `usage`. |
| `graded` | `{ task_id, agent_id, grade, promised_quality\|null, rationale, usage: Usage }`. `usage.model` is the reviewer's model. |
| `rep_update` | `{ task_id, agent_id, task_type, old, new, ratio }` |
| `stats` | `{ total_cost_usd, input_tokens, output_tokens, calls, by_purpose: {split\|bid\|work\|review: {cost_usd, calls}}, by_agent: {[AgentId]: {cost_usd, input_tokens, output_tokens, calls, tasks_won}} }`. `by_agent` counts only `bid` and `work` calls. All four purposes and all three agents are always present. |
| `final` | `{ status: "ok"\|"partial"\|"error", deliverable_task_id\|null, deliverable\|null, tasks: [{task_id, type, agent_id\|null, grade\|null, promised_quality\|null, cost_usd}], total_cost_usd, mean_grade\|null, duration_ms }`. `tasks[].cost_usd` = every ledger entry for that task (bids + work + review). `total_cost_usd` also includes the split. `mean_grade` is over graded tasks only (2 dp). |
| `error` | `{ message, task_id\|null, fatal: bool }` |

The canonical example of every event is `fixtures/fake_run.json`: 37 events, one job, three tasks, each agent wins once, $0.06928. It's generated by `fixtures/make_fake_run.py`, and hand edits to the JSON are forbidden.

## 8. Client → server messages

WebSocket `ws://localhost:8000/ws`, JSON text frames.

| type | payload | server behavior |
|---|---|---|
| `start_job` | `{type, job: string (1–2000 chars), price_weight?: number (0–10)}` | Runs one job and streams its events. If a job is already running on this connection, it replies `error{fatal:false}`. |
| `reset` | `{type}` | Resets reputation to `REP_INIT` for everyone, persists it and re-sends `hello`. Rejected while a job runs. |
| `start_incident` | `{type, scenario_id?: one of payments_pool, ams_db_outage, auth_attack, network_partition, price_weight?: number (0–10)}` | Breaks the named scenario (default `payments_pool`) and runs the MAYDAY incident (§11). Rejected with `error{fatal:false}` while a job or incident runs. |
| `approve_repair` | `{type}` | Human approval: releases a repair that passed the sandbox. Rejected unless an incident is waiting in `awaiting_approval`. |
| `reset_incident` | `{type}` | Cancels any running job or incident, restores the simulator and replies `incident_status{status:"healthy"}` with `job_id:null`. Reputation is kept. |

A disconnect cancels that connection's running job. Reputation is **global to the server process**: it's shared across connections, persisted to `ABYSS_REP_PATH` after every update and loaded on startup.

HTTP routes: `GET /health` returns `{"ok": true}`.

## 9. Repo layout and ownership

```
SPEC.md TASKS.md README.md .gitignore
fixtures/     make_fake_run.py, fake_run.json         (orchestrator-owned)
              make_incident_fixtures.py, incident_*.json
backend/
  pyproject.toml
  abyss/  config.py ledger.py reputation.py scoring.py contract.py
          llm.py prompts.py orchestrator.py agents.py reviewer.py
          market.py events.py cli.py server.py experiment.py
          incident.py scenarios.py commander.py
          responders.py mayday.py                      (MAYDAY)
  tests/
experiments/  jobs.json, splits/ (cache), results/
web/          Vite + React + TypeScript + pixi.js v8
  src/contract.ts  src/sources/  src/state/  src/scene/  src/ui/
runs/         (gitignored) ledger.jsonl, reputation.json, recordings
```

## 11. MAYDAY incident command center

MAYDAY is a hub: incidents from different simulated systems enter the same Commander, which classifies a compressed package and opens only the matching specialist market. Diagnose / remediate / verify still use the v1 auction, work, review, reputation, ledger and events. `v` stays 1.

### 11.1 Commander
The Commander reads `{service, region, source_system, alert, breached metrics, 4 log lines, recent changes}`. Rules always score domains from metric keys, log words and change prefixes. A model may refine the result; invalid or failed model output falls back to rules; severity cannot drop below the rule result. `specialists_dispatched` marks only the primary domain's three models (Haiku / Sonnet / Opus) as dispatched. Labels look like `Database Specialist · Sonnet`. Incident reputation keys are `{domain}.{diagnose|remediate|verify}`.

### 11.2 Scenarios
`backend/abyss/scenarios.py` implements a shared `Scenario` interface. Telemetry is a list of `{key, label, value, unit, ok}`. Remediation is a plan of 1–4 typed actions from that scenario's allowlist (`value`, `region` or `ips`). `sandbox(steps)` applies the plan to a deep copy.

| id | name | domain (rules) | decoy | fix |
|---|---|---|---|---|
| `payments_pool` | Payments API pool exhaustion | database (secondary payments) | `restart_service` | `set_db_pool_size(20)` |
| `ams_db_outage` | Amsterdam primary down | database (secondary networking) | `restart_db(ams)` | `failover_db(fra)` + `route_traffic(fra)` |
| `auth_attack` | Credential stuffing | security | `restart_service` | `apply_rate_limit(20)` + `block_ips(...)` |
| `network_partition` | APAC partition | networking | `restart_service` | `route_traffic(iad)` |

### 11.3 Incident order (one job)
```
incident_received → incident_status(outage) → commander_classified → specialists_dispatched
→ responders_selected → incident_status(investigating) → task[diagnose]
→ incident_status(repairing) → task[remediate]+
   (each: … done → remediation_proposed → sandbox_result → graded …)
→ remediation_plan_created → human_assignments_created
→ incident_status(awaiting_approval) → approval_required
→ approval_granted → incident_status(recovering) → task[verify]
→ incident_status(restored) → service_restored → routing_stats → final(ok)
```
Failure after the last repair attempt emits `incident_escalated` then `incident_status(failed)` → `routing_stats` → `final(error)`. `task_posted` on incident tasks carries `domain`. `rep_update.rep_key` is `{domain}.{task_type}`.

### 11.4 New events
| type | data |
|---|---|
| `incident_received` | catalog fields plus `package`, `package_tokens_est`, `full_context_tokens_est` |
| `commander_classified` | `{scenario_id, domain, secondary_domains, severity, required_specialties, rationale, source: model\|rules, fallback_reason, usage}` |
| `specialists_dispatched` | `{domain, registered, eligible, specialists: [{specialist_id, domain, agent_id, label, dispatched}], reason}` |
| `incident_status` | `{status, scenario_id, service, region, severity, summary, telemetry: Metric[], logs, config_changes}` |
| `responders_selected` | unchanged shape plus Riley (Network Engineer) on the roster |
| `remediation_proposed` / `sandbox_result` | `{task_id, agent_id, attempt, steps: Action[], ...}` |
| `remediation_plan_created` | `{task_id, agent_id, attempt, steps: [{index, action, description, owner_domain}], summary, confidence}` |
| `human_assignments_created` | `{task_id, assignments: [{assignment_id, step_index, action, description, responder_id, name, role, reason, approval_required, status}], required_approvers}` |
| `approval_required` | `{task_id, agent_id, attempt, steps, summary, approvers}` |
| `approval_granted` | `{task_id, approved, approved_by}` |
| `incident_escalated` | `{reason, attempts, escalated_to}` |
| `service_restored` | `{scenario_id, domain, mttr_ms, total_cost_usd, repair_attempts, failed_attempts, steps, confidence, approved_by, verification, grades, rep_changes, telemetry}` |
| `routing_stats` | registered/eligible specialists, auctions, models contacted/skipped, actual ledger totals, estimated avoided tokens/cost, `method` |

`Action = {action, value, region, ips}` with unused params null. `hello.config` also lists `rep_keys`, `domains`, `specialists` and `scenarios`.

### 11.5 Humans
Zak (commander), Maya (database), Alex (backend), Riley (network), Sam (security), Jordan (support). Step owners are fixed by action. SEV-1 adds Zak. Customer impact adds a Jordan notify (no approval). Deployment waits for every `approval_required` assignment. `approve_repair` grants them all.

### 11.6 Replay
`fixtures/incident_<id>.json` is recorded by `fixtures/make_incident_fixtures.py`. Hand edits are forbidden. Replay pauses at `incident_received` until `start_incident` and at `approval_required` until `approve_repair` (`?auto=1` plays through). Switching `scenario_id` loads that recording.

## 10. Change log
- **v1 (H0):** initial freeze. Additions beyond the original 10 event types: `hello` (roster, reputation and config on connect) and `error`.
- **v1 clarification (T01 review):** a failed task segment still ends with `stats`, and a review failure makes `final.status = "partial"`. The wire format is unchanged, so this is not a version bump.
- **v1 clarification (T01 review):** `runs/` paths are relative to the repo root, not the working directory.
- **v1 MAYDAY extension:** additive, so `v` stays 1.
  - Added task types `diagnose`/`remediate`/`verify`. `hello.config.task_types` and reputation now list all six, and `job_split` still accepts only job types.
  - Added `bid.confidence` and `bid.eta_ms`.
  - Added six incident events (§11.3), the incident stream order (§11.2) and client messages `start_incident`/`approve_repair`/`reset_incident`.
  - Reputation files that are missing a type load it at `REP_INIT`.
  - `fake_run.json` was regenerated with the new bid fields; its totals are unchanged ($0.06928).
- **v1 commander hub:** additive.
  - Commander events, specialist domains, four scenarios, multi-step plans, human assignments, routing stats.
  - `start_incident.scenario_id`. Reputation keys for incident work are `{domain}.{task_type}`.
  - Telemetry is a list of metrics. Remediation is a list of typed actions.
