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
Jobs: `research`, `writing`, `checking`. The splitter may only use these.
Incidents (MAYDAY, v1.1): `diagnose`, `remediate`, `verify`. Only the incident workflow (§11) posts them.
Reputation is tracked separately for all six (`config.TASK_TYPES`, in this order).

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
| `TOKENS_PER_SECOND` | haiku 180, sonnet 90, opus 55 (output tok/s, for bid ETA) | — |
| `MAX_REPAIR_ATTEMPTS` | `3` (MAYDAY remediation rounds before escalating) | — |

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
3. `predicted_cost_usd = cost_usd(nominal_model(agent), est_input_tokens, predicted_output_tokens)` and
   `eta_ms = round(predicted_output_tokens / TOKENS_PER_SECOND[nominal_model] × 1000)` (display only; not scored).
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
type TaskType = "research" | "writing" | "checking";
type Usage = {                // one LLM call, from resp.usage
  model: string;              // model actually called
  input_tokens: number; output_tokens: number;
  cost_usd: number; duration_ms: number;
};
```

### 7.4 Events

| type | data |
|---|---|
| `hello` | `{ agents: [{agent_id, display_name, model, color}], reputation: {[AgentId]: {[TaskType]: number}}, config: {price_weight, rep_init, rep_alpha, task_types: TaskType[], real_models: bool, fake_llm: bool, orchestrator_model, reviewer_model} }`. Sent on connect, and again after `reset`. |
| `job_split` | `{ job_text, tasks: [{task_id, type, title, brief, depends_on: string[]}], price_weight, usage: Usage }`. `task_id`s are `t1..tN` in execution order. `depends_on` only references earlier tasks. |
| `task_posted` | `{ task_id, type, title, brief, depends_on, index, total, est_input_tokens }`. The task is open for bidding. `index` is 0-based. |
| `bid` | `{ task_id, agent_id, ok, error: string\|null, predicted_output_tokens, est_input_tokens, predicted_cost_usd, eta_ms, promised_quality, pitch, reputation, score, usage: Usage\|null }`. When `ok:false`, the bid fields are `null`. `reputation` is the value used in the score. |
| `won` | `{ task_id, agent_id, mode: "auction"\|"fixed", score\|null, runner_up_agent_id\|null, runner_up_score\|null, scores: {[AgentId]: number}, price_weight }`. `mode:"fixed"` is used only by the experiment's fixed arms: there's no bidding, `score` is null and `scores` is `{}`. |
| `working` | `{ task_id, agent_id }`. The work call has started. |
| `done` | `{ task_id, agent_id, output, predicted_output_tokens\|null, predicted_cost_usd\|null, usage: Usage }`. The actual tokens are in `usage`. |
| `graded` | `{ task_id, agent_id, grade, promised_quality\|null, rationale, usage: Usage }`. `usage.model` is the reviewer's model. |
| `rep_update` | `{ task_id, agent_id, task_type, old, new, ratio }` |
| `stats` | `{ total_cost_usd, input_tokens, output_tokens, calls, by_purpose: {split\|bid\|work\|review: {cost_usd, calls}}, by_agent: {[AgentId]: {cost_usd, input_tokens, output_tokens, calls, tasks_won}} }`. `by_agent` counts only `bid` and `work` calls. All four purposes and all three agents are always present. |
| `final` | `{ status: "ok"\|"partial"\|"error", deliverable_task_id\|null, deliverable\|null, tasks: [{task_id, type, agent_id\|null, grade\|null, promised_quality\|null, cost_usd}], total_cost_usd, mean_grade\|null, duration_ms }`. `tasks[].cost_usd` = every ledger entry for that task (bids + work + review). `total_cost_usd` also includes the split. `mean_grade` is over graded tasks only (2 dp). |
| `error` | `{ message, task_id\|null, fatal: bool }` |

The canonical example of every event is `fixtures/fake_run.json`: 37 events, one job, three tasks, each agent wins once, $0.06928. It's generated by `fixtures/make_fake_run.py`, and hand edits to the JSON are forbidden.

### 7.5 Incident stream (MAYDAY, v1.1)

An incident is a job whose first event is `incident_status{status:"outage"}` instead of `job_split`. It has no split; each task is created by its `task_posted` and uses exactly the §7.2 task grammar (3 bids, won, stats, working, done, graded, rep_update, stats). Incident events sit around it:

```
[job_id=null] incident_status(healthy)            -- after reset_incident; the baseline
incident_status(outage) → responders_selected → incident_status(investigating)
t1 diagnose  (graded by the blind reviewer)
incident_status(repairing)
t2.. remediate: … done → remediation_proposed → sandbox_result → graded …   (repeat until a sandbox passes, max MAX_REPAIR_ATTEMPTS)
incident_status(awaiting_approval) → approval_required      -- the workflow blocks here until approve_repair
incident_status(recovering)                                  -- the approved action is applied to production
tN verify    (graded by deterministic production health checks)
service_restored → incident_status(restored) → final{status:"ok"}
```
Any failure (market, LLM, no passing repair, verification) emits `incident_status(failed)` then `final{status:"partial"}`. `incident_status` transitions are validated: `outage→investigating→repairing→awaiting_approval→recovering→restored`, any state may go to `failed`. A `healthy` status has `job_id=null`; every other incident event has the incident's `job_id`.

Shared shapes:
```ts
type Telemetry = { db_pool_size, db_pool_in_use, db_waiting, p95_latency_ms, error_rate /*0-1*/,
                   payment_success_rate /*0-1*/, requests_per_min, timeouts_per_min };   // all derived from pool size
