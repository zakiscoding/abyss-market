# Final frontend polish

Completed September 26, 2026. Preserved the five-stall harbor artwork and layout, incident plans, backend event contracts and deterministic replay behavior.

## Fixes

- Completed MTTR takes precedence over missing outage timing. Active timing starts at the received event; a new incident and Reset clear it. Each history record retains its own MTTR.
- Captain Readout derives incident, root-cause domain, specialty, repair worker, applied steps, sandbox outcome, recovery checks, approvers, MTTR and cost from events. Payments retains the requested cross-domain explanation during investigation.
- Alex is consistently the Payments Engineer in the backend roster and four recordings. Demo personas use the requested names and roles. Discord labels use the canonical roster; configured mentions follow crew and specialty ownership. The legacy Incident Commander ID mapping remains supported for Zak.
- Crew and history share final states. Step owners assigned after initial paging are included. Completed chat no longer describes people as watching or reviewing.
- Removed the duplicate header status. Remaining order: primary badge, service, region, cost, MTTR.
- Completed cards say Run again with a tooltip explaining the new simulation. Starts are gated until the current job finishes or resets. Fixed-file replay also repeats, with a distinct ID per run.
- Workflow labels have slightly larger type and stronger contrast. Six stages, component footprint, physical stalls and Captain anchoring are preserved.
- Primary stall becomes RESTORED; monitoring stalls become RECOVERY CONFIRMED; unrelated stalls remain IDLE. One primary repair worker remains selected.

## Validation

- `cd web; npm.cmd test`: **53 passed**, nine test files.
- `cd web; npx.cmd tsc --noEmit`: **passed**.
- `cd web; npm.cmd run build`: **passed**, with the existing Vite advisory for a JavaScript chunk over 500 kB.
- `cd backend; python -m pytest -q`: **204 passed**. Discord tests use mocked configuration; no notification was sent.
- `python web/scripts/verify-polish.py`: **8/8 scenario/viewport combinations passed** in headless Microsoft Edge.

Each of the four scenarios passed at 1440×900 and 1920×1080. Recorded event prefixes check detected, classified, worker selection, failed sandbox, successful retry, awaiting approval, approval granted and completion. Real gated replay controls exercise revision, rejection, resume, approval, Run again and Reset. Checks cover standby, disabled concurrent starts, retained history, MTTR, crew/history agreement, Inbox/Crew/Evidence/Ledger, one primary worker, label/header bounds, workflow text fit and Captain position. Representative screenshots were visually inspected.

Results: [polish-results.json](polish-results.json). Screenshots for every scenario/viewport are `polish-<scenario>-<width>.png`. Examples: [Payments at 1440](polish-payments_pool-1440.png), [Amsterdam at 1920](polish-ams_db_outage-1920.png), [Authentication at 1440](polish-auth_attack-1440.png), [APAC at 1920](polish-network_partition-1920.png).

## Files changed

- `web/src/state/incident.ts` — shared crew and elapsed-time selectors.
- `web/src/state/reducer.ts` — received-event timing and crew history snapshots.
- `web/src/sources/fixture.ts` — fixed-file repeat runs and concurrent-start protection.
- `web/src/ui/mayday/IncidentTimer.tsx` — testable header timer.
- `web/src/ui/mayday/MaydayApp.tsx` — timer, header, Captain summary and start gating.
- `web/src/ui/mayday/command.ts` — event-derived summary, named personas and completed chat.
- `web/src/ui/mayday/CommandPanels.tsx` — shared crew states and cost-label propagation.
- `web/src/ui/mayday/panels.tsx` — Run again and crew history.
- `web/src/ui/mayday/harborView.ts` — secondary recovery label.
- `web/src/ui/mayday/harbor-scene.css` — workflow readability.
- `web/src/ui/mayday/polish.test.tsx` — sixteen scenario/component regression tests.
- `web/src/ui/mayday/mayday.test.ts` — repeat replay and concurrent-start assertions.
- `backend/abyss/responders.py` — Alex's role label.
- `backend/abyss/discord.py` — roster labels and deterministic mention ownership.
- `backend/tests/test_discord.py` — roster and ownership tests.
- `fixtures/incident_payments_pool.json`, `fixtures/incident_ams_db_outage.json`, `fixtures/incident_auth_attack.json`, `fixtures/incident_network_partition.json` — Alex's role label only; plans and timings unchanged.
- `web/scripts/verify-polish.py` — repeatable desktop verification.
- `docs/harbor-verification/FINAL-POLISH.md`, `README.md`, `polish-results.json`, `polish-*.png` — documentation and evidence.

The pre-existing `backend/abyss/mayday.py` edit was left untouched by this pass. Another process committed the implementation during verification; the list includes those committed files.

## Remaining demo limitations

- Replay uses recorded timing and simulated cost. All four recordings report 69,400 ms; the UI reads the recorded value. Playback speed does not change recorded MTTR.
- Request revision and Reject repair are local review holds. They pause simulated application without generating a new plan. Resume review reopens the decision.
- Approval is a demo persona action, not authenticated individual signatures. Approver names come from recorded/backend events.
- History is session-only, retains the existing 20-run limit and clears on reload.
- Real-provider execution and external Discord delivery were not exercised. Repairs apply only to the simulated cluster.

## Exact demonstration steps

From the repository root in PowerShell:

```powershell
cd web
npm.cmd install
npm.cmd run dev -- --host 127.0.0.1
```

1. Open `http://127.0.0.1:5173/?source=replay` at 1440×900 or 1920×1080. Add `&speed=2` for faster playback. Leave `auto` off for interactive approval.
2. Keep **Zak - Incident Commander** selected. In Inbox, trigger Payments API pool exhaustion.
3. Observe Database Repair as ACTIVE · ROOT CAUSE and Payments Operations as MONITORING · AFFECTED SERVICE. Watch the failed deterministic sandbox attempt and successful retry.
4. In Crew, choose Request revision, then Resume review; choose Reject repair, then Resume review. Approval stays disabled while held.
5. Choose Approve repair. Inspect the Captain outcome, retained MTTR, receipt, final crew states, Evidence and Ledger.
6. Return to Inbox, choose Run again and complete another approval. Both completed runs remain in history.
7. Choose Reset: timer returns to 00:00 and history remains. Repeat with Amsterdam, Authentication and APAC.

To reproduce browser verification from the repository root with Vite running:

```powershell
python -m pip install playwright
python web/scripts/verify-polish.py
```

Microsoft Edge must be installed. Avoid source edits or fixture-copy commands during browser checks because Vite reloads the page.
