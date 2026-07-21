"""
Standalone Framia/Auth0 browser registration.

Run:
  python3 register.py

Outputs:
  framia-token-browser.json on success
  framia-credentials-browser.json on failure
"""

import argparse
import json
import random
import re
import string
import time
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlencode

import requests


GPTMAIL_HOST = "mail.chatgpt.org.uk"
GPTMAIL_BASE = f"https://{GPTMAIL_HOST}"
GPTMAIL_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
GPTMAIL_FALLBACK_DOMAIN = "ppoo.ccwu.cc"

DEFAULT_PASSWORD = "sjhga@q23324Q"
DEFAULT_OUTPUT = "framia-token-browser.json"
DEFAULT_ERROR_OUTPUT = "framia-credentials-browser.json"
STORAGE_STATE_PATH = Path(__file__).with_name("camoufox-storage-state.json")


class GPTMailClient:
    """Client for mail.chatgpt.org.uk temporary email."""

    _domain_cache: list = []
    _domain_cache_at: float = 0
    _DOMAIN_TTL = 30 * 60

    def __init__(self, session: Optional[requests.Session] = None):
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": GPTMAIL_UA})
        self.email: Optional[str] = None
        self._inbox_token: Optional[str] = None
        self._cookies: dict = {}

    @classmethod
    def get_valid_domains(cls, session: Optional[requests.Session] = None, timeout: int = 20) -> list:
        now = time.time()
        if cls._domain_cache and now - cls._domain_cache_at < cls._DOMAIN_TTL:
            return cls._domain_cache

        sess = session or requests.Session()
        sess.headers.update({"User-Agent": GPTMAIL_UA})

        for attempt in range(3):
            try:
                resp = sess.get(
                    f"{GPTMAIL_BASE}/api/domains/status",
                    headers={"Accept": "application/json"},
                    timeout=timeout,
                )
                resp.raise_for_status()
                data = resp.json()
                domains = [
                    d["domain_name"]
                    for d in data.get("data", {}).get("domains", [])
                    if d.get("mx_valid") and d.get("is_active")
                ]
                if domains:
                    cls._domain_cache = domains
                    cls._domain_cache_at = now
                    print(f"  [domains] refreshed pool: {len(domains)} valid domains")
                    return domains
                raise ValueError("empty domain list")
            except Exception as exc:
                if attempt < 2:
                    time.sleep(1 + attempt)
                    continue
                print(f"  [warn] fetch domains failed: {exc}, using cached/fallback")

        return cls._domain_cache or [GPTMAIL_FALLBACK_DOMAIN]

    @staticmethod
    def _random_prefix() -> str:
        chars = string.ascii_lowercase + string.digits
        length = 8 + random.randint(0, 3)
        return "".join(random.choice(chars) for _ in range(length))

    def generate_email(self) -> str:
        prefix = self._random_prefix()
        domains = self.get_valid_domains(self.session)
        domain = random.choice(domains)
        self.email = f"{prefix}@{domain}"
        print(f"  Generated email: {self.email}  (domain pool: {len(domains)})")
        return self.email

    def build_session(self, email: Optional[str] = None, timeout: int = 20) -> None:
        email = email or self.email
        if not email:
            raise ValueError("email is required")
        self.email = email

        for attempt in range(5):
            try:
                page_resp = self.session.get(
                    f"{GPTMAIL_BASE}/zh/{email}",
                    headers={
                        "User-Agent": GPTMAIL_UA,
                        "Accept": "text/html,application/xhtml+xml",
                        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    },
                    timeout=timeout,
                )
                cookies = {cookie.name: cookie.value for cookie in self.session.cookies}
                cookies.update({cookie.name: cookie.value for cookie in page_resp.cookies})

                if not cookies:
                    from http.cookies import SimpleCookie

                    parser = SimpleCookie()
                    parser.load(page_resp.headers.get("set-cookie", ""))
                    cookies = {key: morsel.value for key, morsel in parser.items()}

                if not cookies:
                    print("  [GPTMail] No cookies from page response (will get from inbox-token)")
                else:
                    print(f"  [GPTMail] Page cookies: {list(cookies)}")

                cookie_str = "; ".join(f"{name}={value}" for name, value in cookies.items())
                payload = json.dumps({"email": email})
                token_headers = {
                    "User-Agent": GPTMAIL_UA,
                    "Content-Type": "application/json",
                    "Content-Length": str(len(payload)),
                    "Referer": f"{GPTMAIL_BASE}/zh/{email}",
                }
                if cookie_str:
                    token_headers["Cookie"] = cookie_str

                token_resp = self.session.post(
                    f"{GPTMAIL_BASE}/api/inbox-token",
                    data=payload,
                    headers=token_headers,
                    timeout=timeout,
                )
                token_data = token_resp.json()
                if token_data.get("success") and token_data.get("auth", {}).get("token"):
                    self._inbox_token = token_data["auth"]["token"]
                    self._cookies = {cookie.name: cookie.value for cookie in self.session.cookies}
                    self._cookies.update(cookies)
                    self._cookies.update({cookie.name: cookie.value for cookie in token_resp.cookies})
                    print(f"  GPTMail session established for {email}")
                    print(f"  GPTMail cookies: {list(self._cookies.keys())}")
                    return

                if "Too many requests" in token_resp.text and attempt < 4:
                    wait = 2 + attempt * 2
                    print(f"  [rate-limit] waiting {wait}s before retry...")
                    time.sleep(wait)
                    continue
                raise ValueError(f"inbox-token failed: {token_resp.text[:200]}")
            except Exception as exc:
                if attempt == 4:
                    raise
                wait = 2 + attempt * 2
                print(f"  [retry] build_session attempt {attempt + 1} failed: {exc}, retrying in {wait}s")
                time.sleep(wait)

        raise ValueError("inbox-token failed after retries")

    @staticmethod
    def _message_key(mail: dict) -> str:
        message_id = mail.get("id") or mail.get("email_id") or mail.get("message_id")
        if message_id:
            return str(message_id)
        return "|".join(
            str(mail.get(field, ""))
            for field in ("timestamp", "created_at", "from_address", "subject")
        )

    @staticmethod
    def _mail_texts(mail: dict) -> list:
        text_fields = ("content", "html_content", "text", "body", "subject")
        detail_fields = ("detail", "details", "message", "email", "data")

        def collect(value) -> list:
            if isinstance(value, str):
                return [value]
            if isinstance(value, list):
                return [text for item in value for text in collect(item)]
            if not isinstance(value, dict):
                return []
            texts = [
                text
                for field in text_fields
                for text in collect(value.get(field, ""))
            ]
            return texts + [
                text
                for field in detail_fields
                for text in collect(value.get(field, ""))
            ]

        return collect(mail)

    @classmethod
    def _extract_verification_code(
        cls,
        mail: dict,
        expected_code_length: Optional[int] = None,
    ) -> Optional[str]:
        length_pattern = str(expected_code_length) if expected_code_length else "4,6"
        pattern = re.compile(rf"(?<!\d)(\d{{{length_pattern}}})(?!\d)")
        for body in cls._mail_texts(mail):
            match = pattern.search(body)
            if match:
                return match.group(1)
        return None

    @staticmethod
    def _is_converge_verification_mail(mail: dict) -> bool:
        sender = (mail.get("from_address") or "").lower()
        subject = (mail.get("subject") or "").lower()
        return sender.endswith("@converge.ai") or any(
            marker in subject
            for marker in ("verify your identity", "verify your email")
        )

    def get_emails(self, timeout: int = 15) -> dict:
        if not self.email:
            raise ValueError("no email set")
        if not self._inbox_token:
            raise ValueError("no inbox token")

        gm_cookies = {key: value for key, value in self._cookies.items() if key.startswith("gm_sid")}
        cookie_str = "; ".join(
            f"{key}={value}" for key, value in (gm_cookies or self._cookies).items()
        )
        resp = self.session.get(
            f"{GPTMAIL_BASE}/api/emails",
            params={"email": self.email},
            headers={
                "User-Agent": GPTMAIL_UA,
                "Cookie": cookie_str,
                "X-Inbox-Token": self._inbox_token,
                "Accept": "application/json",
                "Referer": f"{GPTMAIL_BASE}/zh/{self.email}",
            },
            timeout=timeout,
        )
        try:
            payload = resp.json()
        except ValueError:
            payload = None

        if not isinstance(payload, dict):
            return {"success": False, "status_code": resp.status_code, "error": resp.text[:200]}
        if resp.status_code >= 400:
            payload.setdefault("success", False)
            payload["status_code"] = resp.status_code
            payload.setdefault("error", resp.text[:200])
        return payload

    def current_message_keys(self) -> set:
        result = self.get_emails()
        if not result.get("success"):
            raise ValueError(
                f"could not snapshot inbox: HTTP {result.get('status_code', '?')} "
                f"{result.get('error', '')[:120]}"
            )
        emails = result.get("data", {}).get("emails", [])
        return {self._message_key(mail) for mail in emails}

    def _rebuild_session(self) -> None:
        self._inbox_token = None
        self._cookies = {}
        self.session.cookies.clear()
        self.build_session()

    def wait_for_code(
        self,
        max_wait: int = 120,
        poll_interval: float = 1.5,
        rebuild_threshold: int = 10,
        known_message_keys: Optional[set] = None,
        message_filter: Optional[Callable[[dict], bool]] = None,
        expected_code_length: Optional[int] = None,
    ) -> str:
        if not self._inbox_token:
            self.build_session()

        known_message_keys = known_message_keys or set()
        message_filter = message_filter or (lambda _mail: True)
        reported_message_keys = set()
        last_error = ""
        print(f"\n  Waiting for verification code (timeout: {max_wait}s)...")
        start = time.time()
        empty_count = 0

        while time.time() - start < max_wait:
            result = self.get_emails()
            elapsed = int(time.time() - start)

            if not result.get("success"):
                error = f"HTTP {result.get('status_code', '?')}: {result.get('error', 'unknown inbox error')[:120]}"
                if error != last_error:
                    print(f"\n  [inbox] {error}")
                    last_error = error
                empty_count += 1
            else:
                last_error = ""
                emails = result.get("data", {}).get("emails", [])
                new_messages = [
                    mail
                    for mail in emails
                    if self._message_key(mail) not in known_message_keys and message_filter(mail)
                ]

                for mail in new_messages:
                    message_key = self._message_key(mail)
                    if message_key not in reported_message_keys:
                        print(f"\n  Got verification email from: {mail.get('from_address', '?')}")
                        print(f"  Subject: {mail.get('subject', '?')}")
                        reported_message_keys.add(message_key)
                    code = self._extract_verification_code(mail, expected_code_length=expected_code_length)
                    if code:
                        print(f"  Verification code: {code}")
                        return code

                empty_count = empty_count + 1 if not new_messages else 0

            if empty_count >= rebuild_threshold:
                print(f"\n  [session rebuild] {empty_count} unsuccessful polls in {elapsed}s, rebuilding session...")
                try:
                    self._rebuild_session()
                    print("  [session rebuild] OK")
                    empty_count = 0
                except Exception as exc:
                    print(f"  [session rebuild] failed: {exc}")
                    empty_count = 0

            print(f"\r  Polling... ({elapsed}s)", end="", flush=True)
            time.sleep(poll_interval)

        print()
        raise TimeoutError(f"No new Converge verification email received within {max_wait}s")


