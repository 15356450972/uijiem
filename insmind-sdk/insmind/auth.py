"""UMS 邮箱验证码注册 / 登录。"""

from __future__ import annotations

import time
import urllib.parse
from typing import Optional

from . import constants as C
from .captcha import fetch_capcha_svg, solve_image_captcha, svg_to_png
from .gptmail import GPTMailClient
from .http import ApiError, request


def _ums_headers(extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": C.UMS_HOST,
        "Referer": f"{C.UMS_HOST}/cgi-bin?biz_code={C.BIZ_CODE}&appid={C.CLIENT_ID}",
        "x-biz-code": C.BIZ_CODE,
        "x-region-id": C.REGION_ID,
        "x-endpoint": C.ENDPOINT,
        "x-device-name": urllib.parse.quote("Mac OS Chrome"),
    }
    if extra:
        headers.update(extra)
    return headers


def send_email_code(email: str, code_type: str = "login", *, max_capcha_retries: int = 1) -> dict:
    """发邮箱验证码。

    默认每个邮箱只打一次图形验证码（YesCaptcha）。
    仅当 UMS 明确返回「图形验证码错误」(1001045/1001046) 且 max_capcha_retries>1 时才重打。
    """
    last_error = ""
    retries = max(1, int(max_capcha_retries or 1))
    for attempt in range(1, retries + 1):
        t0 = time.time()
        svg = fetch_capcha_svg(email)
        captcha_text = solve_image_captcha(svg_to_png(svg))
        ocr_s = time.time() - t0
        result = request(
            f"{C.UMS_HOST}/api/users/verify-code",
            method="POST",
            headers=_ums_headers(),
            body={
                "email": email,
                "type": code_type,
                "channel": "email",
                "portal": C.PORTAL,
                "capcha": captcha_text,
            },
            timeout=20,
        )
        code = (result.get("json") or {}).get("code")
        message = str((result.get("json") or {}).get("message") or result.get("text") or "")
        last_error = message
        if result["status"] < 400:
            print(
                f"[insmind-auth] captcha ok email={email} attempt={attempt}/{retries} "
                f"ocr={ocr_s:.1f}s text={captcha_text!r}"
            )
            return result
        if code == 1001055 or "不要重复" in message:
            # 已发过码，视为成功，不重复打码
            print(
                f"[insmind-auth] captcha skip-dup email={email} attempt={attempt}/{retries} "
                f"ocr={ocr_s:.1f}s msg={message[:80]!r}"
            )
            return result
        is_captcha_err = code in (1001045, 1001046) or "图形验证码" in message
        print(
            f"[insmind-auth] captcha fail email={email} attempt={attempt}/{retries} "
            f"ocr={ocr_s:.1f}s text={captcha_text!r} code={code} msg={message[:120]!r}"
        )
        if is_captcha_err and attempt < retries:
            continue
        raise ApiError(
            f"send verify-code failed: {result.get('text', '')[:300]}",
            result["status"],
            result.get("json"),
        )
    raise ApiError(f"send verify-code failed after captcha retries: {last_error}")


def exchange_verify_code(email: str, verify_code: str, *, is_register: int = 1) -> dict:
    result = request(
        f"{C.UMS_HOST}/connect/oauth/tokens",
        method="POST",
        headers=_ums_headers(),
        body={
            "email": email,
            "verify_code": verify_code,
            "client_id": C.CLIENT_ID,
            "grant_type": "verify_code",
            "portal": C.PORTAL,
            "is_register": is_register,
        },
        timeout=20,
    )
    data = result.get("json") or {}
    if result["status"] != 200 or not data.get("access_token"):
        raise ApiError(f"oauth tokens failed: {result.get('text', '')[:400]}", result["status"], data)
    return data


def fetch_token_user(access_token: str) -> dict:
    result = request(
        f"{C.UMS_HOST}/connect/oauth/tokens/user",
        headers=_ums_headers({"Authorization": f"Bearer {access_token}"}),
        timeout=20,
    )
    return result.get("json") or {"raw": result.get("text", "")[:300], "status": result["status"]}


def register_account(
    email: Optional[str] = None,
    *,
    max_wait: int = 90,
    bind_tenant: bool = True,
) -> dict:
    """邮箱验证码注册，返回含 access_token 的账号信息。

    bind_tenant=True 时会创建个人组织并调用 SSO org-bind（否则业务 API 会 10010413）。
    """
    from .tenant import ensure_tenant

    mail = GPTMailClient()
    if email:
        mail.email = email
    else:
        mail.generate_email(prefer_fallback=True)
    mail.build_session()
    send_email_code(mail.email)
    code = mail.wait_for_code(max_wait=max_wait, expected_length=6)
    token_data = exchange_verify_code(mail.email, code, is_register=1)
    access_token = token_data.get("access_token")
    user_info = {}
    try:
        user_info = fetch_token_user(access_token)
    except Exception:
        pass
    result = {
        "email": mail.email,
        "user_id": token_data.get("user_id") or token_data.get("user"),
        "is_new": token_data.get("is_new"),
        "access_token": access_token,
        "refresh_token": token_data.get("refresh_token"),
        "access_token_expires_at": token_data.get("access_token_expires_at"),
        "refresh_token_expires_at": token_data.get("refresh_token_expires_at"),
        "user": user_info,
        "client_id": C.CLIENT_ID,
        "registered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if bind_tenant and access_token:
        tenant = ensure_tenant(access_token)
        result["org_id"] = tenant.get("org_id")
        result["cookie"] = tenant.get("cookie")
        result["tenant"] = tenant
    return result
