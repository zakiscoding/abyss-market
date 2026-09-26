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
    "remediate": """You propose a remediation plan for a production incident.
Respond with only a JSON object of the form {"steps": [<action>, ...]} with 1 to 4
steps, using only the allowlisted actions listed in the task brief, exactly as
written there. No other text, keys, commands, or code. Nothing you write is
executed: the plan is validated and tested in a sandbox first. Do not repeat a
plan that already failed.""",
    "verify": """You verify that a repair worked. Compare the production telemetry
with its health targets (every metric marked ok) and give a short verdict. Use at
most 120 words.""",
}

COMMANDER_SYSTEM = """You are the MAYDAY incident commander. Classify an incident from a
compressed alert package. Choose the primary specialist domain (database,
networking, security, payments, or generalist if unclear), any secondary domains,
and the severity: SEV-1 for a major customer-facing outage, SEV-2 for a partial
degradation, SEV-3 for minor impact. Give a one-sentence rationale citing the evidence."""

COMMANDER_USER = """Incident package:
{package}"""

COMMANDER_SCHEMA = {
    "type": "object",
    "properties": {
        "domain": {"type": "string", "enum": ["database", "networking", "security", "payments", "generalist"]},
        "secondary_domains": {
            "type": "array",
            "items": {"type": "string", "enum": ["database", "networking", "security", "payments", "generalist"]},
        },
        "severity": {"type": "string", "enum": ["SEV-1", "SEV-2", "SEV-3"]},
        "rationale": {"type": "string"},
    },
    "required": ["domain", "secondary_domains", "severity", "rationale"],
    "additionalProperties": False,
}

INCIDENT_JOB = """You are a {specialist} in the MAYDAY incident market.
Scenario id: {scenario_id}
Production incident on {service} in {region} ({severity}), reported by {source}.
Commander classification: {domain} (secondary: {secondary}). {rationale}
Telemetry: {telemetry}
Recent changes: {changes}
Logs:
{logs}"""

DIAGNOSE_BRIEF = "Find the root cause of the {service} incident from the telemetry, logs, and recent changes."
REMEDIATE_BRIEF = """Propose a remediation plan that restores {service}.
Allowed actions (regions: {regions}):
{actions}
Previous failed attempts: {previous}"""
VERIFY_BRIEF = "Verify {service} after {plan}. Production telemetry now: {telemetry}"

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
evidence and fits the specialist domain. Return a grade from 1 to 10 and a concise rationale."""

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
