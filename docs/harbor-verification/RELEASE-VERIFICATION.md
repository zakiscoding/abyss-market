# Side-panel cleanup and release verification

September 26, 2026. Scope: Evidence, Ledger, Crew and one additive notification-status event. No harbor artwork, physical stalls, boat, sandbox, workflow placement, inbox structure or page proportions were changed. No merge or deployment was performed.

## Problems fixed

- Evidence logs use fixed metadata columns and word-wrapped messages. Within the frozen narrow sidebar, messages occupy a full-width second row. Long messages have an ellipsis preview and an expandable full message. Search, severity filter, real display pause/resume, auto-scroll and Captain highlights remain usable.
- Standby and Reset show an empty evidence prompt, never untriggered failure logs or incident metrics. Before metrics come from the original outage; recovery metrics come from the restoration event.
- Logs, Metrics, Services and Changes are populated from recorded events. Changes show IDs, recorded relative times, correlation and whether a rollback was recorded. Services show the recorded service, region and recovery health. Dependency inventory is explicitly marked unrecorded instead of guessing a topology.
- Ledger now shows Model Market, foundation-model counts separately from specialty routes, availability, domain reputation, observed session sandbox validation rate, catalog cost estimates and recorded worker selection history. Unavailable providers remain unavailable. Haiku test mode explicitly identifies its single underlying model.
- The event-derived Task Board is hidden at standby. The default audit timeline uses human-readable labels; duplicate hello display is suppressed while every retained raw event stays under Developer details.
- Crew shows individual Human badges, roles, selection reasons, alert state, review responsibilities, approval state and final state. Unselected people explicitly say Not alerted and Not required.
- Discord status displays named crew recipients and Queued, Sent, Failed or Disabled. Sent means Discord accepted the request, not that a person received or opened it. Failure leaves incident review usable.

## Exact verification results

| Check | Result |
| --- | --- |
| `python -m pytest -q` in backend | 216 passed |
| `abyss.contract.validate_stream` on every `fixtures/*.json` | 5/5 passed |
| `npm.cmd test` in web | 65 passed across 10 files |
| `npx.cmd tsc --noEmit` in web | Passed |
| `npm.cmd run build` in web | Passed; existing >500 kB chunk advisory |
| `python web/scripts/verify-release.py` | 16/16 passed: 4 scenarios × 2 desktop sizes × replay/fake-backend |
| `python web/scripts/verify-polish.py` | 8/8 harbor regression combinations passed |
| Docker Compose configuration | Not run: Docker executable is absent |

Sizes: 1440×900 and 1920×1080. Every release smoke case checks standby evidence; trigger; classification; primary/secondary stall state; failed sandbox and passing retry; exact human crew; log search/filter/expand/pause/resume; exact validated plan application; recovery; retained MTTR; simulated cost; reputation/history updates; all Evidence tabs; Ledger; Run again; second completed history entry; and Reset to clean evidence. The harbor regression separately checks geometry, revision/rejection/resume and approval controls.

Evidence: [release-results.json](release-results.json), [harbor regression results](polish-results.json), [Logs at 1440](release-logs-1440.png), [Logs at 1920](release-logs-1920.png), [Ledger at 1440](release-ledger-1440.png), [Ledger at 1920](release-ledger-1920.png). Screenshots were visually inspected for text readability and preservation of the scene.

## Discord test result

All four fake-engine scenarios were run with configured mock recipient IDs and intercepted HTTP posting. Each message tagged exactly its expected paged crew and emitted Queued → Sent. Separate tests cover Disabled and Queued → Failed; recovery still completes after notification failure. Contract tests reject unknown recipients, `delivered`, webhook fields and authorization fields. Existing HTTP tests verify restricted allowed mentions. No real Discord message was sent; external connectivity and permissions remain unverified.

The additive v1 `notification_status` payload is:

```json
{"channel":"discord","status":"disabled","recipients":["Zak","Maya","Alex","Jordan"]}
```

Allowed statuses are `queued`, `sent`, `failed`, `disabled`; recipients are names from the six-person roster. The event requires a job ID and follows approval_required. Queued can transition once to Sent or Failed; Disabled is terminal. Existing recordings without this event remain accepted. There is no token, webhook, authorization header, raw mention ID or provider exception field. Fixture recording explicitly disables external notification configuration.

## Remaining limitations and blockers

1. **Strict cheapest-qualified selection is not guaranteed by the existing auction.** It ranks quality × reputation minus weighted cost. Comparing the unchanged recordings with the frontend qualification thresholds found Amsterdam task t2 selects Opus while Haiku is the cheaper qualifier, and Authentication task t3 selects Sonnet while Haiku is cheaper. Payments and APAC match that comparison. The UI preserves the recorded winner and distinguishes estimated best fit. This blocks an “always cheapest qualified” product claim; changing auction behavior is outside this frozen incident/side-panel pass.
2. The contract has no dependency inventory or absolute change timestamps. Services says dependency topology is not recorded; Changes uses recorded minutes-before-incident and elapsed simulation time. Metrics only show available scenario telemetry; missing metrics are not invented.
3. Model prices are existing catalog estimates, not newly verified provider quotes. Validation history is limited to retained session events. Real providers and external Discord delivery were not exercised.
4. Revision/rejection are local review holds, not model replanning. Human authorization is a demo persona action. History clears on reload and retains the existing 20-run limit.
5. Docker/Compose validation and a public-host deployment smoke test remain release gates. No deployment target was supplied. Local replay and backend fake mode passed; hosted deployment is not certified by this report.

