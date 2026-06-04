"""
core/notifications.py — Email delivery: alerts + welcome messages.
All SMTP config from environment variables (core.config) or settings DB.
"""
from __future__ import annotations
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger("mambaRUL_studio.notifications")


def _smtp_cfg() -> dict:
    from core.db import get_settings
    s = get_settings()
    if not s.get("smtp_host", "").strip():
        # Customer DB has no SMTP — fall back to main admin DB
        import sqlite3, os
        from pathlib import Path
        main_db = Path(os.path.dirname(__file__)).parent / "data" / "batteryos.db"
        if main_db.exists():
            try:
                import json as _json
                con = sqlite3.connect(str(main_db))
                con.row_factory = sqlite3.Row
                rows = con.execute("SELECT key, value FROM settings_kv").fetchall()
                con.close()
                for r in rows:
                    try:
                        s[r["key"]] = _json.loads(r["value"])
                    except Exception:
                        s[r["key"]] = r["value"]
            except Exception:
                pass
    return s


def _send(to: str, subject: str, plain: str, html: str) -> bool:
    s = _smtp_cfg()
    host = s.get("smtp_host", "").strip()
    if not host or not to:
        return False
    from_addr = s.get("smtp_from", "").strip() or s.get("smtp_user", "batteryos@localhost")
    port = int(s.get("smtp_port", 587))
    user = s.get("smtp_user", "").strip()
    pw   = s.get("smtp_password", "").strip()

    msg             = MIMEMultipart("alternative")
    msg["Subject"]  = subject
    msg["From"]     = from_addr
    msg["To"]       = to
    msg.attach(MIMEText(plain, "plain"))
    msg.attach(MIMEText(html, "html"))
    try:
        with smtplib.SMTP(host, port, timeout=10) as srv:
            srv.ehlo(); srv.starttls(); srv.ehlo()
            if user and pw:
                srv.login(user, pw)
            srv.send_message(msg)
        return True
    except Exception as exc:
        logger.warning("Email delivery failed: %s", exc)
        return False


def send_welcome_email(email: str, name: str = "") -> bool:
    greeting = f"Hi {name}," if name else "Hi there,"
    plain = (
        f"{greeting}\n\nWelcome to BatteryOS!\n\n"
        "Your account is ready. Sign in at your BatteryOS instance to:\n"
        "  • Run live RUL predictions on any cell chemistry\n"
        "  • Upload your fleet data for batch analysis\n"
        "  • Fine-tune MambaRUL on your own cell data\n\n"
        "Get started: https://docs.batteryos.io/quickstart\n\n"
        "— The BatteryOS team\n"
    )
    html = f"""
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;color:#1e293b">
<div style="text-align:center;margin-bottom:32px">
  <div style="display:inline-block;width:56px;height:56px;background:linear-gradient(135deg,#3b82f6,#06b6d4);
              border-radius:16px;line-height:56px;font-size:24px">⚡</div>
  <h1 style="margin:12px 0 4px;font-size:22px">BatteryOS</h1>
  <p style="color:#64748b;font-size:13px;margin:0">RUL Intelligence Platform</p>
</div>
<p style="font-size:15px">{greeting}</p>
<p style="font-size:15px">Welcome to BatteryOS — your account is ready.</p>
<table style="width:100%;margin:24px 0;border-collapse:collapse">
  {''.join(f"""<tr>
  <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">
    <strong>{title}</strong><br>
    <span style="color:#64748b">{desc}</span>
  </td>
</tr>""" for title, desc in [
    ("Live Predict", "Single-cell instant RUL with conformal intervals"),
    ("Pack Predict", "Series/parallel pack-level aggregation"),
    ("Batch Predict", "Upload CSV → RUL for up to 500 cells"),
    ("Fine-Tune", "Upload your cell data to fine-tune MambaRUL"),
  ])}
</table>
<p style="color:#64748b;font-size:12px;margin-top:40px">
  Sent by BatteryOS · <a href="https://docs.batteryos.io">docs.batteryos.io</a>
</p></body></html>"""
    s = _smtp_cfg()
    to = email
    return _send(to, "Welcome to BatteryOS", plain, html)


