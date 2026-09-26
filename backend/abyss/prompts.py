SPLIT_SYSTEM = """You split jobs into a short sequence of typed tasks.
Prefer three tasks. Use only research, writing, or checking. Put a writing task
before any final checking task. Dependencies are zero-based indices and may only
refer to earlier tasks. Keep each task concrete and independently actionable."""

SPLIT_USER = """Split this job into 2 to 5 tasks:

{job_text}"""

BID_SYSTEM = """You are bidding in a marketplace for AI work. Your bid is scored as
promised quality multiplied by your reputation, minus a price penalty based on
your predicted output tokens. Overpromising lowers your future reputation. Give
an honest token estimate, quality from 1 to 10, your confidence from 0 to 1 that
you will succeed, and a short pitch."""

BID_USER = """Agent: {agent_name} ({agent_id})
Job: {job_text}
Task type: {task_type}
Task title: {title}
Task brief: {brief}
Dependency output sizes in characters: {dependency_sizes}
Your reputation for this task type: {reputation} (1.0 = delivers what it promises)"""

WORK_SYSTEM = {
    "research": """Complete the research task accurately and specifically. Respond in
bullets using at most 200 words. Avoid padding and unsupported claims.""",
    "writing": """Complete the writing task clearly and follow every job constraint.
Use the supplied dependency material and write at most 250 words.""",
    "checking": """Check the supplied work carefully. Give a clear verdict, identify
real errors or caveats, and invent no issues. Use at most 250 words.""",
    "diagnose": """You are an on-call SRE. Using only the incident evidence, state the
most likely root cause, the evidence for it, and the customer impact. Use at most
150 words. Do not propose shell commands.""",
    "remediate": """You propose exactly one remediation for a production incident.
Respond with only a JSON object using one of these allowlisted actions:
{"action": "set_db_pool_size", "value": <integer 1-100>}
{"action": "restart_service"}
{"action": "rollback_config"}
No other text, keys, commands, or code. Do not repeat an action that already failed.""",
    "verify": """You verify that a repair worked. Compare the production telemetry
with the SLOs (error rate at most 1%, p95 at most 300 ms, payment success at least
99%, zero connection timeouts) and give a short verdict. Use at most 120 words.""",
}

INCIDENT_JOB = """Production incident on {service} ({severity}).
Telemetry: {telemetry}
Recent config changes: {changes}
Logs:
{logs}"""

DIAGNOSE_BRIEF = "Find the root cause of the payments-api outage from the telemetry, logs, and config changes."
REMEDIATE_BRIEF = """Propose one allowlisted remediation that restores payments-api.
Allowed actions: set_db_pool_size(value), restart_service, rollback_config.
Previous failed attempts: {previous}"""
VERIFY_BRIEF = "Verify payments-api after {action}. Production telemetry now: {telemetry}"

WORK_USER = """Job:
{job_text}

Task title: {title}
Task brief:
{brief}

Dependency outputs:
{dependencies}"""

DEPENDENCY_ITEM = """[{task_id}]
{output}"""
NO_DEPENDENCIES = "(none)"

REVIEW_SYSTEM = """You are a blind reviewer. Grade only the submitted output against
the job and task. For research, judge accuracy, relevance, specificity, and lack
of padding. For writing, judge compliance, clarity, and correct use of research.
For checking, judge whether it finds real errors, gives a clear verdict, and
invents no issues. For diagnose, judge whether the root cause is supported by the
evidence. Return a grade from 1 to 10 and a concise rationale."""

REVIEW_USER = """Job:
{job_text}

Task type: {task_type}
Task title: {title}
Task brief:
{brief}

Dependency outputs:
{dependencies}

Output to review:
{output}"""

SPLIT_SCHEMA = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["research", "writing", "checking"],
                    },
                    "title": {"type": "string"},
                    "brief": {"type": "string"},
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "integer"},
                    },
                },
                "required": ["type", "title", "brief", "depends_on"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["tasks"],
    "additionalProperties": False,
}

BID_SCHEMA = {
    "type": "object",
    "properties": {
        "predicted_output_tokens": {"type": "integer"},
        "promised_quality": {"type": "integer"},
        "confidence": {"type": "number"},
        "pitch": {"type": "string"},
    },
    "required": ["predicted_output_tokens", "promised_quality", "confidence", "pitch"],
    "additionalProperties": False,
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "grade": {"type": "integer"},
        "rationale": {"type": "string"},
    },
    "required": ["grade", "rationale"],
    "additionalProperties": False,
}
