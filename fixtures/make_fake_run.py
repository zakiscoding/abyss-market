"""Generate the replay fixtures — hand-authored runs that obey SPEC.md exactly.

    fixtures/fake_run.json    a normal Abyss job (research -> writing -> checking)
    fixtures/mayday_run.json  a MAYDAY incident (outage -> diagnose -> remediate x2
                              -> approval -> verify -> restored)

Stdlib only. All derived numbers (costs, scores, ETAs, reputation, stats
snapshots, final totals) are computed with the same formulas as SPEC.md. The
incident telemetry, logs, health checks and rescue team come from the backend's
own deterministic simulator (backend/abyss/incident.py, responders.py), which
are stdlib-only too. Re-run after any contract change:

    python fixtures/make_fake_run.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from abyss.incident import (  # noqa: E402
    SERVICE,
    PaymentsSimulator,
    checks_grade,
    describe_action,
    parse_action,
)
from abyss.responders import select_responders  # noqa: E402

PRICES = {  # USD per 1M tokens: (input, output)
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-opus-5": (5.00, 25.00),
}
TOKENS_PER_SECOND = {"claude-haiku-4-5": 180.0, "claude-sonnet-5": 90.0, "claude-opus-5": 55.0}
AGENTS = [
    {"agent_id": "haiku", "display_name": "Haiku 4.5", "model": "claude-haiku-4-5", "color": "#4fb3a9"},
    {"agent_id": "sonnet", "display_name": "Sonnet 5", "model": "claude-sonnet-5", "color": "#e8a33d"},
    {"agent_id": "opus", "display_name": "Opus 5", "model": "claude-opus-5", "color": "#8e6cc9"},
]
AGENT_MODEL = {a["agent_id"]: a["model"] for a in AGENTS}
TASK_TYPES = ["research", "writing", "checking", "diagnose", "remediate", "verify"]
PRICE_WEIGHT = 1.0
REP_INIT = 1.0
REP_ALPHA = 0.3
ORCH_MODEL = "claude-sonnet-5"
REVIEW_MODEL = "claude-sonnet-5"
CHECK_USAGE = {"model": "deterministic-checks", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "duration_ms": 0}


def cost_usd(model: str, inp: int, out: int) -> float:
    pin, pout = PRICES[model]
    return round((inp * pin + out * pout) / 1_000_000, 6)


def usage(model: str, inp: int, out: int, ms: int) -> dict:
    return {
        "model": model,
        "input_tokens": inp,
        "output_tokens": out,
        "cost_usd": cost_usd(model, inp, out),
        "duration_ms": ms,
    }


def score(q: int, rep: float, pred_cost: float) -> float:
    return round(q * rep - PRICE_WEIGHT * pred_cost * 100, 3)


def eta_ms(model: str, tokens: int) -> int:
    return round(tokens / TOKENS_PER_SECOND[model] * 1000)


class Recorder:
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id
        self.events: list[dict] = []
        self.ledger: list[dict] = []  # {purpose, agent_id, task_id, usage}
        self.rep = {a["agent_id"]: {t: REP_INIT for t in TASK_TYPES} for a in AGENTS}
        self.wins = {a["agent_id"]: 0 for a in AGENTS}
        self.final_tasks: list[dict] = []
        self.grades: list[dict] = []
        self.rep_changes: list[dict] = []
        self.t = 0

    def emit(self, t: int, type_: str, data: dict, job: bool = True) -> None:
        self.events.append({
            "v": 1, "seq": len(self.events), "t": t,
            "job_id": self.job_id if job else None, "type": type_, "data": data,
        })

    def hello(self) -> None:
        self.emit(0, "hello", {
            "agents": AGENTS,
            "reputation": json.loads(json.dumps(self.rep)),
            "config": {
                "price_weight": PRICE_WEIGHT,
                "rep_init": REP_INIT,
                "rep_alpha": REP_ALPHA,
                "task_types": TASK_TYPES,
                "real_models": True,
                "fake_llm": False,
                "orchestrator_model": ORCH_MODEL,
                "reviewer_model": REVIEW_MODEL,
            },
        }, job=False)

    def stats(self) -> dict:
        by_purpose = {p: {"cost_usd": 0.0, "calls": 0} for p in ["split", "bid", "work", "review"]}
        by_agent = {
            a["agent_id"]: {"cost_usd": 0.0, "input_tokens": 0, "output_tokens": 0, "calls": 0,
                            "tasks_won": self.wins[a["agent_id"]]}
            for a in AGENTS
        }
        tot_c, tot_i, tot_o = 0.0, 0, 0
        for e in self.ledger:
            u = e["usage"]
            tot_c += u["cost_usd"]
            tot_i += u["input_tokens"]
            tot_o += u["output_tokens"]
            bp = by_purpose[e["purpose"]]
            bp["cost_usd"] += u["cost_usd"]
            bp["calls"] += 1
            if e["agent_id"] is not None and e["purpose"] in ("bid", "work"):
                ba = by_agent[e["agent_id"]]
                ba["cost_usd"] += u["cost_usd"]
                ba["input_tokens"] += u["input_tokens"]
                ba["output_tokens"] += u["output_tokens"]
                ba["calls"] += 1
        for d in list(by_purpose.values()) + list(by_agent.values()):
            d["cost_usd"] = round(d["cost_usd"], 6)
        return {
            "total_cost_usd": round(tot_c, 6),
            "input_tokens": tot_i,
            "output_tokens": tot_o,
            "calls": len(self.ledger),
            "by_purpose": by_purpose,
            "by_agent": by_agent,
        }

    def run_task(self, task: dict, index: int, total: int, grader=None) -> dict:
        """One market round. `grader(winner, t)` may emit events between done
        and graded and returns (grade, rationale, usage, t); default is the
        blind reviewer from task["review"]."""
        tid, ttype = task["task_id"], task["type"]
        t = self.t
        self.emit(t, "task_posted", {
            "task_id": tid, "type": ttype, "title": task["title"], "brief": task["brief"],
            "depends_on": task["depends_on"], "index": index, "total": total,
            "est_input_tokens": task["est_input_tokens"],
        })
        bid_start = t
        scores, preds = {}, {}
        # bids arrive in order of their call duration (they run concurrently)
        for aid, b in sorted(task["bids"].items(), key=lambda kv: kv[1]["u"][2]):
            inp, out, ms = b["u"]
            model = AGENT_MODEL[aid]
            u = usage(model, inp, out, ms)
            self.ledger.append({"purpose": "bid", "agent_id": aid, "task_id": tid, "usage": u})
            pred_cost = cost_usd(model, task["est_input_tokens"], b["pred"])
            r = self.rep[aid][ttype]
            s = score(b["q"], r, pred_cost)
            scores[aid] = s
            preds[aid] = (b["pred"], pred_cost, b["q"])
            self.emit(bid_start + ms, "bid", {
                "task_id": tid, "agent_id": aid, "ok": True, "error": None,
                "predicted_output_tokens": b["pred"], "est_input_tokens": task["est_input_tokens"],
                "predicted_cost_usd": pred_cost, "eta_ms": eta_ms(model, b["pred"]),
                "promised_quality": b["q"], "pitch": b["pitch"],
                "reputation": r, "score": s, "usage": u,
            })
        t = bid_start + max(b["u"][2] for b in task["bids"].values()) + 50
        order = [a["agent_id"] for a in AGENTS]
        ranked = sorted(scores, key=lambda a: (-scores[a], preds[a][1], order.index(a)))
        winner, runner = ranked[0], ranked[1]
        self.wins[winner] += 1
        self.emit(t, "won", {
            "task_id": tid, "agent_id": winner, "mode": "auction", "score": scores[winner],
            "runner_up_agent_id": runner, "runner_up_score": scores[runner],
            "scores": scores, "price_weight": PRICE_WEIGHT,
        })
        self.emit(t + 10, "stats", self.stats())
        t += 50
        self.emit(t, "working", {"task_id": tid, "agent_id": winner})
        inp, out, ms = task["work"]["u"]
        wu = usage(AGENT_MODEL[winner], inp, out, ms)
        self.ledger.append({"purpose": "work", "agent_id": winner, "task_id": tid, "usage": wu})
        t += ms
        self.emit(t, "done", {
            "task_id": tid, "agent_id": winner, "output": task["work"]["output"],
            "predicted_output_tokens": preds[winner][0], "predicted_cost_usd": preds[winner][1],
            "usage": wu,
        })
        if grader is None:
            inp, out, ms = task["review"]["u"]
            ru = usage(REVIEW_MODEL, inp, out, ms)
            self.ledger.append({"purpose": "review", "agent_id": None, "task_id": tid, "usage": ru})
            t += ms
            grade, rationale = task["review"]["grade"], task["review"]["rationale"]
        else:
            grade, rationale, ru, t = grader(winner, t)
        promised = preds[winner][2]
        self.emit(t, "graded", {
            "task_id": tid, "agent_id": winner, "grade": grade, "promised_quality": promised,
            "rationale": rationale, "usage": ru,
        })
        old = self.rep[winner][ttype]
        ratio = round(min(2.0, max(0.0, grade / promised)), 4)
        new = round(old + REP_ALPHA * (ratio - old), 4)
        self.rep[winner][ttype] = new
        self.emit(t + 10, "rep_update", {
            "task_id": tid, "agent_id": winner, "task_type": ttype, "old": old, "new": new, "ratio": ratio,
        })
        self.emit(t + 20, "stats", self.stats())
        self.t = t + 100
        self.final_tasks.append({
            "task_id": tid, "type": ttype, "agent_id": winner, "grade": grade,
            "promised_quality": promised,
            "cost_usd": round(sum(e["usage"]["cost_usd"] for e in self.ledger if e["task_id"] == tid), 6),
        })
        self.grades.append({"task_id": tid, "type": ttype, "agent_id": winner, "grade": grade,
                            "promised_quality": promised})
        self.rep_changes.append({"task_id": tid, "agent_id": winner, "task_type": ttype, "old": old, "new": new})
        return {"winner": winner, "promised": promised, "grade": grade, "output": task["work"]["output"]}

    def final(self, status: str, deliverable: dict) -> None:
        grades = [g["grade"] for g in self.grades]
        self.emit(self.t, "final", {
            "status": status,
            "deliverable_task_id": deliverable["task_id"],
            "deliverable": deliverable["work"]["output"],
            "tasks": self.final_tasks,
            "total_cost_usd": self.stats()["total_cost_usd"],
            "mean_grade": round(sum(grades) / len(grades), 2),
            "duration_ms": self.t,
        })

    def write(self, name: str) -> None:
        out = Path(__file__).with_name(name)
        out.write_text(json.dumps(self.events, indent=2) + "\n")
        print(f"wrote {out} ({len(self.events)} events, total ${self.stats()['total_cost_usd']})")


# ---------------------------------------------------------------- normal job
JOB_TEXT = (
    "Write a short explainer (under 150 words) on why most coasts get two "
    "high tides a day, and fact-check it."
)
TASKS = [
    {
        "task_id": "t1",
        "type": "research",
        "title": "Gather the tide physics",
        "brief": "List the key physical facts that explain two daily high tides, including the Sun's relative contribution and the length of a tidal day.",
        "depends_on": [],
        "est_input_tokens": 180,
        "bids": {
            "haiku": dict(pred=400, q=8, pitch="Fast, cheap, and I know my tides.", u=(350, 60, 1200)),
            "sonnet": dict(pred=500, q=8, pitch="Balanced research, sources in mind.", u=(350, 140, 1900)),
            "opus": dict(pred=600, q=9, pitch="Deep, precise physics. No hand-waving.", u=(350, 180, 2500)),
        },
        "work": dict(u=(210, 455, 4200), output=(
            "- Tides are driven mainly by the Moon's gravity; the Sun's tidal force is about 46% of the Moon's.\n"
            "- The Moon pulls near-side ocean water toward it, forming a bulge.\n"
            "- A second bulge forms on the far side because the Moon pulls Earth's center harder than the far-side water.\n"
            "- Earth rotates through both bulges, giving two high tides about every 24 hours 50 minutes.\n"
            "- Spring tides happen at new and full moon, when Sun and Moon line up."
        )),
        "review": dict(u=(700, 120, 2300), grade=6, rationale=(
            "Facts are correct but thin: the far-side bulge is asserted, not explained, and there is no caveat about diurnal coasts."
        )),
    },
    {
        "task_id": "t2",
        "type": "writing",
        "title": "Draft the explainer",
        "brief": "Using the research, write a plain-language explainer under 150 words for a general reader.",
        "depends_on": ["t1"],
        "est_input_tokens": 420,
        "bids": {
            "haiku": dict(pred=250, q=8, pitch="Tight 150 words, lowest price on the pier.", u=(560, 58, 1100)),
            "sonnet": dict(pred=300, q=9, pitch="Clear prose that actually uses the research.", u=(560, 150, 2000)),
            "opus": dict(pred=350, q=9, pitch="Polished. Every sentence earns its place.", u=(560, 170, 2600)),
        },
        "work": dict(u=(470, 720, 9800), output=(
            "Why two high tides a day?\n\n"
            "The Moon's gravity tugs on all of Earth, but not evenly. Water on the side facing the Moon is pulled "
            "a little harder than Earth's center, so it heaps into a bulge. On the far side, Earth's center is pulled "
            "harder than the distant water, which is left behind as a second bulge. As Earth spins, a coastline passes "
            "through both bulges, so most places see two high tides roughly every 24 hours and 50 minutes. The extra "
            "50 minutes comes from the Moon moving along its orbit while we turn. The Sun adds a smaller tidal pull, "
            "about 46% of the Moon's; when the two line up at new and full moon, we get extra-high spring tides."
        )),
        "review": dict(u=(820, 110, 2100), grade=9, rationale=(
            "Accurate, readable, under the length limit, and it explains the far-side bulge well."
        )),
    },
    {
        "task_id": "t3",
        "type": "checking",
        "title": "Fact-check the draft",
        "brief": "Check every factual claim in the draft. Give a verdict and list any errors or needed caveats.",
        "depends_on": ["t2"],
        "est_input_tokens": 380,
        "bids": {
            "haiku": dict(pred=200, q=9, pitch="I'll check every number, quick.", u=(520, 55, 1000)),
            "sonnet": dict(pred=250, q=9, pitch="Careful line-by-line fact-check.", u=(520, 130, 1800)),
            "opus": dict(pred=300, q=10, pitch="Rigorous check against known physics.", u=(520, 160, 2400)),
        },
        "work": dict(u=(430, 610, 11200), output=(
            "Verdict: accurate, one caveat.\n"
            "- Two bulges from differential gravity: correct.\n"
            "- Tidal day of about 24 h 50 min: correct.\n"
            "- Sun's tidal force about 46% of the Moon's: correct.\n"
            "- Caveat: 'most places' is right; some coasts (e.g. parts of the Gulf of Mexico) get one high tide a day."
        )),
        "review": dict(u=(760, 100, 2000), grade=9, rationale=(
            "Checks every claim, correct verdict, and adds a real caveat instead of inventing problems."
        )),
    },
]


def make_job() -> None:
    run = Recorder("j_7f3a91c2")
    run.hello()
    split_u = usage(ORCH_MODEL, 520, 310, 2100)
    run.ledger.append({"purpose": "split", "agent_id": None, "task_id": None, "usage": split_u})
    run.emit(2100, "job_split", {
        "job_text": JOB_TEXT,
        "tasks": [{k: task[k] for k in ("task_id", "type", "title", "brief", "depends_on")} for task in TASKS],
        "price_weight": PRICE_WEIGHT,
        "usage": split_u,
    })
    run.emit(2110, "stats", run.stats())
    run.t = 2150
    for i, task in enumerate(TASKS):
        run.run_task(task, i, len(TASKS))
    run.final("ok", [x for x in TASKS if x["type"] == "writing"][-1])
    run.write("fake_run.json")


# ---------------------------------------------------------------- MAYDAY incident
DIAGNOSE = {
    "task_id": "t1", "type": "diagnose", "title": "Diagnose the Payments API outage",
    "brief": "Find the root cause of the failing payments from the metrics, logs and config changes.",
    "depends_on": [], "est_input_tokens": 900,
    "bids": {
        "haiku": dict(pred=200, q=8, pitch="Quick triage: logs point at the DB layer.", u=(420, 50, 900)),
        "sonnet": dict(pred=250, q=9, pitch="Correlate the config change with the errors.", u=(420, 120, 1500)),
        "opus": dict(pred=300, q=10, pitch="Full root-cause analysis with evidence.", u=(420, 160, 2100)),
    },
    "work": dict(u=(980, 340, 5200), output=(
        "Root cause: config change db.pool.max_size 20 -> 2 (deploy-bot, PR #4812) starved the Payments API "
        "of database connections. Evidence: pool exhaustion warnings and 3000ms connection-acquire timeouts "
        "begin right after the change; the database itself is healthy. Confidence: high."
    )),
    "review": dict(u=(1100, 90, 1800), grade=9, rationale=(
        "Correct root cause tied to the config change and backed by the pool and timeout evidence."
    )),
}
REMEDIATE_1 = {
    "task_id": "t2", "type": "remediate", "title": "Repair attempt 1",
    "brief": "Propose one allowlisted remediation for the diagnosed root cause. Previous failed attempts: none",
    "depends_on": ["t1"], "est_input_tokens": 1000,
    "bids": {
        "haiku": dict(pred=60, q=9, pitch="Restart clears stuck connections. Cheapest fix.", u=(450, 45, 800)),
        "sonnet": dict(pred=80, q=9, pitch="Targeted config fix for the pool.", u=(450, 110, 1400)),
        "opus": dict(pred=80, q=9, pitch="Minimal, reversible pool correction.", u=(450, 150, 2000)),
    },
    "work": dict(u=(1060, 90, 1500), output='{"action": "restart_service"}'),
}
REMEDIATE_2 = {
    "task_id": "t3", "type": "remediate", "title": "Repair attempt 2",
    "brief": None,  # filled in from attempt 1's sandbox result
    "depends_on": ["t1"], "est_input_tokens": 1100,
    "bids": {
        "haiku": dict(pred=60, q=9, pitch="Try again: restart plus warm-up.", u=(470, 45, 800)),
        "sonnet": dict(pred=80, q=9, pitch="Restore the pool size the service needs.", u=(470, 110, 1400)),
        "opus": dict(pred=90, q=9, pitch="Set the pool back to its known-good size.", u=(470, 150, 2000)),
    },
    "work": dict(u=(1160, 110, 1900), output='{"action": "set_db_pool_size", "value": 20}'),
}
VERIFY = {
    "task_id": "t4", "type": "verify", "title": "Verify production recovery",
    "brief": "Confirm the Payments API is healthy after the approved repair.",
    "depends_on": ["t3"], "est_input_tokens": 700,
    "bids": {
        "haiku": dict(pred=120, q=9, pitch="Fast post-deploy health sweep.", u=(400, 45, 800)),
        "sonnet": dict(pred=150, q=9, pitch="Checks every SLO before sign-off.", u=(400, 110, 1400)),
        "opus": dict(pred=150, q=9, pitch="Thorough verification of recovery.", u=(400, 150, 2000)),
    },
    "work": dict(u=(760, 260, 2600), output=(
        "Verified: all production health checks pass after the approved repair. Payments succeed and "
        "p95 latency is back to baseline."
    )),
}
APPROVAL_WAIT_MS = 6000


def make_incident() -> None:
    sim = PaymentsSimulator()
    run = Recorder("j_4d41c0de")

    def status(state: str, severity: str | None, headline: str, job: bool = True) -> None:
        run.emit(run.t if job else 0, "incident_status", {
            "status": state, "service": SERVICE, "severity": severity, "headline": headline,
            "telemetry": sim.telemetry(), "logs": sim.logs(), "config_changes": sim.config_changes(),
        }, job=job)

    run.hello()
    status("healthy", None, "Payments API operating normally", job=False)

    sim.break_production()
    team = select_responders(sim.telemetry(), sim.config_changes())
    severity = team["severity"]
    status("outage", severity, f"{severity}: Payments API failing {sim.telemetry()['error_rate'] * 100:.0f}% of requests")
    run.t = 1500
    run.emit(run.t, "responders_selected", team)
    run.t = 3000
    status("investigating", severity, "AI market diagnosing the outage")
    run.t += 500

    run.run_task(DIAGNOSE, 0, 3)
    status("repairing", severity, "Remediation bids open; repairs run in a sandbox first")
    run.t += 500

    failed: list[str] = []
    winning = None
    for attempt, task in enumerate((REMEDIATE_1, REMEDIATE_2), start=1):
        if task["brief"] is None:
            task["brief"] = ("Propose one allowlisted remediation for the diagnosed root cause. "
                             "Previous failed attempts: " + "; ".join(failed))
        result: dict = {}

        def sandbox(winner: str, t: int, task=task, attempt=attempt, result=result):
            action = parse_action(task["work"]["output"])
            run.emit(t + 200, "remediation_proposed", {
                "task_id": task["task_id"], "agent_id": winner, "attempt": attempt,
                "raw": task["work"]["output"], "valid": True, "action": action, "rejection": None,
            })
            passed, checks, telemetry = sim.sandbox(action)
            run.emit(t + 2400, "sandbox_result", {
                "task_id": task["task_id"], "agent_id": winner, "attempt": attempt,
                "action": action, "passed": passed, "checks": checks, "telemetry": telemetry,
            })
            failing = [c["name"] for c in checks if not c["passed"]]
            result.update(passed=passed, action=action, summary=describe_action(action) + (
                f" (sandbox failed: {', '.join(failing)})" if failing else ""))
            ok = sum(c["passed"] for c in checks)
            return checks_grade(checks), f"Sandbox: {ok}/{len(checks)} checks passed", CHECK_USAGE, t + 2600

        outcome = run.run_task(task, attempt, attempt + 2, sandbox)
        if result["passed"]:
            winning = (task, outcome, result["action"])
            break
        failed.append(result["summary"])
    assert winning is not None, "the scripted second repair must pass the sandbox"

    task, outcome, action = winning
    approvers = [r["name"] for r in team["responders"] if r["selected"] and r["role"] == "Incident Commander"]
    status("awaiting_approval", severity, f"{describe_action(action)} passed the sandbox; awaiting human approval")
    run.emit(run.t + 10, "approval_required", {
        "task_id": task["task_id"], "agent_id": outcome["winner"], "attempt": len(failed) + 1,
        "action": action,
        "summary": (f"{describe_action(action)} passed all sandbox checks after {len(failed)} rejected "
                    f"attempt{'s' if len(failed) != 1 else ''}. Deploy to production?"),
        "approvers": approvers,
    })
    run.t += APPROVAL_WAIT_MS
    approved_by = approvers[0]

    sim.apply(action)
    status("recovering", severity, f"{approved_by} approved {describe_action(action)}; verifying production")
    run.t += 500
    checks = sim.health_checks()

    def production(winner: str, t: int):
        ok = sum(c["passed"] for c in checks)
        return checks_grade(checks), f"Production: {ok}/{len(checks)} health checks passed", CHECK_USAGE, t + 800

    verify_index = len(failed) + 2
    run.run_task(VERIFY, verify_index, verify_index + 1, production)

    grades = [g["grade"] for g in run.grades]
    run.emit(run.t, "service_restored", {
        "mttr_ms": run.t,
        "total_cost_usd": run.stats()["total_cost_usd"],
        "repair_attempts": len(failed) + 1,
        "failed_attempts": len(failed),
        "confidence": round(outcome["promised"] / 10, 2),
        "mean_grade": round(sum(grades) / len(grades), 2),
        "approved_by": approved_by,
        "action": action,
        "grades": run.grades,
        "rep_changes": run.rep_changes,
        "verification": checks,
        "telemetry": sim.telemetry(),
    })
    run.t += 300
    status("restored", None, "Payments API restored")
    run.t += 200
    run.final("ok", VERIFY)
    run.write("mayday_run.json")


if __name__ == "__main__":
    make_job()
    make_incident()
