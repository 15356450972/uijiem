"""通过 OAuth2 + IMAP 自动接收 Outlook 验证码

用法:
    mailbox = OutlookMailbox(email, client_id, refresh_token)
    code = mailbox.fetch_verification_code()
"""

from __future__ import annotations

import email as email_lib
import imaplib
import re
import time

import requests


class OutlookMailbox:
    """通过 OAuth2 refresh_token 拉取 Outlook 邮箱中的 wizstar 验证码"""

    TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
    IMAP_HOST = "outlook.office365.com"

    def __init__(self, email: str, client_id: str, refresh_token: str):
        self.email = email
        self.client_id = client_id
        self.refresh_token = refresh_token
        self._access_token: str | None = None

    def get_access_token(self) -> str:
        if self._access_token:
            return self._access_token
        resp = requests.post(
            self.TOKEN_URL,
            data={
                "client_id": self.client_id,
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token,
            },
            timeout=30,
        )
        result = resp.json()
        if "access_token" not in result:
            raise RuntimeError(f"OAuth2 token failed: {result}")
        self._access_token = result["access_token"]
        return self._access_token

    @staticmethod
    def _xoauth2(user: str, token: str) -> str:
        return f"user={user}\x01auth=Bearer {token}\x01\x01"

    def fetch_verification_code(self, max_wait: int = 90, poll_interval: int = 5) -> str:
        token = self.get_access_token()
        deadline = time.time() + max_wait
        last_err = None
        while time.time() < deadline:
            try:
                mail = imaplib.IMAP4_SSL(self.IMAP_HOST)
                mail.authenticate("XOAUTH2", lambda _x: self._xoauth2(self.email, token))
                for folder in ("INBOX", "Junk"):
                    code = self._search_code(mail, folder)
                    if code:
                        try:
                            mail.logout()
                        except Exception:
                            pass
                        return code
                try:
                    mail.logout()
                except Exception:
                    pass
            except Exception as e:
                last_err = e
            elapsed = int(max_wait - (deadline - time.time()))
            print(f"  [mailbox] waiting code... ({elapsed}s)")
            time.sleep(poll_interval)
        raise TimeoutError(f"verification code not found in {max_wait}s (last err: {last_err})")

    def _search_code(self, mail: imaplib.IMAP4_SSL, folder: str) -> str | None:
        try:
            mail.select(folder)
        except Exception:
            return None
        status, messages = mail.search(None, "UNSEEN")
        ids = messages[0].split() if status == "OK" else []
        if not ids:
            status, messages = mail.search(None, "ALL")
            ids = messages[0].split() if status == "OK" else []
        for mid in reversed(ids[-15:]):
            try:
                _, data = mail.fetch(mid, "(RFC822)")
                msg = email_lib.message_from_bytes(data[0][1])
                subject = str(msg.get("subject", "")).lower()
                if not any(k in subject for k in ("wizstar", "verification", "code", "verify")):
                    continue
                body = self._get_body(msg)
                hits = re.findall(r"\b(\d{6})\b", body)
                if hits:
                    return hits[0]
            except Exception:
                continue
        return None

    @staticmethod
    def _get_body(msg) -> str:
        parts: list[str] = []
        if msg.is_multipart():
            for p in msg.walk():
                if p.get_content_type() in ("text/plain", "text/html"):
                    payload = p.get_payload(decode=True)
                    if payload:
                        parts.append(payload.decode("utf-8", errors="ignore"))
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                parts.append(payload.decode("utf-8", errors="ignore"))
        return "\n".join(parts)
