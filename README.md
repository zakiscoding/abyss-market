# MAYDAY

**AI incident response, powered by the Abyss Agent Market.**

Production breaks. Three AI responders (Haiku, Sonnet, Opus) bid cost, promised
quality, confidence and ETA to diagnose it, repair it and verify it. Reputation
decides who wins. Every repair is an allowlisted action tested in a sandbox copy
of the service. A human rescue team is paged by skill, and nothing reaches
production until a human clicks **Approve Repair**.

![MAYDAY awaiting human approval](docs/mayday-approval.png)

## Demo sequence

1. **Break Production.** A bad config change (`cfg-2291`) shrinks the Payments API DB pool from 20 to 2.
2. HTTP 500s, latency, connection timeouts and failed payments appear. SEV-1 is declared.
3. The rescue team is paged: Zak (commander), Maya (DB), Alex (backend) and Jordan (support). Sam (security) isn't, and the dashboard says why.
4. Three diagnosis bids arrive and the best score wins: `quality × reputation − price`.
5. Remediation bids arrive. The first repair (`restart_service`) **fails the sandbox** and its agent loses remediation reputation.
6. A second auction runs, and `set_db_pool_size(20)` passes every sandbox check.
7. **Approve Repair.** The fix is deployed, a verify auction runs and deterministic health checks pass.
8. The service is restored. The dashboard shows MTTR, total AI cost, repair attempts, confidence, grades, verification and reputation changes, all calculated from events.

| Outage | Resolved |
|---|---|
| ![incident](docs/mayday-incident.png) | ![restored](docs/mayday-restored.png) |

## Setup

Requires Python 3.11+ and Node 20+.

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -e ".[dev]"      # macOS/Linux: .venv/bin/pip
cd ../web
npm install
```

## Run

**Replay** (no backend, no internet, no keys). This is the safest demo:

```bash
cd web
npm run dev
# http://localhost:5173/                  presenter-driven: click Break Production, then Approve Repair
# http://localhost:5173/?auto=1&speed=2   plays straight through
```

**Fake live** (the real backend and market, with a deterministic fake LLM at zero cost):

```bash
cd backend
ABYSS_FAKE_LLM=1 .venv/Scripts/python -m uvicorn abyss.server:app --port 8000
# PowerShell: $env:ABYSS_FAKE_LLM="1"; .venv\Scripts\python -m uvicorn abyss.server:app --port 8000
cd web && npm run dev
# http://localhost:5173/?source=ws
```

**Real models.** Set `ANTHROPIC_API_KEY` in your environment (never commit it). Without `ABYSS_REAL_MODELS=1`, every role runs on Haiku (cheap test mode):

```bash
ABYSS_REAL_MODELS=1 .venv/Scripts/python -m uvicorn abyss.server:app --port 8000
```

Other views are `?app=market` (the original Abyss market, replaying `fake_run.json`), `?view=results` (experiment charts) and `?ledger=1` (the ledger drawer).

## Test

```bash
cd backend && .venv/Scripts/python -m pytest -q
.venv/Scripts/python -m abyss.contract ../fixtures/mayday_run.json
.venv/Scripts/python -m abyss.contract ../fixtures/fake_run.json
cd ../web && npm test && npm run build     # build runs tsc --noEmit first
```

Regenerate the fixtures after any contract change: `backend/.venv/Scripts/python fixtures/make_mayday_run.py` and `python fixtures/make_fake_run.py`.

## Safety

- AI output is never executed. Remediation is parsed into one of three allowlisted actions (`set_db_pool_size`, `restart_service`, `rollback_config`) and rejected otherwise.
- Every repair runs on a sandbox copy of the simulated service first. Production changes only after `approve_repair`.
- The incident isn't marked restored until deterministic production health checks pass.
- Secrets come only from environment variables and are never logged.

## How it's built

MAYDAY reuses the Abyss engine unchanged: the auction (`scoring.py`, `market._run_auction`), work and review calls, the per-task-type reputation EMA, the ledger, validated WebSocket events and the replay. It adds:

- `backend/abyss/incident.py`: the deterministic Payments API simulator, action allowlist and sandbox.
- `backend/abyss/responders.py`: the rescue-team selection and audience-specific briefings.
- `backend/abyss/mayday.py`: the incident workflow (diagnose → remediate → sandbox → approve → deploy → verify).
- `web/src/ui/mayday/` and `web/src/scene/harbor/`: the ops dashboard and the Pixi harbor scene.

The contract is in [SPEC.md](SPEC.md) (§11 covers MAYDAY).
