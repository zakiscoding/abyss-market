"""Generate fixtures/fake_run.json — a hand-authored run that obeys SPEC.md exactly.

The roster, scenario and specialist registries come from the backend so they cannot
drift. All derived numbers (costs, scores, reputation, stats snapshots,
final totals) are computed with the same formulas as SPEC.md so the fixture is
internally consistent. Re-run after any contract change:

    python fixtures/make_fake_run.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from abyss import config as backend_config  # noqa: E402
from abyss import scenarios  # noqa: E402

PRICES = {  # USD per 1M tokens: (input, output)
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-opus-5": (5.00, 25.00),
}
AGENTS = [
    {"agent_id": "haiku", "display_name": "Haiku 4.5", "model": "claude-haiku-4-5", "color": "#4fb3a9"},
    {"agent_id": "sonnet", "display_name": "Sonnet 5", "model": "claude-sonnet-5", "color": "#e8a33d"},
    {"agent_id": "opus", "display_name": "Opus 5", "model": "claude-opus-5", "color": "#8e6cc9"},
]
AGENT_MODEL = {a["agent_id"]: a["model"] for a in AGENTS}
TASK_TYPES = ["research", "writing", "checking", "diagnose", "remediate", "verify"]
TOKENS_PER_SEC = {"claude-haiku-4-5": 150.0, "claude-sonnet-5": 80.0, "claude-opus-5": 50.0}
PRICE_WEIGHT = 1.0
REP_INIT = 1.0
REP_ALPHA = 0.3
ORCH_MODEL = "claude-sonnet-5"
REVIEW_MODEL = "claude-sonnet-5"
JOB_ID = "j_7f3a91c2"
JOB_TEXT = (
    "Write a short explainer (under 150 words) on why most coasts get two "
    "high tides a day, and fact-check it."
)


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


events: list[dict] = []
ledger: list[dict] = []  # {purpose, agent_id, task_id, usage}
rep = {a["agent_id"]: {k: REP_INIT for k in backend_config.REP_KEYS} for a in AGENTS}
wins = {a["agent_id"]: 0 for a in AGENTS}


def emit(t: int, type_: str, data: dict, job_id: str | None = JOB_ID) -> None:
    events.append({"v": 1, "seq": len(events), "t": t, "job_id": job_id, "type": type_, "data": data})


def stats_snapshot() -> dict:
    def zero_p():
        return {"cost_usd": 0.0, "calls": 0}

    by_purpose = {p: zero_p() for p in ["split", "bid", "work", "review"]}
    by_agent = {
        a["agent_id"]: {"cost_usd": 0.0, "input_tokens": 0, "output_tokens": 0, "calls": 0, "tasks_won": wins[a["agent_id"]]}
        for a in AGENTS
    }
    tot_c, tot_i, tot_o = 0.0, 0, 0
    for e in ledger:
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
        "calls": len(ledger),
        "by_purpose": by_purpose,
        "by_agent": by_agent,
    }


# ---------------------------------------------------------------- scenario
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

t = 0
emit(0, "hello", {
    "agents": AGENTS,
    "reputation": json.loads(json.dumps(rep)),
    "config": {
        "price_weight": PRICE_WEIGHT,
        "rep_init": REP_INIT,
        "rep_alpha": REP_ALPHA,
        "task_types": TASK_TYPES,
        "rep_keys": backend_config.REP_KEYS,
        "domains": backend_config.DOMAINS,
        "specialists": backend_config.specialists(),
        "scenarios": scenarios.catalog(),
        "real_models": True,
        "fake_llm": False,
        "orchestrator_model": ORCH_MODEL,
        "reviewer_model": REVIEW_MODEL,
    },
}, job_id=None)

split_u = usage(ORCH_MODEL, 520, 310, 2100)
ledger.append({"purpose": "split", "agent_id": None, "task_id": None, "usage": split_u})
t = 2100
emit(t, "job_split", {
    "job_text": JOB_TEXT,
    "tasks": [{k: task[k] for k in ("task_id", "type", "title", "brief", "depends_on")} for task in TASKS],
    "price_weight": PRICE_WEIGHT,
    "usage": split_u,
})
emit(t + 10, "stats", stats_snapshot())
t += 50

final_tasks = []
grades = []
for i, task in enumerate(TASKS):
    tid, ttype = task["task_id"], task["type"]
    emit(t, "task_posted", {
        "task_id": tid, "type": ttype, "title": task["title"], "brief": task["brief"],
        "depends_on": task["depends_on"], "index": i, "total": len(TASKS),
        "est_input_tokens": task["est_input_tokens"], "domain": None,
    })
    bid_start = t
    scores = {}
    preds = {}
    # bids arrive in order of their call duration (they run concurrently)
    for aid, b in sorted(task["bids"].items(), key=lambda kv: kv[1]["u"][2]):
        inp, out, ms = b["u"]
        u = usage(AGENT_MODEL[aid], inp, out, ms)
        ledger.append({"purpose": "bid", "agent_id": aid, "task_id": tid, "usage": u})
        pred_cost = cost_usd(AGENT_MODEL[aid], task["est_input_tokens"], b["pred"])
        r = rep[aid][ttype]
        s = score(b["q"], r, pred_cost)
        scores[aid] = s
        preds[aid] = (b["pred"], pred_cost, b["q"])
        emit(bid_start + ms, "bid", {
            "task_id": tid, "agent_id": aid, "ok": True, "error": None,
            "predicted_output_tokens": b["pred"], "est_input_tokens": task["est_input_tokens"],
            "predicted_cost_usd": pred_cost, "promised_quality": b["q"],
            "confidence": round(b["q"] / 10 - 0.05, 2),
            "eta_ms": round(b["pred"] / TOKENS_PER_SEC[AGENT_MODEL[aid]] * 1000),
            "pitch": b["pitch"],
            "reputation": r, "score": s, "usage": u,
        })
    t = bid_start + max(b["u"][2] for b in task["bids"].values()) + 50
    order = [a["agent_id"] for a in AGENTS]
    ranked = sorted(scores, key=lambda a: (-scores[a], preds[a][1], order.index(a)))
    winner, runner = ranked[0], ranked[1]
    wins[winner] += 1
    emit(t, "won", {
        "task_id": tid, "agent_id": winner, "mode": "auction", "score": scores[winner],
        "runner_up_agent_id": runner, "runner_up_score": scores[runner],
        "scores": scores, "price_weight": PRICE_WEIGHT,
    })
    emit(t + 10, "stats", stats_snapshot())
    t += 50
    emit(t, "working", {"task_id": tid, "agent_id": winner})
    inp, out, ms = task["work"]["u"]
    wu = usage(AGENT_MODEL[winner], inp, out, ms)
    ledger.append({"purpose": "work", "agent_id": winner, "task_id": tid, "usage": wu})
    t += ms
    emit(t, "done", {
        "task_id": tid, "agent_id": winner, "output": task["work"]["output"],
        "predicted_output_tokens": preds[winner][0], "predicted_cost_usd": preds[winner][1],
        "usage": wu,
    })
    inp, out, ms = task["review"]["u"]
    ru = usage(REVIEW_MODEL, inp, out, ms)
    ledger.append({"purpose": "review", "agent_id": None, "task_id": tid, "usage": ru})
    t += ms
    promised = preds[winner][2]
    grade = task["review"]["grade"]
    grades.append(grade)
    emit(t, "graded", {
        "task_id": tid, "agent_id": winner, "grade": grade, "promised_quality": promised,
        "rationale": task["review"]["rationale"], "usage": ru,
    })
    old = rep[winner][ttype]
    ratio = round(min(2.0, max(0.0, grade / promised)), 4)
    new = round(old + REP_ALPHA * (ratio - old), 4)
    rep[winner][ttype] = new
    emit(t + 10, "rep_update", {
        "task_id": tid, "agent_id": winner, "task_type": ttype, "rep_key": ttype, "old": old, "new": new, "ratio": ratio,
    })
    emit(t + 20, "stats", stats_snapshot())
    t += 100
    final_tasks.append({
        "task_id": tid, "type": ttype, "agent_id": winner, "grade": grade,
        "promised_quality": promised,
        "cost_usd": round(sum(e["usage"]["cost_usd"] for e in ledger if e["task_id"] == tid), 6),
    })

deliverable_task = [x for x in TASKS if x["type"] == "writing"][-1]
emit(t, "final", {
    "status": "ok",
    "deliverable_task_id": deliverable_task["task_id"],
    "deliverable": deliverable_task["work"]["output"],
    "tasks": final_tasks,
    "total_cost_usd": stats_snapshot()["total_cost_usd"],
    "mean_grade": round(sum(grades) / len(grades), 2),
    "duration_ms": t,
})

out = Path(__file__).with_name("fake_run.json")
out.write_text(json.dumps(events, indent=2) + "\n")
print(f"wrote {out} ({len(events)} events, total ${stats_snapshot()['total_cost_usd']})")