## Files changed in this pass

- `backend/abyss/contract.py`, `backend/abyss/mayday.py` — additive safe notification event and status emission.
- `backend/tests/test_contract_incident.py`, `backend/tests/test_mayday.py` — schema, lifecycle, mock recipients, non-blocking failure and exact plan tests.
- `web/src/contract.ts`, `web/src/state/reducer.ts` — mirrored event and per-incident status storage/reset.
- `web/src/sources/fixture.ts`, `web/src/ui/mayday/mayday.test.ts` — replay displays notification status before pausing for approval.
- `web/src/ui/mayday/EvidencePanel.tsx`, `LedgerPanel.tsx`, `side-panels.css`, `sidePanels.test.tsx` — side-panel rendering, selectors, responsive rules and 12 regression tests.
- `web/src/ui/mayday/MaydayApp.tsx`, `CommandPanels.tsx`, `derive.ts`, `panels.tsx` — panel integration, crew details, honest labels and standby evidence guard.
- `fixtures/incident_payments_pool.json`, `incident_ams_db_outage.json`, `incident_auth_attack.json`, `incident_network_partition.json` — one Disabled status event each, with sequence numbers updated; existing timing, plans and outcomes preserved.
- `fixtures/make_incident_fixtures.py` — disable external notifications during recording and give the new event zero extra pacing.
- `web/scripts/verify-release.py` — repeatable replay/fake-backend browser smoke test.
- This report, `release-results.json`, `release-*.png`, and refreshed `polish-*.png` / `polish-results.json` — verification evidence.

`FINAL-POLISH.md` and the existing README edit were already present from the prior pass. The `.agents`, `.cursor` and `.vscode` workspace files were not part of this cleanup.

## Safe integration order

After fetching refs, origin/main was `303a69b`, the same base as the current feature/backend-hardening checkout. Two remote branches have unmerged commits: `origin/feature/mayday` and `origin/demo-visuals`.

1. Review this pass as one atomic backend-contract + TypeScript/reducer + fixtures + UI change. Avoid publishing new fixtures to an old frontend.
2. Have the branch owners confirm whether the older MAYDAY branch is superseded. It overlaps contracts, server, state and UI; do not blindly merge it over the frozen harbor. Selectively reconcile genuinely missing work first if it is still required.
3. Keep demo-visuals out of the production harbor release unless its independent demo artifacts are explicitly needed. It adds a separate Phaser demo and mockup assets.
4. Re-run validation after any integration, then merge the reviewed release changes to current main. No automatic merge was attempted.

## Exact final demo commands

Replay, no backend or provider credentials required, from the repository root in PowerShell:

```powershell
cd web
npm.cmd install
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173/?source=replay&speed=2`. Keep Zak selected. Trigger Payments, inspect the failed sandbox and passing retry, review Crew and Discord Disabled status, approve, inspect the evidence tabs and Ledger, then Run again and Reset. Repeat with Amsterdam, Authentication and APAC. Do not use auto=1 for the interactive approval demonstration.

Backend fake-mode verification, terminal 1 from the repository root:

```powershell
cd backend
python -m pip install -e ".[dev]"
$env:ABYSS_FAKE_LLM = "1"
$env:ABYSS_FAKE_DELAY = "0.005"
$env:ABYSS_REP_PATH = "../runs/release-reputation.json"
$env:ABYSS_LEDGER_PATH = "../runs/release-ledger.jsonl"
Remove-Item Env:DISCORD_WEBHOOK_URL,Env:DISCORD_BOT_TOKEN,Env:DISCORD_CHANNEL_ID -ErrorAction SilentlyContinue
python -m uvicorn abyss.server:app --host 127.0.0.1 --port 8001
```

Terminal 2 from the repository root:

```powershell
cd web
$env:VITE_WS_URL = "ws://127.0.0.1:8001/ws"
npm.cmd run dev -- --host 127.0.0.1 --port 5188 --strictPort
```

Open `http://127.0.0.1:5188/?source=ws`. To repeat the complete browser smoke test, terminal 3 from the repository root:

```powershell
python -m pip install playwright
python web/scripts/verify-release.py
```

Microsoft Edge must be installed. Avoid source/fixture edits during browser checks because Vite reloads pages. The original harbor regression uses the replay dev server on port 5173.

Once Docker is available, the remaining container check is `docker compose config --quiet`, then `docker compose up --build` and the four-scenario smoke test at `http://localhost:8080/?source=ws`.

Product feature work stops here. The release handoff is branch reconciliation, container/host validation, a backup recording of the replay sequence, and pitch rehearsal using the documented scoring and simulation limitations.
