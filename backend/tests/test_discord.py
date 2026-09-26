from __future__ import annotations

import asyncio
import json

from abyss import discord


def test_notification_uses_only_configured_deterministic_mentions(monkeypatch):
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.invalid/webhook")
    monkeypatch.setenv("DISCORD_USER_MAYA", "maya-id")
    monkeypatch.setenv("DISCORD_USER_JORDAN", "jordan-id")
    monkeypatch.setenv("DISCORD_USER_TAYLOR", "taylor-id")
    monkeypatch.setenv("ABYSS_PUBLIC_URL", "https://abyss.example.com")

    notification = discord.build_review_notification(
        job_id="j_deadbeef",
        service="orders-api",
        region="ams",
        domain="database",
        severity="SEV-1",
        selected_worker="Database Specialist · Haiku",
        customer_impact=True,
        summary="Primary database is unavailable.",
        crew=(("Zak", "Incident Commander"), ("Maya", "Database Engineer"), ("Riley", "Network Engineer"), ("Jordan", "Customer Support Lead")),
    )

    assert notification is not None
    assert notification.mentions == ("maya-id", "jordan-id", "taylor-id")
    assert "<@maya-id>" in notification.message
    assert "<@everyone>" not in notification.message
    assert "https://abyss.example.com/incidents/j_deadbeef" in notification.message
    assert "Zak: Incident Commander" in notification.message
    assert "Maya: Database Engineer" in notification.message
    assert "Riley: Network Engineer" in notification.message
    assert "Jordan: Customer Support Lead" in notification.message
    assert "raw" not in notification.message.lower()


def test_notification_is_disabled_without_webhook(monkeypatch):
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    assert discord.build_review_notification(
        job_id="j_deadbeef",
        service="orders-api",
        region="ams",
        domain="database",
        severity="SEV-1",
        selected_worker="Haiku",
        customer_impact=False,
        summary="Database unavailable.",
    ) is None


def test_delivery_failure_is_best_effort(monkeypatch):
    notification = discord.DiscordNotification("https://discord.invalid", None, None, (), "message")

    def fail(_notification):
        raise OSError("offline")

    monkeypatch.setattr(discord, "_post", fail)
    assert asyncio.run(discord.send_review_notification(notification)) is False


def test_bot_api_posts_to_configured_channel(monkeypatch):
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    monkeypatch.setenv("DISCORD_BOT_TOKEN", "bot-secret")
    monkeypatch.setenv("DISCORD_CHANNEL_ID", "123456789")
    notification = discord.build_review_notification(
        job_id="j_deadbeef",
        service="orders-api",
        region="ams",
        domain="database",
        severity="SEV-1",
        selected_worker="Gemini Flash",
        customer_impact=False,
        summary="Primary database is unavailable.",
    )
    requests: list[object] = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def capture(req, *, timeout):
        assert timeout == 5
        requests.append(req)
        return Response()

    monkeypatch.setattr(discord.request, "urlopen", capture)
    discord._post(notification)
    req = requests[0]
    assert req.full_url == "https://discord.com/api/v10/channels/123456789/messages"
    assert req.get_header("Authorization") == "Bot bot-secret"
    body = json.loads(req.data)
    assert body["allowed_mentions"]["parse"] == []