def _read_framia_fingerprint_from_state(path: Path = STORAGE_STATE_PATH) -> Optional[dict]:
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text())
    except Exception:
        return None

    for origin in state.get("origins", []):
        if origin.get("origin") != "https://framia.converge.ai":
            continue
        for item in origin.get("localStorage", []):
            if item.get("name") != "framia_browser_fingerprint":
                continue
            try:
                data = json.loads(item.get("value") or "{}")
            except Exception:
                return None
            if data.get("visitorId"):
                return data
    return None


def _get_page_framia_fingerprint(page) -> Optional[dict]:
    return page.evaluate("""() => {
        try {
            const raw = localStorage.getItem('framia_browser_fingerprint');
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }""")


def _wait_for_page_framia_fingerprint(page, seconds: int) -> Optional[dict]:
    for _ in range(seconds):
        fingerprint = _get_page_framia_fingerprint(page)
        if fingerprint and fingerprint.get("visitorId"):
            return fingerprint
        time.sleep(1)
    return None


def _trigger_framia_fingerprint_generation(page) -> Optional[dict]:
    fingerprint = _wait_for_page_framia_fingerprint(page, 6)
    if fingerprint:
        return fingerprint

    print("  [Browser] Fingerprint not ready on homepage, trying app entrypoints...")
    trigger_urls = [
        "https://framia.converge.ai/create/",
    ]
    for url in trigger_urls:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            print(f"  [Browser] Trigger navigation failed: {url} ({exc})")
        fingerprint = _wait_for_page_framia_fingerprint(page, 6)
        if fingerprint:
            return fingerprint
        if "auth.converge.ai" in page.url:
            try:
                page.goto("https://framia.converge.ai/", wait_until="domcontentloaded", timeout=30000)
            except Exception:
                pass

    try:
        page.goto("https://framia.converge.ai/", wait_until="domcontentloaded", timeout=30000)
        page.evaluate("""() => {
            const candidates = [...document.querySelectorAll('a, button')];
            const target = candidates.find((el) => {
                const text = (el.innerText || el.textContent || '').toLowerCase();
                const href = (el.getAttribute && el.getAttribute('href') || '').toLowerCase();
                return href.includes('/create') || href.includes('/auth/login') ||
                    text.includes('create') || text.includes('login') || text.includes('sign in') ||
                    text.includes('创作') || text.includes('登录');
            });
            if (target) target.click();
        }""")
    except Exception as exc:
        print(f"  [Browser] Trigger click failed: {exc}")
    return _wait_for_page_framia_fingerprint(page, 6)


