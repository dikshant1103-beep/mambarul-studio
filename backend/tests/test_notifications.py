"""
Tests for alert dispatch (email + webhook) and the notifications endpoints.
Uses dry_run so no real email/webhook is sent.
"""
from core.notifications import dispatch_alerts, notification_channels


def test_channels_returns_booleans():
    ch = notification_channels()
    assert set(ch) == {"email", "webhook"}
    assert all(isinstance(v, bool) for v in ch.values())


def test_dispatch_dry_run_reports_without_sending():
    alerts = [{"label": "c1", "chem": "NMC", "soh": 78, "rul": 40, "phase": "Near-EOL"}]
    r = dispatch_alerts(alerts, reason="unit", dry_run=True)
    assert r["dry_run"] is True
    assert r["n_alerts"] == 1
    assert "email" in r and "webhook" in r
    # webhook not configured in test env → reports configured:False, never sends
    assert r["webhook"].get("sent") in (False, None)


def test_channels_endpoint(client, auth_headers):
    r = client.get("/api/notifications/channels", headers=auth_headers)
    assert r.status_code == 200
    assert set(r.json()) == {"email", "webhook"}


def test_test_notify_endpoint_dry_run(client, auth_headers):
    r = client.post("/api/notifications/test", headers=auth_headers, json={"dry_run": True})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["dry_run"] is True
    assert d["reason"] == "test"


def test_slack_payload_has_block_kit_shape():
    from core.notifications import _format_for_slack
    alerts = [{"cell_id": "C1", "severity": "critical", "description": "RUL=40"}]
    p = _format_for_slack(alerts, "warranty")
    assert "text" in p
    assert isinstance(p["attachments"], list)
    blocks = p["attachments"][0]["blocks"]
    types = [b["type"] for b in blocks]
    assert "header" in types
    assert p["attachments"][0]["color"].startswith("#")  # hex color


def test_teams_payload_has_messagecard_shape():
    from core.notifications import _format_for_teams
    alerts = [{"cell_id": "C1", "severity": "critical", "description": "RUL=40"}]
    p = _format_for_teams(alerts, "warranty")
    assert p["@type"] == "MessageCard"
    assert p["@context"].startswith("https://schema.org")
    assert isinstance(p["sections"], list)
    assert p["sections"][0]["facts"][0]["name"] == "C1"
    assert len(p["themeColor"]) == 6   # 6-digit hex (no leading #)


def test_format_auto_detection_by_url():
    from core.notifications import _detect_webhook_format
    assert _detect_webhook_format("https://hooks.slack.com/services/T0/B0/abc")    == "slack"
    assert _detect_webhook_format("https://acme.webhook.office.com/abc/IncomingWebhook") == "teams"
    assert _detect_webhook_format("https://acme.com/hooks/batteryos")               == "generic"
    # explicit override wins
    assert _detect_webhook_format("https://acme.com/hooks/x", "teams") == "teams"


def test_preview_endpoint_returns_slack_format(client, auth_headers):
    r = client.get("/api/notifications/webhook/preview?format=slack", headers=auth_headers)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["format"] == "slack"
    assert d["payload"]["attachments"][0]["blocks"]


def test_preview_endpoint_returns_teams_format(client, auth_headers):
    r = client.get("/api/notifications/webhook/preview?format=teams", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["format"] == "teams"
    assert r.json()["payload"]["@type"] == "MessageCard"
