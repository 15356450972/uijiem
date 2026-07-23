"""个人租户创建与绑定（解决 10010413 未绑定租户）。"""

from __future__ import annotations

import time
from typing import Any, Optional

from . import constants as C
from .http import ApiError, request


def list_orgs(access_token: str) -> list[dict]:
    resp = request(
        f"{C.WEB_ORIGIN}/api/structure/user/orgs",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Origin": C.WEB_ORIGIN,
            "Referer": f"{C.WEB_ORIGIN}/",
            "x-channel-id": C.CHANNEL_ID,
            "x-product-type": C.PRODUCT_TYPE,
        },
        timeout=30,
    )
    data = resp.get("json")
    return data if isinstance(data, list) else []


def wait_orgs(access_token: str, *, retries: int = 8, interval: float = 0.8) -> list[dict]:
    last: list[dict] = []
    for _ in range(retries):
        last = list_orgs(access_token)
        if last:
            return last
        time.sleep(interval)
    return last


def create_free_personal_org(access_token: str) -> dict:
    """创建免费个人组织。

    注意：服务端常返回 12020028「初始化失败」，但组织可能已异步创建成功，
    调用方应随后 wait_orgs / list_orgs。
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Origin": C.WEB_ORIGIN,
        "Referer": f"{C.WEB_ORIGIN}/creation",
        "x-channel-id": C.CHANNEL_ID,
        "x-product-type": C.PRODUCT_TYPE,
    }
    # 空 body 最稳；带 module_codes 反而容易套餐冲突
    resp = request(
        f"{C.WEB_ORIGIN}/api/structure/company/personal/free",
        method="POST",
        headers=headers,
        body={},
        timeout=30,
    )
    code = str((resp.get("json") or {}).get("code") or "")
    # 12020030 已存在；12020028 初始化失败但常已创建
    if resp["status"] >= 400 and code not in {"12020030", "12020028"}:
        raise ApiError(
            f"create personal org failed: {resp.get('text', '')[:300]}",
            resp["status"],
            resp.get("json"),
        )
    return resp.get("json") or {"status": resp["status"], "code": code}

def switch_org(access_token: str, org_id: str, *, product_type: str = C.PRODUCT_TYPE) -> dict:
    resp = request(
        f"{C.WEB_ORIGIN}/actions/switch-org",
        method="POST",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Origin": C.WEB_ORIGIN,
            "Referer": f"{C.WEB_ORIGIN}/creation",
            "x-channel-id": C.CHANNEL_ID,
            "x-product-type": product_type,
        },
        body={
            "org_id": str(org_id),
            "product_type": product_type,
            "personal_user": "1",
        },
        timeout=30,
    )
    if resp["status"] >= 400:
        raise ApiError(
            f"switch-org failed: {resp.get('text', '')[:300]}",
            resp["status"],
            resp.get("json"),
        )
    return {"status": resp["status"], "cookies": resp.get("cookies") or []}


def bind_org_token(access_token: str, org_id: str, *, channel_id: str = C.CHANNEL_ID) -> dict:
    """POST sso /api/token/org-bind —— 真正把 org 绑到 access_token。"""
    resp = request(
        f"{C.SSO_HOST}/api/token/org-bind",
        method="POST",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Origin": C.WEB_ORIGIN,
            "Referer": f"{C.WEB_ORIGIN}/",
            "x-channel-id": str(channel_id),
            "X-Channel-Id": str(channel_id),
            "x-product-type": C.PRODUCT_TYPE,
        },
        body={
            "org_id": str(org_id),
            "access_token": access_token,
            "channel_id": str(channel_id),
        },
        timeout=30,
    )
    if resp["status"] >= 400:
        raise ApiError(
            f"org-bind failed: {resp.get('text', '')[:300]}",
            resp["status"],
            resp.get("json"),
        )
    return {"status": resp["status"], "json": resp.get("json"), "cookies": resp.get("cookies") or []}


def ensure_tenant(access_token: str, *, channel_id: str = C.CHANNEL_ID) -> dict[str, Any]:
    """确保账号已创建个人组织并完成 org-bind，返回 org 信息。"""
    orgs = list_orgs(access_token)
    if not orgs:
        create_free_personal_org(access_token)
        orgs = wait_orgs(access_token)
    if not orgs:
        raise ApiError("no personal org after create")
    company = (orgs[0].get("company") or {})
    org_id = str(company.get("id") or orgs[0].get("org_id") or "")
    if not org_id:
        raise ApiError(f"org list missing id: {orgs[0]}")
    switch = switch_org(access_token, org_id)
    bind = bind_org_token(access_token, org_id, channel_id=channel_id)
    cookie_parts = []
    for item in (switch.get("cookies") or []) + (bind.get("cookies") or []):
        if "=" in item:
            cookie_parts.append(item)
    # always include org cookie for subsequent requests
    cookie_parts.append(f"token.org_id.prod={org_id}")
    cookie_parts.append("has_org.prod=1")
    cookie_parts.append("personal-user.prod=1")
    cookie_parts.append(f"product_type.prod={C.PRODUCT_TYPE}")
    # dedupe by name
    seen: dict[str, str] = {}
    for part in cookie_parts:
        name, _, val = part.partition("=")
        seen[name] = f"{name}={val}"
    return {
        "org_id": org_id,
        "company": company,
        "product": orgs[0].get("product"),
        "cookie": "; ".join(seen.values()),
    }