def _ensure_framia_fingerprint(page) -> dict:
    fingerprint = _trigger_framia_fingerprint_generation(page)
    if fingerprint and fingerprint.get("visitorId"):
        print("  [Browser] Fingerprint generated by live page runtime")
        return fingerprint

    fingerprint = _read_framia_fingerprint_from_state()
    if not fingerprint:
        raise RuntimeError("Framia browser fingerprint was not generated")

    print("  [Browser] Using fingerprint fallback from storage state")
    page.goto("https://framia.converge.ai/", wait_until="domcontentloaded", timeout=30000)
    page.evaluate("""(value) => {
        localStorage.setItem('framia_browser_fingerprint', JSON.stringify(value));
    }""", fingerprint)
    return fingerprint


def start_framia_auth_transaction(page) -> dict:
    print("  [Browser] Preparing Framia risk-bound auth transaction...")
    fingerprint = _ensure_framia_fingerprint(page)

    visitor_id = fingerprint["visitorId"]
    fp_event_id = (
        fingerprint.get("eventId")
        or fingerprint.get("requestId")
        or f"{int(time.time() * 1000)}.browser"
    )
    print(f"  [Browser] Risk-session request: visitor_id={visitor_id}, fp_event_id={fp_event_id}")
    risk_data = page.evaluate("""async ({visitorId, eventId}) => {
        const resp = await fetch('https://api.framia.pro/video/api/v1/auth/risk-session', {
            method: 'POST',
            credentials: 'include',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                visitor_id: visitorId,
                fp_event_id: eventId,
                platform: 'web',
            }),
        });
        const text = await resp.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return {status: resp.status, ok: resp.ok, data, text};
    }""", {"visitorId": visitor_id, "eventId": fp_event_id})
    risk_body = risk_data.get("data") or {}
    risk_session_id = (
        risk_body.get("risk_session_id")
        or risk_body.get("data", {}).get("risk_session_id")
    )
    if not risk_session_id:
        raise RuntimeError(f"Framia risk-session failed: {risk_data}")

    params = urlencode({
        "returnTo": "/create/",
        "risk_session_id": risk_session_id,
        "ext-fingerprint": visitor_id,
        "acr_values": visitor_id,
    })
    login_url = f"https://framia.converge.ai/auth/login/?{params}"
    print("  [Browser] Risk session ready: " f"{risk_session_id} / fingerprint={visitor_id}")
    print(f"  [Browser] Login URL: {login_url}")
    page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
    return {
        "visitor_id": visitor_id,
        "fp_event_id": fp_event_id,
        "risk_session_id": risk_session_id,
    }


