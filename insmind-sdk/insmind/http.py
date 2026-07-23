"""通用 HTTP 客户端（可选 HTTP(S) 代理，供注册绕开 IP 限流）。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from . import constants as C

# 运行时代理，优先于环境变量；由 wizstar 桥接层按设置注入。
_proxy_url: str = ""


def set_proxy(url: Optional[str]) -> str:
    """设置全局代理 URL（如 http://user:pass@host:port）。空字符串表示关闭。"""
    global _proxy_url
    _proxy_url = str(url or "").strip()
    return _proxy_url


def get_proxy() -> str:
    """优先级：显式 set_proxy > INSMIND_PROXY > HTTPS_PROXY/HTTP_PROXY。"""
    if _proxy_url:
        return _proxy_url
    for key in ("INSMIND_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    return ""


def build_proxy_url(
    host: str,
    port: int | str = 7878,
    user: str = "",
    password: str = "",
) -> str:
    host = str(host or "").strip()
    if not host:
        return ""
    try:
        port_num = int(port or 7878)
    except (TypeError, ValueError):
        port_num = 7878
    user = str(user or "").strip()
    password = str(password or "")
    if user:
        auth = (
            f"{urllib.parse.quote(user, safe='')}"
            f":{urllib.parse.quote(password, safe='')}@"
        )
    else:
        auth = ""
    return f"http://{auth}{host}:{port_num}"


def _build_opener() -> urllib.request.OpenerDirector:
    proxy = get_proxy()
    if not proxy:
        return urllib.request.build_opener()
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    )


def request(
    url: str,
    *,
    method: str = "GET",
    headers: Optional[dict[str, str]] = None,
    body: Any = None,
    form: bool = False,
    raw_body: Optional[bytes] = None,
    timeout: int = 60,
) -> dict:
    req_headers = {"User-Agent": C.USER_AGENT, **(headers or {})}
    data: Optional[bytes] = None
    if raw_body is not None:
        data = raw_body
    elif body is not None:
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

    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    opener = _build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read()
            text = raw.decode("utf-8", "ignore")
            try:
                set_cookies = resp.headers.get_all("Set-Cookie") or []
            except Exception:
                sc = resp.headers.get("Set-Cookie")
                set_cookies = [sc] if sc else []
            cookies = [item.split(";", 1)[0] for item in set_cookies if item]
            try:
                payload = json.loads(text) if text else None
            except ValueError:
                payload = None
            return {
                "status": resp.status,
                "text": text,
                "raw": raw,
                "json": payload,
                "cookies": cookies,
                "headers": dict(resp.headers),
            }
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        text = raw.decode("utf-8", "ignore")
        try:
            payload = json.loads(text) if text else None
        except ValueError:
            payload = None
        return {
            "status": exc.code,
            "text": text,
            "raw": raw,
            "json": payload,
            "cookies": [],
            "headers": dict(exc.headers or {}),
            "error": True,
        }


class ApiError(RuntimeError):
    def __init__(self, message: str, status: int = 0, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body