def try_send_alert_email(alerts: list[dict]) -> bool:
    s = _smtp_cfg()
    to_email = s.get("alert_email", "").strip()
    if not to_email:
        return False
    rows_text = "\n".join(
        f"  • {a.get('label','?')} ({a.get('chem','?')}):"
        f" SOH={a.get('soh','?')}%  RUL={a.get('rul','?')} cyc  Phase={a.get('phase','?')}"
        for a in alerts
    )
    plain = (
        f"BatteryOS Alert\n{'='*40}\n\n"
        f"{len(alerts)} cell(s) require attention:\n\n{rows_text}\n\n"
        "Open the Alert History dashboard to acknowledge these alerts.\n"
    )
    html = f"""
<html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;color:#1e293b">
<h2 style="color:#ef4444">⚠ BatteryOS Alert</h2>
<p><strong>{len(alerts)}</strong> cell(s) flagged during batch prediction:</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
  <tr style="background:#f1f5f9;text-align:left">
    <th style="padding:8px 12px">Cell</th><th style="padding:8px 12px">Chem</th>
    <th style="padding:8px 12px">SOH</th><th style="padding:8px 12px">RUL</th>
    <th style="padding:8px 12px">Phase</th>
  </tr>
  {''.join(f"""<tr style="border-top:1px solid #e2e8f0">
    <td style="padding:8px 12px;font-family:monospace">{a.get('label','?')}</td>
    <td style="padding:8px 12px">{a.get('chem','?')}</td>
    <td style="padding:8px 12px;color:{'#ef4444' if (a.get('soh') or 100)<80 else 'inherit'}">{a.get('soh','?')}%</td>
    <td style="padding:8px 12px">{a.get('rul','?')} cyc</td>
    <td style="padding:8px 12px;color:{'#ef4444' if a.get('phase')=='Near-EOL' else '#f59e0b'}">{a.get('phase','?')}</td>
  </tr>""" for a in alerts)}
</table>
<p style="margin-top:24px;color:#64748b;font-size:12px">Sent by BatteryOS · MambaRUL v10-final</p>
</body></html>"""
    ok = _send(to_email, f"[BatteryOS] {len(alerts)} critical cell(s) detected", plain, html)
    if ok:
        logger.info("Alert email sent to %s (%d cells)", to_email, len(alerts))
    return ok


def send_otp_email(email: str, otp: str, purpose: str = "verify") -> bool:
    """Send a 6-digit OTP for email verification or password reset."""
    if purpose == "reset":
        subject = "BatteryOS — Password Reset Code"
        heading = "Reset your password"
        body_line = "Use the code below to reset your BatteryOS password. It expires in 10 minutes."
        note = "If you didn't request a password reset, you can safely ignore this email."
    else:
        subject = "BatteryOS — Verify Your Email"
        heading = "Verify your email address"
        body_line = "Enter this code in the BatteryOS app to verify your email. It expires in 10 minutes."
        note = "If you didn't create a BatteryOS account, you can safely ignore this email."

    plain = (
        f"BatteryOS — {heading}\n\n{body_line}\n\n"
        f"Your code: {otp}\n\n{note}\n\n— The BatteryOS team\n"
    )
    html = f"""
<html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;color:#1e293b">
<div style="text-align:center;margin-bottom:28px">
  <div style="display:inline-block;width:52px;height:52px;background:linear-gradient(135deg,#3b82f6,#06b6d4);
              border-radius:14px;line-height:52px;font-size:22px">⚡</div>
  <h1 style="margin:10px 0 2px;font-size:20px">BatteryOS</h1>
  <p style="color:#64748b;font-size:12px;margin:0">RUL Intelligence Platform</p>
</div>
<h2 style="font-size:17px;margin-bottom:8px">{heading}</h2>
<p style="font-size:14px;color:#475569">{body_line}</p>
<div style="text-align:center;margin:28px 0">
  <div style="display:inline-block;background:#0f172a;color:#60a5fa;font-size:32px;
              font-family:monospace;font-weight:700;letter-spacing:10px;
              padding:16px 28px;border-radius:12px;border:1px solid #1e3a5f">
    {otp}
  </div>
  <p style="color:#94a3b8;font-size:11px;margin-top:8px">Expires in 10 minutes</p>
</div>
<p style="color:#94a3b8;font-size:12px">{note}</p>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
<p style="color:#cbd5e1;font-size:11px;text-align:center">Sent by BatteryOS · MambaRUL Platform</p>
</body></html>"""
    return _send(email, subject, plain, html)


