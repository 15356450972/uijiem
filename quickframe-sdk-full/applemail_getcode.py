"""通过小苹果邮件 API 从 Microsoft OAuth 邮箱读取验证码。"""

from __future__ import annotations

from datetime import datetime
import json
import re
import time
import urllib.error
import urllib.request


DEFAULT_API_URL = "https://apple.882263.xyz/api/mail-new"


def _required(value: object, label: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"{label} is required")
    return normalized


def normalize_mailbox(credentials: dict) -> dict:
    return {
        "email": _required(credentials.get("email"), "email"),
        "client_id": _required(credentials.get("client_id") or credentials.get("clientId"), "client_id"),
        "refresh_token": _required(
            credentials.get("refresh_token") or credentials.get("refreshToken"),
            "refresh_token",
        ),
        "api_url": str(credentials.get("api_url") or DEFAULT_API_URL).strip(),
        "api_password": str(credentials.get("api_password") or "").strip(),
    }


def _latest(mailbox: dict, folder: str) -> list[dict]:
    payload = {
        "refresh_token": mailbox["refresh_token"],
        "client_id": mailbox["client_id"],
        "email": mailbox["email"],
        "mailbox": folder,
        "response_type": "json",
    }
    if mailbox["api_password"]:
        payload["password"] = mailbox["api_password"]
    data = json.dumps(payload).encode()
    request = urllib.request.Request(
        mailbox["api_url"],
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8", "ignore") or "null")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "ignore")
        try:
            detail = json.loads(raw).get("error") or f"HTTP {error.code}"
        except (TypeError, ValueError):
            detail = f"HTTP {error.code}"
        raise RuntimeError(f"{folder} 取件失败：{detail}") from error
    if isinstance(result, dict) and result.get("error"):
        raise RuntimeError(f"{folder} 取件失败：{result['error']}")
    values = result if isinstance(result, list) else [result] if isinstance(result, dict) else []
    return [{**item, "mailbox": folder} for item in values if isinstance(item, dict)]


def _message_text(message: dict) -> str:
    values = []
    for key in ("subject", "text", "html", "body", "bodyPreview", "content"):
        value = message.get(key)
        if isinstance(value, str):
            values.append(value)
        elif isinstance(value, dict):
            values.extend(str(item) for item in value.values() if isinstance(item, str))
    content = "\n".join(values)
    content = re.sub(r"(?is)<style.*?</style>|<script.*?</script>", " ", content)
    content = re.sub(r"(?s)<[^>]+>", " ", content)
    return re.sub(r"\s+", " ", content.replace("&nbsp;", " ")).strip()


def _message_timestamp(message: dict) -> float | None:
    raw = message.get("date") or message.get("receivedDateTime")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def wait_for_code(credentials: dict, max_wait: int = 120, min_ts: float = 0) -> str | None:
    mailbox = normalize_mailbox(credentials)
    started_at = float(min_ts or time.time() - 120)
    deadline = time.time() + max_wait
    last_error = ""
    while time.time() < deadline:
        messages = []
        errors = []
        for folder in ("INBOX", "Junk"):
            try:
                messages.extend(_latest(mailbox, folder))
            except Exception as error:  # noqa: BLE001
                errors.append(str(error))
        if not messages and errors:
            last_error = "；".join(errors)
        for message in messages:
            received_at = _message_timestamp(message)
            if received_at is not None and received_at < started_at:
                continue
            candidates = re.findall(r"\b(\d{4,8})\b", _message_text(message))
            if candidates:
                return candidates[0]
        time.sleep(3)
    if last_error:
        print(f"  小苹果取件最后错误: {last_error}")
    return None
