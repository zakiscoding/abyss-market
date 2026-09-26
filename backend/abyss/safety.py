"""Sanitize untrusted incident text before it reaches a model, the ledger, or a client.

Logs, alerts, and config values are external data. This module redacts secrets,
strips control characters, and caps size. It does not change the simulator
objects callers still use for deterministic checks.
"""
from __future__ import annotations

import logging
import re
import uuid

logger = logging.getLogger(__name__)

MAX_LOG_LINE = 400
MAX_FIELD = 800
MAX_MODEL_CONTEXT = 12_000
MAX_ERROR = 200

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]")
_PATH = re.compile(r"(?:[A-Za-z]:\\[^\s\"']+|/(?:[\w.@+-]+/)+[\w.@+-]+)")
_INJECTION = re.compile(
    r"(?i)"
    r"(?:ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules))"
    r"|(?:disregard\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules)?)"
    r"|(?:you\s+are\s+now\b)"
    r"|(?:new\s+instructions?\s*:)"
    r"|(?:<\s*/?\s*system\s*>)"
)
_SECRETS = (
    re.compile(r"sk-(?:ant-)?[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-+/=]{8,}"),
    re.compile(r"(?i)\bauthorization\s*[:=]\s*\S+"),
    re.compile(
        r"(?i)\b(api[_-]?key|secret|password|passwd|pwd|token)\b\s*[:=]\s*['\"]?[^\s'\"]{4,}"
    ),
)


def redact_text(value: str, *, limit: int = MAX_FIELD) -> str:
    """Return text safe to place in a prompt, ledger error, or client message."""
    cleaned = _CONTROL.sub("", value)
    for pattern in _SECRETS:
        cleaned = pattern.sub("[redacted]", cleaned)
    cleaned = _INJECTION.sub("[untrusted-instruction-removed]", cleaned)
    cleaned = _PATH.sub("[path]", cleaned)
    if len(cleaned) > limit:
        cleaned = cleaned[:limit] + "…[truncated]"
    return cleaned


def redact_logs(lines: list[str]) -> list[str]:
    return [redact_text(line, limit=MAX_LOG_LINE) for line in lines]


def for_model(value: object, *, depth: int = 0) -> object:
    """Deep-copy JSON-like data with every string redacted. The input is unchanged."""
    if depth > 8:
        return "[truncated]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [for_model(item, depth=depth + 1) for item in value[:40]]
    if isinstance(value, dict):
        redacted: dict[str, object] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 40:
                break
            redacted[str(key)[:80]] = for_model(item, depth=depth + 1)
        return redacted
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return redact_text(str(value))


def cap_context(text: str, *, limit: int = MAX_MODEL_CONTEXT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…[context truncated]"


def correlation_id() -> str:
    return uuid.uuid4().hex[:8]


def log_internal(exc: BaseException, *, label: str) -> str:
    """Log a redacted failure and return a short correlation id for the client."""
    correlation = correlation_id()
    logger.error(
        "%s correlation=%s %s: %s",
        label,
        correlation,
        type(exc).__name__,
        redact_text(str(exc), limit=MAX_ERROR),
    )
    return correlation


def client_internal_error(correlation: str) -> str:
    return f"internal error ({correlation})"


def client_model_error() -> str:
    return "model request failed"
