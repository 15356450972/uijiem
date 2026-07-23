#!/usr/bin/env python3
"""insMind (稿定海外站) 邮箱验证码注册测试。

协议来源：capture-2026-07-23T03-02-31.json + UMS 前端 assets 逆向。
邮箱 / 收码：GPTMail（mail.chatgpt.org.uk），逻辑对齐 GPTMail_完整代码.md。
图形验证码：UMS /api/capcha (SVG) → Chrome 转 PNG → YesCaptcha ImageToTextTask。

流程：
  1. GPTMail 生成临时邮箱并建立 session（cookie 现在由 /api/inbox-token 下发）
  2. 拉取图形验证码并 OCR
  3. POST ums.insmind.com/api/users/verify-code 发邮箱验证码
  4. 轮询 GPTMail 收件箱提取 6 位验证码
  5. POST ums.insmind.com/connect/oauth/tokens 用 verify_code 注册/登录

用法：
  python3 insmind_test.py
  python3 insmind_test.py --email someone@ppoo.ccwu.cc
  YESCAP_KEY=xxx python3 insmind_test.py   # 或放 quickframe-sdk-full/_yescap_key.txt
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import re
import shutil
import string
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional


# ---------------------------------------------------------------------------
# GPTMail
# ---------------------------------------------------------------------------

GPTMAIL_HOST = "mail.chatgpt.org.uk"
FALLBACK_DOMAIN = "ppoo.ccwu.cc"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)


def _http(
    url: str,
    *,
    method: str = "GET",
    headers: Optional[dict[str, str]] = None,
    body: Any = None,
    form: bool = False,
    timeout: int = 30,
) -> dict:
    req_headers = {"User-Agent": UA, **(headers or {})}
    data: Optional[bytes] = None
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            req_headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        elif isinstance(body, (dict, list)):
            data = json.dumps(body, ensure_ascii=False).encode()
            req_headers.setdefault("Content-Type", "application/json")
        elif isinstance(body, bytes):
            data = body
        else:
            data = str(body).encode()

    request = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", "ignore")
            try:
                set_cookies = response.headers.get_all("Set-Cookie") or []
            except Exception:
                raw = response.headers.get("Set-Cookie")
                set_cookies = [raw] if raw else []
            cookies = [item.split(";", 1)[0] for item in set_cookies if item]
            try:
                payload = json.loads(text)
            except ValueError:
                payload = None
            return {
                "status": response.status,
                "text": text,
                "json": payload,
                "cookies": cookies,
            }
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "ignore")
        try:
            payload = json.loads(text)
        except ValueError:
            payload = None
        return {
            "status": exc.code,
            "text": text,
            "json": payload,
            "cookies": [],
            "error": True,
        }


class GPTMailClient:
    """临时邮箱：生成地址 / 建 session / 轮询验证码。"""

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
        result = _http(
            f"https://{GPTMAIL_HOST}/api/domains/status",
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
        return cls._domain_cache or [FALLBACK_DOMAIN]

    @staticmethod
    def random_prefix() -> str:
        chars = string.ascii_lowercase + string.digits
        return "".join(random.choice(chars) for _ in range(random.randint(8, 11)))

    def generate_email(self, prefer_fallback: bool = True) -> str:
        # ppoo.ccwu.cc 对稿定发信投递更稳；需要轮换时关掉 prefer_fallback
        if prefer_fallback:
            domain = FALLBACK_DOMAIN
        else:
            domain = random.choice(self.valid_domains())
        self.email = f"{self.random_prefix()}@{domain}"
        print(f"  [GPTMail] Email: {self.email}")
        return self.email

    def build_session(self, email: Optional[str] = None) -> dict:
        self.email = (email or self.email).strip()
        if not self.email:
            raise ValueError("email is required")

        # 页面访问仍保留（兼容旧行为）；当前 gm_sid 由 inbox-token 下发
        _http(
            f"https://{GPTMAIL_HOST}/zh/{urllib.parse.quote(self.email)}",
            headers={"Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9"},
            timeout=20,
        )
        token_result = _http(
            f"https://{GPTMAIL_HOST}/api/inbox-token",
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Referer": f"https://{GPTMAIL_HOST}/zh/{self.email}",
            },
            body={"email": self.email},
            timeout=20,
        )
        data = token_result.get("json") or {}
        self.token = (((data.get("auth") or {}).get("token")) if data.get("success") else "") or ""
        # 关键：cookie 在 inbox-token 的 Set-Cookie 里
        self.cookies = token_result.get("cookies") or []
        if not self.token:
            raise RuntimeError(f"GPTMail inbox-token failed: {token_result.get('text', '')[:200]}")
        if not any(c.startswith("gm_sid=") for c in self.cookies):
            raise RuntimeError(f"GPTMail missing gm_sid cookie: {self.cookies}")
        print(f"  [GPTMail] Session ok (cookies={len(self.cookies)})")
        return {"email": self.email, "cookies": self.cookies, "token": self.token}

    def _cookie_header(self) -> str:
        gm = [c for c in self.cookies if c.startswith("gm_sid=")]
        return "; ".join(gm or self.cookies)

    def list_emails(self) -> list[dict]:
        if not self.token or not self.cookies:
            self.build_session(self.email)
        result = _http(
            f"https://{GPTMAIL_HOST}/api/emails?email={urllib.parse.quote(self.email)}",
            headers={
                "Accept": "application/json",
                "Cookie": self._cookie_header(),
                "X-Inbox-Token": self.token,
                "Referer": f"https://{GPTMAIL_HOST}/zh/{self.email}",
            },
            timeout=20,
        )
        if result.get("status") in (401, 403):
            self.build_session(self.email)
            result = _http(
                f"https://{GPTMAIL_HOST}/api/emails?email={urllib.parse.quote(self.email)}",
                headers={
                    "Accept": "application/json",
                    "Cookie": self._cookie_header(),
                    "X-Inbox-Token": self.token,
                    "Referer": f"https://{GPTMAIL_HOST}/zh/{self.email}",
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
        result = _http(
            f"https://{GPTMAIL_HOST}/api/email/{urllib.parse.quote(str(message_id))}",
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

    def wait_for_code(self, max_wait: int = 90, expected_length: int = 6) -> str:
        print("  [GPTMail] Waiting for verification code...")
        deadline = time.time() + max_wait
        while time.time() < deadline:
            for message in self.list_emails():
                detail = self.email_detail(message)
                body = " ".join(
                    str(detail.get(key) or "")
                    for key in ("subject", "content", "text_content", "html_content")
                )
                # 优先认 insMind 邮件
                lower = body.lower()
                if "insmind" in lower or "verify your email" in lower or "验证码" in body:
                    code = self.extract_code(body, expected_length)
                    if code:
                        print(f"  [GPTMail] Code: {code}")
                        return code
                code = self.extract_code(body, expected_length)
                if code:
                    print(f"  [GPTMail] Code: {code}")
                    return code
            elapsed = int(max_wait - (deadline - time.time()))
            print(f"  [GPTMail] Polling... ({elapsed}s)")
            time.sleep(2)
        raise TimeoutError(f"no verification email within {max_wait}s")


# ---------------------------------------------------------------------------
# insMind UMS
# ---------------------------------------------------------------------------

UMS_HOST = "https://ums.insmind.com"
CLIENT_ID = "gaodingx"
CLIENT_SECRET = "7da458070e57b98e11d00d9286f23537"
PORTAL = "gaoding"
BIZ_CODE = "1"
REGION_ID = "2"
ENDPOINT = "4"
YESCAPTCHA_API = "https://api.yescaptcha.com"


def _ums_headers(extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": UMS_HOST,
        "Referer": f"{UMS_HOST}/cgi-bin?biz_code={BIZ_CODE}&appid={CLIENT_ID}",
        "x-biz-code": BIZ_CODE,
        "x-region-id": REGION_ID,
        "x-endpoint": ENDPOINT,
        "x-device-name": urllib.parse.quote("Mac OS Chrome"),
    }
    if extra:
        headers.update(extra)
    return headers


def _load_yescap_key() -> str:
    env_key = (os.environ.get("YESCAP_KEY") or os.environ.get("YESCAPTCHA_KEY") or "").strip()
    if env_key:
        return env_key
    candidates = [
        Path(__file__).resolve().parent / "quickframe-sdk-full" / "_yescap_key.txt",
        Path(__file__).resolve().parent / "_yescap_key.txt",
    ]
    for path in candidates:
        if path.is_file():
            key = path.read_text(encoding="utf-8").strip()
            if key:
                return key
    raise RuntimeError(
        "YesCaptcha key missing. Set YESCAP_KEY or put it in quickframe-sdk-full/_yescap_key.txt"
    )


def fetch_capcha_svg(email: str) -> bytes:
    """POST /api/capcha，返回 SVG 字节。channel=email。"""
    result = _http(
        f"{UMS_HOST}/api/capcha",
        method="POST",
        headers=_ums_headers({"Accept": "image/svg+xml,application/json,*/*"}),
        body={"channel": "email", "email": email.strip().lower()},
        form=True,
        timeout=20,
    )
    raw = result.get("text") or ""
    if result["status"] != 200 or "<svg" not in raw:
        raise RuntimeError(f"fetch captcha failed: {result['status']} {raw[:200]}")
    return raw.encode("utf-8")


# 与 insmind-sdk 一致：默认 qlmanage，不起浏览器
_SVG_RENDER_SEM = threading.Semaphore(int(os.environ.get("INSMIND_CAPTCHA_RENDER_CONCURRENCY") or "4"))
_ALLOW_CHROME = (os.environ.get("INSMIND_CAPTCHA_ALLOW_CHROME") or "").strip().lower() in {
    "1", "true", "yes", "on",
}


def svg_to_png(svg_bytes: bytes) -> bytes:
    """把 SVG 渲染成 PNG（默认 qlmanage，可选 Chrome）。"""
    last_err = "unable to render captcha SVG to PNG (need qlmanage)"
    for attempt in range(1, 4):
        with _SVG_RENDER_SEM:
            with tempfile.TemporaryDirectory(prefix="insmind-capcha-") as tmp:
                tmp_path = Path(tmp)
                svg_path = tmp_path / "cap.svg"
                svg_path.write_bytes(svg_bytes)

                qlmanage = shutil.which("qlmanage")
                if qlmanage:
                    subprocess.run(
                        [qlmanage, "-t", "-s", "400", "-o", str(tmp_path), str(svg_path)],
                        check=False,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=15,
                    )
                    preview = tmp_path / "cap.svg.png"
                    if preview.is_file() and preview.stat().st_size > 0:
                        return preview.read_bytes()

                if _ALLOW_CHROME:
                    html_path = tmp_path / "cap.html"
                    png_path = tmp_path / "cap.png"
                    profile = tmp_path / "chrome-profile"
                    profile.mkdir(parents=True, exist_ok=True)
                    html_path.write_text(
                        "<!doctype html><html><body style='margin:0;background:#fff'>"
                        f"<img src='{svg_path.name}' width='300' height='100'>"
                        "</body></html>",
                        encoding="utf-8",
                    )
                    chrome = (
                        os.environ.get("CHROME_PATH")
                        or "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                    )
                    if Path(chrome).exists():
                        subprocess.run(
                            [
                                chrome,
                                "--headless=new",
                                "--disable-gpu",
                                "--no-first-run",
                                "--no-default-browser-check",
                                f"--user-data-dir={profile}",
                                f"--screenshot={png_path}",
                                "--window-size=300,120",
                                html_path.as_uri(),
                            ],
                            check=False,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            timeout=20,
                        )
                        if png_path.is_file() and png_path.stat().st_size > 0:
                            return png_path.read_bytes()
                last_err = f"unable to render captcha SVG to PNG (attempt {attempt}/3)"
        time.sleep(0.2 * attempt)
    raise RuntimeError(last_err)


def solve_image_captcha(png_bytes: bytes, *, max_wait: int = 60) -> str:
    """YesCaptcha ImageToTextTask 识别 4 位图形验证码。"""
    key = _load_yescap_key()
    create = _http(
        f"{YESCAPTCHA_API}/createTask",
        method="POST",
        body={
            "clientKey": key,
            "task": {
                "type": "ImageToTextTask",
                "body": base64.b64encode(png_bytes).decode("ascii"),
                "case": True,
                "minLength": 4,
                "maxLength": 4,
            },
        },
        timeout=30,
    )
    data = create.get("json") or {}
    if data.get("errorId"):
        raise RuntimeError(f"YesCaptcha createTask failed: {data}")
    if data.get("status") == "ready":
        text = ((data.get("solution") or {}).get("text") or "").strip()
        if text:
            print(f"  [OCR] captcha={text}")
            return text
    task_id = data.get("taskId")
    if not task_id:
        raise RuntimeError(f"YesCaptcha missing taskId: {data}")

    deadline = time.time() + max_wait
    while time.time() < deadline:
        time.sleep(2)
        poll = _http(
            f"{YESCAPTCHA_API}/getTaskResult",
            method="POST",
            body={"clientKey": key, "taskId": task_id},
            timeout=30,
        )
        payload = poll.get("json") or {}
        if payload.get("errorId"):
            raise RuntimeError(f"YesCaptcha getTaskResult failed: {payload}")
        if payload.get("status") == "ready":
            text = ((payload.get("solution") or {}).get("text") or "").strip()
            if not text:
                raise RuntimeError(f"YesCaptcha empty solution: {payload}")
            print(f"  [OCR] captcha={text}")
            return text
        print("  [OCR] processing...")
    raise TimeoutError("YesCaptcha OCR timeout")


def send_email_code(email: str, code_type: str = "login", *, max_capcha_retries: int = 1) -> dict:
    """发送邮箱验证码。限流后会要求图形验证码（capcha 字段拼写沿用官方）。"""
    last_error = ""
    for attempt in range(1, max_capcha_retries + 1):
        print(f"  [UMS] captcha attempt {attempt}/{max_capcha_retries}")
        svg = fetch_capcha_svg(email)
        png = svg_to_png(svg)
        captcha_text = solve_image_captcha(png)
        result = _http(
            f"{UMS_HOST}/api/users/verify-code",
            method="POST",
            headers=_ums_headers(),
            body={
                "email": email,
                "type": code_type,
                "channel": "email",
                "portal": PORTAL,
                "capcha": captcha_text,
            },
            timeout=20,
        )
        print(f"  [UMS] send code -> {result['status']} {result.get('text', '')[:200]}")
        if result["status"] < 400:
            return result

        code = (result.get("json") or {}).get("code")
        message = str((result.get("json") or {}).get("message") or result.get("text") or "")
        last_error = message
        # 已发送：直接继续收信
        if code == 1001055 or "不要重复" in message:
            return result
        # 图形验证码错误 / 需要图形验证码 → 重试
        if code in (1001045, 1001046) or "图形验证码" in message:
            continue
        raise RuntimeError(f"send verify-code failed: {result.get('text', '')[:300]}")
    raise RuntimeError(f"send verify-code failed after captcha retries: {last_error}")


def login_or_register_with_code(email: str, verify_code: str, is_register: int = 1) -> dict:
    """邮箱验证码登录/注册，返回 token 响应。"""
    result = _http(
        f"{UMS_HOST}/connect/oauth/tokens",
        method="POST",
        headers=_ums_headers(),
        body={
            "email": email,
            "verify_code": verify_code,
            "client_id": CLIENT_ID,
            "grant_type": "verify_code",
            "portal": PORTAL,
            "is_register": is_register,
        },
        timeout=20,
    )
    print(f"  [UMS] oauth tokens -> {result['status']}")
    data = result.get("json") or {}
    if result["status"] != 200 or not data.get("access_token"):
        raise RuntimeError(f"oauth tokens failed: {result.get('text', '')[:400]}")
    return data


def fetch_token_user(access_token: str) -> dict:
    result = _http(
        f"{UMS_HOST}/connect/oauth/tokens/user",
        headers=_ums_headers({"Authorization": f"Bearer {access_token}"}),
        timeout=20,
    )
    return result.get("json") or {"raw": result.get("text", "")[:300], "status": result["status"]}


def register_account(email: Optional[str] = None, max_wait: int = 90) -> dict:
    mail = GPTMailClient()
    if email:
        mail.email = email
        print(f"  [GPTMail] Reuse email: {email}")
    else:
        mail.generate_email(prefer_fallback=True)
    mail.build_session()

    print("\n[1/3] Sending verification code...")
    send_email_code(mail.email)

    print("\n[2/3] Waiting for code from GPTMail...")
    code = mail.wait_for_code(max_wait=max_wait, expected_length=6)

    print("\n[3/3] Registering with verify_code...")
    token_data = login_or_register_with_code(mail.email, code, is_register=1)
    user_info = {}
    try:
        user_info = fetch_token_user(token_data["access_token"])
    except Exception as exc:
        print(f"  [UMS] tokens/user skipped: {exc}")

    account = {
        "email": mail.email,
        "user_id": token_data.get("user_id") or token_data.get("user"),
        "is_new": token_data.get("is_new"),
        "access_token": token_data.get("access_token"),
        "refresh_token": token_data.get("refresh_token"),
        "access_token_expires_at": token_data.get("access_token_expires_at"),
        "refresh_token_expires_at": token_data.get("refresh_token_expires_at"),
        "user": user_info,
        "client_id": CLIENT_ID,
        "portal": PORTAL,
        "registered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return account


def main() -> int:
    parser = argparse.ArgumentParser(description="insMind email verify-code register test")
    parser.add_argument("--email", help="reuse an existing GPTMail address")
    parser.add_argument("--max-wait", type=int, default=90, help="seconds to wait for email code")
    parser.add_argument(
        "--out",
        default="insmind_account.json",
        help="where to write the registered account JSON",
    )
    args = parser.parse_args()

    print("=== insMind register test ===")
    account = register_account(email=args.email, max_wait=args.max_wait)
    out_path = Path(args.out)
    out_path.write_text(json.dumps(account, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== SUCCESS ===")
    print(f"email     : {account['email']}")
    print(f"user_id   : {account['user_id']}")
    print(f"is_new    : {account['is_new']}")
    print(f"token     : {(account.get('access_token') or '')[:40]}...")
    print(f"saved to  : {out_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
