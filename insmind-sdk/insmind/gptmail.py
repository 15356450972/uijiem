"""GPTMail 临时邮箱。"""

from __future__ import annotations

import random
import re
import string
import time
import urllib.parse
from typing import Callable, Optional

from . import constants as C
from .http import request


class GPTMailClient:
    _domain_cache: list[str] | None = None
    _domain_cache_at = 0.0

    def __init__(self) -> None:
        self.email = ""
        self.cookies: list[str] = []
        self.token = ""

    @classmethod
    def valid_domains(cls) -> list[str]:
        now = time.time()
        if cls._domain_cache and now - cls._domain_cache_at < 1800:
            return cls._domain_cache
        result = request(
            f"https://{C.GPTMAIL_HOST}/api/domains/status",
            headers={"Accept": "application/json"},
            timeout=20,
        )
        domains = [
            item.get("domain_name", "")
            for item in (((result.get("json") or {}).get("data") or {}).get("domains") or [])
            if item.get("mx_valid") and item.get("is_active") and item.get("domain_name")
        ]
        if domains:
            cls._domain_cache = domains
            cls._domain_cache_at = now
            return domains
        return cls._domain_cache or [C.GPTMAIL_FALLBACK_DOMAIN]

    @staticmethod
    def random_prefix() -> str:
        chars = string.ascii_lowercase + string.digits
        return "".join(random.choice(chars) for _ in range(random.randint(8, 11)))

    def generate_email(self, prefer_fallback: bool = True) -> str:
        domain = C.GPTMAIL_FALLBACK_DOMAIN if prefer_fallback else random.choice(self.valid_domains())
        self.email = f"{self.random_prefix()}@{domain}"
        return self.email

    def build_session(self, email: Optional[str] = None) -> dict:
        self.email = (email or self.email).strip()
        if not self.email:
            raise ValueError("email is required")
        request(
            f"https://{C.GPTMAIL_HOST}/zh/{urllib.parse.quote(self.email)}",
            headers={"Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9"},
            timeout=20,
        )
        token_result = request(
            f"https://{C.GPTMAIL_HOST}/api/inbox-token",
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Referer": f"https://{C.GPTMAIL_HOST}/zh/{self.email}",
            },
            body={"email": self.email},
            timeout=20,
        )
        data = token_result.get("json") or {}
        self.token = (((data.get("auth") or {}).get("token")) if data.get("success") else "") or ""
        self.cookies = token_result.get("cookies") or []
        if not self.token:
            raise RuntimeError(f"GPTMail inbox-token failed: {token_result.get('text', '')[:200]}")
        if not any(c.startswith("gm_sid=") for c in self.cookies):
            raise RuntimeError(f"GPTMail missing gm_sid cookie: {self.cookies}")
        return {"email": self.email, "cookies": self.cookies, "token": self.token}

    def _cookie_header(self) -> str:
        gm = [c for c in self.cookies if c.startswith("gm_sid=")]
        return "; ".join(gm or self.cookies)

    def list_emails(self) -> list[dict]:
        if not self.token or not self.cookies:
            self.build_session(self.email)
        result = request(
            f"https://{C.GPTMAIL_HOST}/api/emails?email={urllib.parse.quote(self.email)}",
            headers={
                "Accept": "application/json",
                "Cookie": self._cookie_header(),
                "X-Inbox-Token": self.token,
                "Referer": f"https://{C.GPTMAIL_HOST}/zh/{self.email}",
            },
            timeout=20,
        )
        if result.get("status") in (401, 403):
            self.build_session(self.email)
            result = request(
                f"https://{C.GPTMAIL_HOST}/api/emails?email={urllib.parse.quote(self.email)}",
                headers={
                    "Accept": "application/json",
                    "Cookie": self._cookie_header(),
                    "X-Inbox-Token": self.token,
                    "Referer": f"https://{C.GPTMAIL_HOST}/zh/{self.email}",
                },
                timeout=20,
            )
        data = result.get("json") or {}
        if not data.get("success"):
            return []
        return ((data.get("data") or {}).get("emails") or [])

    def email_detail(self, message: dict) -> dict:
        message_id = message.get("id") or message.get("email_id") or message.get("_id")
        if not message_id:
            return message
        result = request(
            f"https://{C.GPTMAIL_HOST}/api/email/{urllib.parse.quote(str(message_id))}",
            headers={
                "Accept": "application/json",
                "Cookie": self._cookie_header(),
                "X-Inbox-Token": self.token,
            },
            timeout=20,
        )
        data = result.get("json") or {}
        detail = data.get("data") if data.get("success") else None
        return {**message, **detail} if isinstance(detail, dict) else message

    @staticmethod
    def extract_code(text: str, length: int = 6) -> str:
        if not text:
            return ""
        compact = re.sub(r"(?is)<style.*?</style>", " ", text)
        compact = re.sub(r"(?is)<script.*?</script>", " ", compact)
        compact = re.sub(r"(?s)<[^>]+>", " ", compact)
        compact = re.sub(r"&nbsp;", " ", compact)
        compact = re.sub(r"\s+", " ", compact)
        match = re.search(rf"\b(\d{{{length}}})\b", compact)
        return match.group(1) if match else ""

    def wait_for_code(
        self,
        max_wait: int = 90,
        expected_length: int = 6,
        message_filter: Optional[Callable[[dict], bool]] = None,
    ) -> str:
        deadline = time.time() + max_wait
        while time.time() < deadline:
            for message in self.list_emails():
                detail = self.email_detail(message)
                if message_filter and not message_filter(detail):
                    continue
                body = " ".join(
                    str(detail.get(key) or "")
                    for key in ("subject", "content", "text_content", "html_content")
                )
                lower = body.lower()
                if "insmind" in lower or "verify your email" in lower or "验证码" in body or not message_filter:
                    code = self.extract_code(body, expected_length)
                    if code:
                        return code
            time.sleep(2)
        raise TimeoutError(f"no verification email within {max_wait}s")