def send_test_email() -> dict:
    s = _smtp_cfg()
    if not s.get("smtp_host") or not s.get("alert_email"):
        return {"ok": False, "message": "SMTP host and alert email must be configured first."}
    ok = try_send_alert_email([{
        "label": "TEST-CELL-01", "chem": "NMC",
        "soh": 79.5, "rul": 42.0, "phase": "Near-EOL",
    }])
    return {"ok": ok, "message": "Test email delivered." if ok else "Delivery failed — check SMTP settings."}


# ── Multi-channel alert dispatch (email + webhook) ────────────────────────────
from datetime import datetime, timezone   # noqa: E402


def _redact_url(url: str) -> str:
    try:
        from urllib.parse import urlsplit
        p = urlsplit(url)
        return f"{p.scheme}://{p.netloc}/…"
    except Exception:
        return "configured"


def notification_channels() -> dict:
    """Which alert channels are configured (booleans only — never returns secrets)."""
    s = _smtp_cfg()
    return {
        "email":   bool(s.get("smtp_host", "").strip() and s.get("alert_email", "").strip()),
        "webhook": bool(str(s.get("webhook_url", "")).strip() and s.get("webhook_enabled", True)),
    }


def notify_webhook(payload: dict, dry_run: bool = False) -> dict:
    """POST a JSON alert payload to the configured webhook (uses the same
    `webhook_url`/`webhook_enabled` settings as the admin Settings page)."""
    s = _smtp_cfg()
    url = str(s.get("webhook_url", "")).strip()
    if not url or not s.get("webhook_enabled", True):
        return {"configured": False, "sent": False}
    if dry_run:
        return {"configured": True, "sent": False, "dry_run": True, "url": _redact_url(url)}
    import json as _json
    import urllib.request
    try:
        req = urllib.request.Request(
            url, data=_json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            ok = 200 <= getattr(resp, "status", 200) < 300
            return {"configured": True, "sent": ok, "status": getattr(resp, "status", None)}
    except Exception as exc:
        logger.warning("Webhook delivery failed: %s", exc)
        return {"configured": True, "sent": False, "error": str(exc)}


def _format_for_slack(alerts: list[dict], reason: str) -> dict:
    """Slack block-kit payload.

    Slack expects {text, blocks: [...]} where blocks are an array of layout
    objects. We emit a header + per-alert section with a color attachment
    (red ≥ critical, amber ≥ warning, green otherwise) — matches enterprise
    on-call dashboards.
    """
    color = "#dc2626" if any(a.get("severity") in ("critical", "high") for a in alerts) \
            else "#f59e0b" if any(a.get("severity") == "warning" for a in alerts) \
            else "#16a34a"
    fields = []
    for a in alerts[:10]:
        fields.append({
            "type": "mrkdwn",
            "text": (f"*{a.get('cell_id', a.get('id', 'cell'))}* — "
                     f"{a.get('description', a.get('type', 'alert'))} "
                     f"_({a.get('severity', 'info')})_"),
        })
    return {
        "text": f"BatteryOS: {reason} — {len(alerts)} alert(s)",
        "attachments": [{
            "color":  color,
            "blocks": [
                {"type": "header",
                 "text": {"type": "plain_text",
                          "text": f"BatteryOS: {reason}"}},
                {"type": "section",
                 "text": {"type": "mrkdwn",
                          "text": f"*{len(alerts)}* alert(s) require attention."}},
                *(({"type": "section", "fields": fields[:10]},) if fields else ()),
                {"type": "context",
                 "elements": [{"type": "mrkdwn",
                               "text": f":clock1: {datetime.now(timezone.utc).isoformat()}"}]},
            ],
        }],
    }


def _format_for_teams(alerts: list[dict], reason: str) -> dict:
    """Microsoft Teams MessageCard (legacy connector format — still supported
    via Incoming Webhook). Adaptive Cards are the newer format but require
    Power Automate; MessageCard works with the simple Incoming Webhook URL
    that enterprise IT typically provisions."""
    theme_color = "DC2626" if any(a.get("severity") in ("critical", "high") for a in alerts) \
                  else "F59E0B" if any(a.get("severity") == "warning" for a in alerts) \
                  else "16A34A"
    facts = []
    for a in alerts[:10]:
        facts.append({
            "name":  a.get("cell_id", a.get("id", "cell")),
            "value": (f"{a.get('description', a.get('type', 'alert'))} "
                      f"({a.get('severity', 'info')})"),
        })
    return {
        "@type":      "MessageCard",
        "@context":   "https://schema.org/extensions",
        "themeColor": theme_color,
        "summary":    f"BatteryOS: {reason} — {len(alerts)} alert(s)",
        "sections":   [{
            "activityTitle":    f"**BatteryOS — {reason}**",
            "activitySubtitle": f"{len(alerts)} alert(s) require attention",
            "facts":            facts,
            "markdown":         True,
        }],
    }


def _detect_webhook_format(url: str, override: str | None = None) -> str:
    """Pick a payload format. Explicit override wins; otherwise auto-detect by
    URL substring (Slack/Teams have stable webhook URL prefixes)."""
    if override and override.lower() in ("slack", "teams", "generic"):
        return override.lower()
    u = url.lower()
    if "hooks.slack.com" in u:
        return "slack"
    if "webhook.office.com" in u or "outlook.office.com" in u:
        return "teams"
    return "generic"


def dispatch_alerts(alerts: list[dict], reason: str = "alert", dry_run: bool = False,
                    webhook_format: str | None = None) -> dict:
    """Send alerts to every configured channel. dry_run reports what *would* fire
    without sending. Returns a per-channel result dict.

    `webhook_format` ∈ {None (auto-detect), "slack", "teams", "generic"} controls
    the JSON shape sent to the webhook. Slack/Teams variants produce visually
    rich messages in those products; "generic" keeps the original BatteryOS
    payload shape for custom consumers.
    """
    chans = notification_channels()
    result = {"reason": reason, "n_alerts": len(alerts), "channels": chans, "dry_run": dry_run}

    if chans["email"]:
        result["email"] = {"planned": True} if dry_run else {"sent": try_send_alert_email(alerts)}
    else:
        result["email"] = {"configured": False}

    # Determine which payload shape to send.
    s = _smtp_cfg()
    url = str(s.get("webhook_url", "")).strip()
    fmt = _detect_webhook_format(url, webhook_format)
    if fmt == "slack":
        payload = _format_for_slack(alerts, reason)
    elif fmt == "teams":
        payload = _format_for_teams(alerts, reason)
    else:
        payload = {"reason": reason, "n_alerts": len(alerts), "alerts": alerts,
                   "ts": datetime.now(timezone.utc).isoformat()}

    result["webhook"] = notify_webhook(payload, dry_run=dry_run)
    result["webhook_format"] = fmt
    return result