type RemediationAction = { action: "set_db_pool_size" | "restart_service" | "rollback_config"; value: int 1-50 | null };  // value only for set_db_pool_size
type Check = { name, passed: bool, detail };
```

| type | data |
|---|---|
| `incident_status` | `{ status: IncidentState, service, severity: "SEV-1"\|"SEV-2"\|"SEV-3"\|null, headline, telemetry: Telemetry, logs: [{level: "INFO"\|"WARN"\|"ERROR", source, message}], config_changes: [{key, old, new, author, minutes_ago}] }` |
| `responders_selected` | `{ severity, required_skills: string[], responders: [{responder_id, name, role, skills, available, workload, score, selected, reason}], briefings: {engineering, support, commander, leadership} }`. All five people are listed; `selected` marks who is paged. |
| `remediation_proposed` | `{ task_id, agent_id, attempt, raw (≤300 chars), valid, action: RemediationAction\|null, rejection\|null }`. `raw` is the winner's output; `valid` means it parsed into an allowlisted action. |
| `sandbox_result` | `{ task_id, agent_id, attempt, action\|null, passed, checks: Check[], telemetry }`. `passed` == every check passed. A rejected proposal gets one failing `allowlist` check and is never executed. |
| `approval_required` | `{ task_id, agent_id, attempt, action, summary, approvers: string[] }` |
| `service_restored` | `{ mttr_ms, total_cost_usd, repair_attempts, failed_attempts, confidence (0-1, winning repair's promised_quality/10), mean_grade, approved_by, action, grades: [{task_id, type, agent_id, grade, promised_quality}], rep_changes: [{task_id, agent_id, task_type, old, new}], verification: Check[], telemetry }`. Every number is computed from the run (ledger, clock, events). |

Remediation and verification grades are `max(1, round(10 × passed_checks / total_checks))` with `usage.model = "deterministic-checks"` and zero cost. The canonical incident is `fixtures/mayday_run.json` (60 events: first repair `restart_service` rejected, second `set_db_pool_size(20)` passes, $0.058085), generated by the same `make_fake_run.py`.

## 8. Client → server messages

WebSocket `ws://localhost:8000/ws`, JSON text frames.

| type | payload | server behavior |
|---|---|---|
| `start_job` | `{type, job: string (1–2000 chars), price_weight?: number (0–10)}` | Runs one job and streams its events. If a job is already running on this connection, it replies `error{fatal:false}`. |
| `reset` | `{type}` | Resets reputation to `REP_INIT` for everyone, persists it and re-sends `hello`. Rejected while a job runs. |
| `start_incident` | `{type}` | MAYDAY: resets this connection's simulator, breaks production and runs the incident workflow (§7.5). Rejected while a job runs. |
| `approve_repair` | `{type}` | Releases a workflow blocked at `approval_required`. Otherwise replies `error{fatal:false}`. |
| `reset_incident` | `{type}` | Cancels a running job, restores the simulator to healthy and emits `incident_status(healthy)` with `job_id=null`. Reputation is kept. Clients send this on connect to get the baseline. |

The simulator is **per connection**; reputation stays global.

A disconnect cancels that connection's running job. Reputation is **global to the server process**: it's shared across connections, persisted to `ABYSS_REP_PATH` after every update and loaded on startup.

HTTP routes: `GET /health` returns `{"ok": true}`.

## 9. Repo layout and ownership

```
SPEC.md TASKS.md README.md .gitignore
fixtures/     make_fake_run.py, fake_run.json, mayday_run.json   (orchestrator-owned)
backend/
  pyproject.toml
  abyss/  config.py ledger.py reputation.py scoring.py contract.py
          llm.py prompts.py orchestrator.py agents.py reviewer.py
          market.py events.py cli.py server.py experiment.py
          incident.py responders.py mayday.py                   (MAYDAY)
  tests/
experiments/  jobs.json, splits/ (cache), results/
web/          Vite + React + TypeScript + pixi.js v8
  src/contract.ts  src/sources/  src/state/  src/scene/  src/ui/
  src/App.tsx (router)  src/MarketApp.tsx (?app=market)  src/mayday/ (default dashboard)
runs/         (gitignored) ledger.jsonl, reputation.json, recordings
```

## 10. Change log
- **v1 (H0):** initial freeze. Additions beyond the original 10 event types: `hello` (roster, reputation and config on connect) and `error`.
- **v1 clarification (T01 review):** a failed task segment still ends with `stats`, and a review failure makes `final.status = "partial"`. The wire format is unchanged, so this is not a version bump.
- **v1 clarification (T01 review):** `runs/` paths are relative to the repo root, not the working directory.
- **v1.1 (MAYDAY):** additive; the envelope stays `v: 1`. New task types `diagnose`/`remediate`/`verify` (in `hello.config.task_types` and `reputation`), `bid.eta_ms`, six incident events (§7.5), three client messages (§8), and incident-stream validation in `contract.validate_stream`. Normal jobs are unchanged except for the two additive fields, and may not contain incident types or events. Old `reputation.json` files load with the new types at `REP_INIT`.

## 11. MAYDAY incident simulator and safety

- `backend/abyss/incident.py` simulates `payments-api`. Healthy: DB pool 20 for a demand of 14 concurrent connections. `break_production()` records a config change `db.pool.max_size 20 -> 2` (deploy-bot, PR #4812). Latency, error rate, payment success, timeouts and logs are pure functions of the pool size, so they are deterministic and never hardcoded in the UI.
- Model output is **never executed**. A remediation must be a single JSON object that `parse_action` accepts: exactly `{"action":"set_db_pool_size","value":<int 1-50>}`, `{"action":"restart_service"}` or `{"action":"rollback_config"}`. Anything else (prose, shell, extra keys, wrong types, out-of-range values) is rejected and shown as a failed `sandbox_result`.
- A valid action runs first against a **copy** of production (`sandbox`), then waits for a human `approve_repair`, and only then is applied to production. The incident is `restored` only after the production health checks (pool capacity, p95 ≤ 300ms, errors ≤ 1%, payments ≥ 99%, zero timeouts) all pass.
- Rescue team (`responders.py`): required skills are derived from the evidence (pool/config → database + connection-pooling, 5xx → payments-api, failed payments → customer-comms, SEV-1 → incident-command). Score = 10 × matched skills (+5 for command on SEV-1) − 2 × workload; paged if available, matched and score > 0. Briefings for engineers, support, the commander and leadership are built from the live telemetry.
- Fake mode (`ABYSS_FAKE_LLM=1`) scripts the incident answers: the first remediation is `restart_service` (fails the sandbox), and the retry, whose brief lists the failed attempt, is `set_db_pool_size(20)` (passes).