def _click_submit(page) -> None:
    try:
        submit_btn = page.locator("button[type='submit']").first
        submit_btn.click(timeout=10000)
    except Exception:
        page.evaluate("""() => {
            const btn = document.querySelector('button[type="submit"]');
            if (btn) btn.click();
        }""")


def register_via_browser(email: str, password: str, mail_client: GPTMailClient, headless: bool = False) -> dict:
    from patchright.sync_api import TimeoutError as PWTimeout
    from patchright.sync_api import sync_playwright

    result = {"success": False, "cookies": {}, "token": None, "error": None}

    print("  [Browser] Launching anti-detection browser for full registration flow...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, args=[
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
        ])
        context = browser.new_context(
            locale="zh-CN",
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        # Keep resources available while Framia fingerprint initializes; block heavy resources after auth starts
        block_heavy = {"enabled": False}
        def _route_handler(route):
            rtype = route.request.resource_type
            if block_heavy["enabled"] and rtype in ("image", "font", "media"):
                route.abort()
            else:
                route.continue_()
        context.route("**/*", _route_handler)
        page = context.new_page()

        print("  [Browser] Step 1: Navigate to framia.converge.ai...")
        page.goto("https://framia.converge.ai/", wait_until="domcontentloaded", timeout=30000)
        start_framia_auth_transaction(page)
        block_heavy["enabled"] = True

        print("  [Browser] Waiting for Auth0 login page...")
        try:
            page.wait_for_url("**/auth.converge.ai/**", timeout=30000)
        except PWTimeout:
            print(f"  [Browser] Still waiting at: {page.url[:80]}...")
        print(f"  [Browser] Landed on: {page.url[:80]}...")

        print("  [Browser] Step 2: Switch to signup page...")
        try:
            signup_link = page.get_by_role("link", name="Sign up").first
            signup_link.wait_for(state="visible", timeout=10000)
            signup_link.click()
        except Exception:
            page.evaluate("""() => {
                const link = [...document.querySelectorAll('a')]
                    .find((a) => a.textContent.toLowerCase().includes('sign up'));
                if (link) link.click();
            }""")

        page.wait_for_url("**/auth.converge.ai/u/signup/identifier**", timeout=15000)
        print(f"  [Browser] Signup page: {page.url[:80]}...")

        print("  [Browser] Step 3: Fill email and wait for Turnstile...")
        email_input = page.locator("input[name='email']").first
        email_input.wait_for(state="visible", timeout=10000)
        email_input.fill(email)
        print(f"  [Browser] Email filled: {email}")

        print("  [Browser] Waiting for Turnstile to auto-solve...")
        turnstile_solved = False
        for attempt in range(15):
            turnstile_token = page.evaluate("""() => {
                const input = document.querySelector('input[name="cf-turnstile-response"]');
                return input && input.value ? input.value : null;
            }""")
            if turnstile_token:
                print(f"  [Browser] Turnstile solved! Token: {turnstile_token[:40]}...")
                turnstile_solved = True
                break
            if attempt % 5 == 4:
                print(f"  [Browser] Still waiting for Turnstile... ({attempt + 1}s)")
            time.sleep(1)

        if not turnstile_solved:
            print("  [Browser] Turnstile auto-solve timed out, trying to click checkbox...")
            try:
                turnstile_frame = page.frame_locator("iframe[src*='turnstile']").first
                turnstile_frame.locator("body").first.click(timeout=3000)
                time.sleep(3)
                # Check again after click
                turnstile_token = page.evaluate("""() => {
                    const input = document.querySelector('input[name="cf-turnstile-response"]');
                    return input && input.value ? input.value : null;
                }""")
                if turnstile_token:
                    print(f"  [Browser] Turnstile solved after click! Token: {turnstile_token[:40]}...")
                    turnstile_solved = True
            except Exception:
                print("  [Browser] Could not click Turnstile checkbox, proceeding anyway...")

        print("  [Browser] Clicking continue button...")
        _click_submit(page)

        print("  [Browser] Step 4: Waiting for email code page...")
        try:
            page.wait_for_url("**/auth.converge.ai/u/email-identifier/challenge**", timeout=30000)
        except PWTimeout:
            print(f"  [Browser] Current URL: {page.url[:80]}...")
            if "challenge" not in page.url:
                error_text = page.evaluate("() => document.body ? document.body.innerText : ''")
                if "error" in error_text.lower() or "blocked" in error_text.lower():
                    result["error"] = f"Signup failed: {error_text[:200]}"
                    browser.close()
                    return result

        print(f"  [Browser] On verification page: {page.url[:80]}...")

        print("  [Browser] Step 5: Waiting for verification code...")
        try:
            known_keys = mail_client.current_message_keys()
        except Exception:
            known_keys = set()

        code = mail_client.wait_for_code(
            max_wait=60,
            poll_interval=1.0,
            known_message_keys=known_keys,
            message_filter=GPTMailClient._is_converge_verification_mail,
            expected_code_length=6,
        )
        print(f"  [Browser] Code received: {code}")

        print("  [Browser] Step 6: Entering verification code...")
        code_input = page.locator("input[name='code']").first
        code_input.wait_for(state="visible", timeout=10000)
        code_input.fill(code)
        _click_submit(page)

        print("  [Browser] Step 7: Waiting for password page...")
        try:
            page.wait_for_url("**/auth.converge.ai/u/signup/password**", timeout=30000)
        except PWTimeout:
            print(f"  [Browser] Current URL after code: {page.url[:80]}...")

        print(f"  [Browser] On password page: {page.url[:80]}...")
        pwd_input = page.locator("input[name='password']").first
        pwd_input.wait_for(state="visible", timeout=10000)
        pwd_input.fill(password)
        print(f"  [Browser] Password filled (len={len(password)})")

        print("  [Browser] Submitting password...")
        _click_submit(page)
        time.sleep(3)

        if "signup/password" in page.url:
            print("  [Browser] Still on password page after submit, checking for errors...")
            error_text = page.evaluate("() => document.body ? document.body.innerText : ''")
            print(f"  [Browser] Page text: {error_text[:300]}")
            lowered = error_text.lower()
            if "too weak" in lowered or "password is required" in lowered:
                result["error"] = f"Password rejected: {error_text[:200]}"
                browser.close()
                return result
            if "too many signup attempts" in lowered:
                result["error"] = "Auth0 rate limit: Too many signup attempts. Please wait and try again later."
                browser.close()
                return result

            turnstile_input = page.evaluate("""() => {
                const input = document.querySelector('input[name="cf-turnstile-response"]');
                return input && input.value ? input.value : null;
            }""")
            if not turnstile_input:
                print("  [Browser] No Turnstile token on password page, waiting for it...")
                for _ in range(30):
                    turnstile_input = page.evaluate("""() => {
                        const input = document.querySelector('input[name="cf-turnstile-response"]');
                        return input && input.value ? input.value : null;
                    }""")
                    if turnstile_input:
                        print("  [Browser] Password page Turnstile solved!")
                        break
                    time.sleep(1)
                _click_submit(page)
                time.sleep(3)

        print("  [Browser] Step 8: Waiting for auth callback redirect...")
        try:
            page.wait_for_url("**/framia.converge.ai/**", timeout=30000)
        except PWTimeout:
            print(f"  [Browser] Current URL after password: {page.url[:80]}...")
            error_text = page.evaluate("() => document.body ? document.body.innerText : ''")
            if "error" in error_text.lower() or "blocked" in error_text.lower():
                result["error"] = f"Auth callback failed: {error_text[:200]}"
                browser.close()
                return result

        print(f"  [Browser] Final URL: {page.url[:120]}...")
        if "login-error" in page.url or "error=" in page.url:
            error_text = page.evaluate("() => document.body ? document.body.innerText : ''")
            print(f"  [Browser] Final error page text: {error_text[:500]}")

        print("  [Browser] Step 9: Getting JWT token...")
        token_data = page.evaluate("""async () => {
            try {
                const resp = await fetch('/api/auth/token', {credentials: 'include'});
                return await resp.json();
            } catch (e) {
                return {error: e.message};
            }
        }""")

        # Always extract cookies (even on failure — Auth0 account may be created)
        all_cookies = context.cookies()
        result["cookies"] = {cookie["name"]: cookie["value"] for cookie in all_cookies}
        result["cookie_list"] = [
            {"name": c["name"], "value": c["value"], "domain": c["domain"], "path": c["path"]}
            for c in all_cookies
        ]
        print(f"  [Browser] All cookies ({len(all_cookies)}): {list(result['cookies'].keys())}")

        if token_data and token_data.get("isAuthenticated"):
            result["token"] = token_data.get("accessToken")
            result["success"] = True
            print(f"  [Browser] JWT token: {result['token'][:50]}...")
        else:
            result["error"] = f"Failed to get JWT token: {json.dumps(token_data)[:200]}"
            print(f"  [Browser] Token response: {json.dumps(token_data)[:200]}")

            # Try retry: navigate to homepage and re-fetch token
            print("  [Browser] Retrying token fetch from homepage...")
            try:
                page.goto("https://framia.converge.ai/", wait_until="domcontentloaded", timeout=15000)
                time.sleep(3)
                retry_token = page.evaluate("""async () => {
                    try {
                        const resp = await fetch('/api/auth/token', {credentials: 'include'});
                        return await resp.json();
                    } catch (e) {
                        return {error: e.message};
                    }
                }""")
                print(f"  [Browser] Retry token response: {json.dumps(retry_token)[:200]}")
                if retry_token and retry_token.get("isAuthenticated"):
                    result["token"] = retry_token.get("accessToken")
                    result["success"] = True
                    result["error"] = None
                    print(f"  [Browser] Retry JWT token: {result['token'][:50]}...")
                    # Refresh cookies after retry
                    all_cookies = context.cookies()
                    result["cookies"] = {cookie["name"]: cookie["value"] for cookie in all_cookies}
                    result["cookie_list"] = [
                        {"name": c["name"], "value": c["value"], "domain": c["domain"], "path": c["path"]}
                        for c in all_cookies
                    ]
            except Exception as exc:
                print(f"  [Browser] Retry failed: {exc}")

        # If still not authenticated, try re-login with existing Auth0 session
        if not result["success"]:
            print("  [Browser] Attempting re-login with existing Auth0 session...")
            try:
                # Start a fresh auth transaction (new risk session)
                auth_tx = start_framia_auth_transaction(page)
                print(f"  [Browser] Re-login risk session: {auth_tx['risk_session_id']}")

                # Wait for Auth0 page — if Auth0 session is valid, it may auto-redirect
                try:
                    page.wait_for_url("**/auth.converge.ai/**", timeout=15000)
                    print(f"  [Browser] Re-login Auth0 page: {page.url[:80]}...")

                    # Check if we're on login/identifier (need to enter email) or auto-redirecting
                    if "/u/login/identifier" in page.url:
                        print("  [Browser] Auth0 asking for email again, filling...")
                        email_input2 = page.locator("input[name='email']").first
                        email_input2.wait_for(state="visible", timeout=10000)
                        email_input2.fill(email)
                        # Wait for Turnstile
                        for t_attempt in range(15):
                            ts_token = page.evaluate("""() => {
                                const input = document.querySelector('input[name="cf-turnstile-response"]');
                                return input && input.value ? input.value : null;
                            }""")
                            if ts_token:
                                print(f"  [Browser] Re-login Turnstile solved! ({t_attempt}s)")
                                break
                            if t_attempt % 10 == 9:
                                print(f"  [Browser] Re-login waiting Turnstile... ({t_attempt+1}s)")
                            time.sleep(1)
                        _click_submit(page)
                        time.sleep(3)

                    # Check if on password page
                    if "/u/login/password" in page.url:
                        print("  [Browser] Auth0 asking for password, filling...")
                        pwd_input2 = page.locator("input[name='password']").first
                        pwd_input2.wait_for(state="visible", timeout=10000)
                        pwd_input2.fill(password)
                        _click_submit(page)
                        time.sleep(5)

                    # Wait for redirect to framia
                    try:
                        page.wait_for_url("**/framia.converge.ai/**", timeout=30000)
                    except PWTimeout:
                        print(f"  [Browser] Re-login current URL: {page.url[:80]}...")

                    print(f"  [Browser] Re-login final URL: {page.url[:120]}...")

                    # Try token again
                    relogin_token = page.evaluate("""async () => {
                        try {
                            const resp = await fetch('/api/auth/token', {credentials: 'include'});
                            return await resp.json();
                        } catch (e) {
                            return {error: e.message};
                        }
                    }""")
                    print(f"  [Browser] Re-login token response: {json.dumps(relogin_token)[:200]}")
                    if relogin_token and relogin_token.get("isAuthenticated"):
                        result["token"] = relogin_token.get("accessToken")
                        result["success"] = True
                        result["error"] = None
                        print(f"  [Browser] Re-login JWT token: {result['token'][:50]}...")
                        all_cookies = context.cookies()
                        result["cookies"] = {cookie["name"]: cookie["value"] for cookie in all_cookies}
                        result["cookie_list"] = [
                            {"name": c["name"], "value": c["value"], "domain": c["domain"], "path": c["path"]}
                            for c in all_cookies
                        ]
                except PWTimeout:
                    print(f"  [Browser] Re-login: no Auth0 redirect, current URL: {page.url[:80]}...")

                # Check if on password page (either from identifier flow or direct)
                if "/u/login/password" in page.url and not result["success"]:
                    print("  [Browser] Auth0 on password page, filling...")
                    pwd_input2 = page.locator("input[name='password']").first
                    pwd_input2.wait_for(state="visible", timeout=10000)
                    pwd_input2.fill(password)
                    _click_submit(page)
                    time.sleep(5)
                    try:
                        page.wait_for_url("**/framia.converge.ai/**", timeout=30000)
                    except PWTimeout:
                        print(f"  [Browser] Re-login current URL: {page.url[:80]}...")
                    print(f"  [Browser] Re-login final URL: {page.url[:120]}...")
                    relogin_token = page.evaluate("""async () => {
                        try {
                            const resp = await fetch('/api/auth/token', {credentials: 'include'});
                            return await resp.json();
                        } catch (e) {
                            return {error: e.message};
                        }
                    }""")
                    print(f"  [Browser] Re-login token response: {json.dumps(relogin_token)[:200]}")
                    if relogin_token and relogin_token.get("isAuthenticated"):
                        result["token"] = relogin_token.get("accessToken")
                        result["success"] = True
                        result["error"] = None
                        print(f"  [Browser] Re-login JWT token: {result['token'][:50]}...")
                        all_cookies = context.cookies()
                        result["cookies"] = {cookie["name"]: cookie["value"] for cookie in all_cookies}
                        result["cookie_list"] = [
                            {"name": c["name"], "value": c["value"], "domain": c["domain"], "path": c["path"]}
                            for c in all_cookies
                        ]

                # If we landed on framia without Auth0, try token
                if "framia.converge.ai" in page.url and not result["success"]:
                    final_token = page.evaluate("""async () => {
                        try {
                            const resp = await fetch('/api/auth/token', {credentials: 'include'});
                            return await resp.json();
                        } catch (e) {
                            return {error: e.message};
                        }
                    }""")
                    print(f"  [Browser] Re-login direct token: {json.dumps(final_token)[:200]}")
                    if final_token and final_token.get("isAuthenticated"):
                        result["token"] = final_token.get("accessToken")
                        result["success"] = True
                        result["error"] = None
                        print(f"  [Browser] Re-login JWT token: {result['token'][:50]}...")
                        all_cookies = context.cookies()
                        result["cookies"] = {cookie["name"]: cookie["value"] for cookie in all_cookies}
                        result["cookie_list"] = [
                            {"name": c["name"], "value": c["value"], "domain": c["domain"], "path": c["path"]}
                            for c in all_cookies
                        ]
            except Exception as exc:
                print(f"  [Browser] Re-login attempt failed: {exc}")

        browser.close()

    return result


def generate_password() -> str:
    return DEFAULT_PASSWORD


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Standalone Framia browser registration")
    parser.add_argument("--email", help="Use an existing GPTMail email instead of generating one")
    parser.add_argument("--password", default=DEFAULT_PASSWORD, help="Password for the new account")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Success JSON output path")
    parser.add_argument("--error-output", default=DEFAULT_ERROR_OUTPUT, help="Failure JSON output path")
    parser.add_argument("--headless", action="store_true", help="Run browser in headless mode")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    print("=" * 60)
    print("  Standalone Framia Browser Registration")
    print("=" * 60)

    print("\n[1] Prepare email")
    mail = GPTMailClient()
    email = args.email or mail.generate_email()
    password = args.password or generate_password()
    print(f"  Email: {email}")
    print(f"  Password: {password}")

    print("\n[2] Build mail session")
    mail.build_session(email)
    try:
        known_keys = mail.current_message_keys()
        print(f"  [GPTMail] Inbox baseline: {len(known_keys)} existing messages")
    except Exception:
        known_keys = set()

    print("\n[3] Browser registration")
    result = register_via_browser(email, password, mail, headless=args.headless)

    if result["success"]:
        print("\n✓ Registration successful!")
        print(f"  Email: {email}")
        print(f"  Password: {password}")
        print(f"  Token: {result['token'][:60]}...")
        Path(args.output).write_text(
            json.dumps(
                {
                    "email": email,
                    "password": password,
                    "token": result["token"],
                    "cookies": result.get("cookies", {}),
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        print(f"  Saved to {args.output}")
        return 0

    print(f"\n✗ Registration failed: {result.get('error', 'unknown')}")
    Path(args.error_output).write_text(
        json.dumps(
            {
                "email": email,
                "password": password,
                "error": result.get("error"),
                "cookies": result.get("cookies", {}),
                "cookie_list": result.get("cookie_list", []),
                "token": result.get("token"),
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    print(f"  Credentials saved to {args.error_output}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())