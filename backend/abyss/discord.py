"""Safe Discord review notifications for MAYDAY incidents.

Mention targets are selected from deterministic ownership rules and IDs are
read only from environment variables. Delivery is best effort by design.
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from urllib import request

from . import safety


@dataclass(frozen=True)
class DiscordNotification:
    webhook_url: str | None
    bot_token: str | None
    channel_id: str | None
    mentions: tuple[str, ...]
    message: str


def _env_id(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def _mention_ids(domain: str, customer_impact: bool, severity: str | None) -> tuple[str, ...]:
    ownership: dict[str, tuple[str, ...]] = {
        "database": ("DISCORD_USER_MAYA", "DISCORD_USER_JORDAN"),
        "security": ("DISCORD_USER_MAYA", "DISCORD_USER_SAM"),
        "payments": ("DISCORD_USER_MAYA", "DISCORD_USER_ALEX"),
        "networking": ("DISCORD_USER_MAYA", "DISCORD_USER_ALEX"),
    }
    names = list(ownership.get(domain, ()))
    if customer_impact:
        names.append("DISCORD_USER_TAYLOR")
    # The Incident Commander is intentionally not guessed: no ID is accepted
    # unless a dedicated configured mapping is added by the operator.
    if severity == "SEV-1":
        names.append("DISCORD_USER_INCIDENT_COMMANDER")
    ids: list[str] = []
    for name in names:
        value = _env_id(name)
        if value and value not in ids:
            ids.append(value)
    return tuple(ids)


def _public_incident_url(job_id: str) -> str:
    base = os.getenv("ABYSS_PUBLIC_URL", "").strip().rstrip("/")
    if not base:
        base = "http://localhost:5173"
    return f"{base}/incidents/{job_id}"


def build_review_notification(
    *,
    job_id: str,
    service: str,
    region: str,
    domain: str,
    severity: str | None,
    selected_worker: str,
    customer_impact: bool,
    summary: str,
    crew: tuple[tuple[str, str], ...] = (),
    webhook_url: str | None = None,
) -> DiscordNotification | None:
    webhook = (webhook_url if webhook_url is not None else os.getenv("DISCORD_WEBHOOK_URL", "")).strip() or None
    bot_token = os.getenv("DISCORD_BOT_TOKEN", "").strip() or None
    channel_id = os.getenv("DISCORD_CHANNEL_ID", "").strip() or None
    if not ((bot_token and channel_id) or webhook):
        return None
    ids = _mention_ids(domain, customer_impact, severity)
    mentions = " ".join(f"<@{user_id}>" for user_id in ids)
    audience = f"{mentions}, " if mentions else ""
    specialty = {
        "database": "Database Repair",
        "networking": "Network Routing",
        "security": "Security Watch",
        "payments": "Payments",
        "generalist": "Generalist",
    }.get(domain, domain.title())
    crew_lines = "\n".join(f"- {name}: {role}" for name, role in crew)
    crew_section = f"Crew roles:\n{crew_lines}\n" if crew_lines else ""
    message = (
        f"🚨 {severity or 'INCIDENT'} INCIDENT\n\n"
        f"{audience}you have been assigned to the {region.upper()} {service} incident.\n\n"
        "Captain AI has completed its investigation and the proposed repair passed sandbox validation.\n\n"
        "Action required:\nReview the evidence and approve, reject or request a revision.\n\n"
        f"Open Abyss:\n{_public_incident_url(job_id)}\n\n"
        f"Service: {service}\n"
        f"Region: {region.upper()}\n"
        f"Specialty: {specialty}\n"
        f"Selected worker: {selected_worker}\n"
        "Status: Awaiting human review\n"
        f"{crew_section}"
        f"Captain AI: {safety.redact_text(summary, limit=300)}"
    )
    return DiscordNotification(webhook, bot_token, channel_id, ids, message)


def _post(notification: DiscordNotification) -> None:
    payload = json.dumps({
        "content": notification.message,
        "allowed_mentions": {"parse": [], "users": list(notification.mentions)},
    }).encode("utf-8")
    if notification.bot_token and notification.channel_id:
        if not notification.channel_id.isdigit():
            raise ValueError("DISCORD_CHANNEL_ID must be numeric")
        req = request.Request(
            f"https://discord.com/api/v10/channels/{notification.channel_id}/messages",
            data=payload,
            headers={
                "Authorization": f"Bot {notification.bot_token}",
                "Content-Type": "application/json",
                "User-Agent": "abyss-mayday",
            },
            method="POST",
        )
    elif notification.webhook_url:
        req = request.Request(
            notification.webhook_url,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "abyss-mayday"},
            method="POST",
        )
    else:
        raise ValueError("Discord delivery is not configured")
    with request.urlopen(req, timeout=5):
        return


async def send_review_notification(notification: DiscordNotification | None) -> bool:
    if notification is None:
        return False
    try:
        await asyncio.to_thread(_post, notification)
        return True
    except Exception as exc:
        # Webhook URLs contain a secret token; never include provider exception
        # text in logs because it may echo the URL.
        safety.log_internal(
            RuntimeError(f"{type(exc).__name__}: Discord delivery unavailable"),
            label="discord review notification failed",
        )
        return False
