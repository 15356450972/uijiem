"""认证模块。

QuickFrame 使用 Auth0 作为身份提供方（JWT iss=login.quickframe.com）。
登录页是「邮箱优先 + 验证码」流程（抓包确认），对应 Auth0 passwordless：

1. 邮箱验证码注册/登录（Auth0 passwordless email）—— QuickFrame 实际方式
   - 发码:  POST https://login.quickframe.com/passwordless/start
            body {client_id, connection:"email", email, send:"code"}
   - 换取:  POST https://login.quickframe.com/oauth/token
            body {grant_type:"...passwordless/otp", realm:"email", otp, username:email, ...}
   首次用某邮箱验证即自动创建账号，拿到的 access_token 直接作为后端 Bearer。

2. 邮箱+密码注册/登录（Auth0 Database Connection）—— 备用路径
   - 注册:  POST /dbconnections/signup
   - 登录:  POST /oauth/token  (grant_type=password-realm)

3. 直接使用浏览器里已登录的 access_token（最稳妥，跳过风控）。

另外提供 TempMail（mail.tm）辅助类，用于自动化注册时收取验证邮件，
对应之前抓包时实际使用的临时邮箱流程。
"""

import time
from typing import Any, Dict, Optional

import requests

from . import constants as C
from .exceptions import AuthError, APIError


class QuickFrameAuth:
    """封装 Auth0 注册/登录，产出可用于后端 API 的 access_token。"""

    def __init__(
        self,
        client_id: str = C.AUTH0_CLIENT_ID,
        domain: str = C.AUTH0_DOMAIN,
        audience: str = C.AUTH0_AUDIENCE,
        realm: str = C.AUTH0_REALM,
        session: Optional[requests.Session] = None,
    ) -> None:
        self.client_id = client_id
        self.domain = domain
        self.audience = audience
        self.realm = realm
        self.http = session or requests.Session()
        self.http.headers.update(
            {
                "User-Agent": C.USER_AGENT,
                "Origin": C.WEB_ORIGIN,
                "Referer": C.WEB_ORIGIN + "/",
                "Content-Type": "application/json",
            }
        )

    # ---- Auth0 passwordless（邮箱验证码）= QuickFrame 实际登录方式 ----
    def start_passwordless(self, email: str) -> Dict[str, Any]:
        """向邮箱发送登录验证码（Auth0 passwordless start）。

        对应登录页「Continue with email」按钮触发的请求。
        首次使用某邮箱验证通过后会自动创建账号。
        """
        url = f"https://{self.domain}/passwordless/start"
        body = {
            "client_id": self.client_id,
            "connection": "email",
            "email": email,
            "send": "code",
        }
        resp = self.http.post(url, json=body, timeout=30)
        if resp.status_code not in (200, 201):
            raise AuthError(
                f"发送验证码失败: HTTP {resp.status_code} {resp.text[:300]}"
            )
        try:
            return resp.json()
        except ValueError:
            return {"raw": resp.text}

    def verify_passwordless(self, email: str, code: str) -> str:
        """用邮箱验证码换取 access_token（Auth0 passwordless OTP grant）。"""
        url = f"https://{self.domain}/oauth/token"
        body = {
            "grant_type": "http://auth0.com/oauth/grant-type/passwordless/otp",
            "client_id": self.client_id,
            "connection": "email",
            "realm": "email",
            "username": email,
            "otp": code,
            "audience": self.audience,
            "scope": C.AUTH0_SCOPE,
        }
        resp = self.http.post(url, json=body, timeout=30)
        if resp.status_code != 200:
            raise AuthError(
                f"验证码校验失败: HTTP {resp.status_code} {resp.text[:300]}"
            )
        data = resp.json()
        token = data.get("access_token")
        if not token:
            raise AuthError(f"验证响应缺少 access_token: {data}")
        return token

    def register_with_email_code(
        self,
        email: str,
        temp_mail: Optional["TempMail"] = None,
        code_timeout: int = 120,
    ) -> str:
        """全自动：发码 -> 收码 -> 换 token。

        temp_mail 须为已 create_account 且地址与 email 一致的 TempMail 实例；
        若为 None，则需自行调用 start_passwordless 并人工传入验证码。
        """
        self.start_passwordless(email)
        if temp_mail is None:
            raise AuthError(
                "未提供 temp_mail，无法自动收码；"
                "请改用 start_passwordless + verify_passwordless 手动传入验证码。"
            )
        code = temp_mail.wait_for_code(timeout=code_timeout)
        return self.verify_passwordless(email, code)

    # ---- 注册（Database Connection 备用路径）----
    def signup(self, email: str, password: str) -> Dict[str, Any]:
        """通过 Auth0 Database Connection 创建账号。

        成功后通常仍需登录换取 token（部分租户注册即登录）。
        """
        url = f"https://{self.domain}/dbconnections/signup"
        body = {
            "client_id": self.client_id,
            "email": email,
            "password": password,
            "connection": self.realm,
        }
        resp = self.http.post(url, json=body, timeout=30)
        if resp.status_code not in (200, 201):
            raise AuthError(f"注册失败: HTTP {resp.status_code} {resp.text[:300]}")
        try:
            return resp.json()
        except ValueError:
            return {"raw": resp.text}

    # ---- 登录（密码模式）----
    def login(self, email: str, password: str) -> str:
        """密码模式换取 access_token。返回可直接用作 Bearer 的 JWT。"""
        url = f"https://{self.domain}/oauth/token"
        body = {
            "grant_type": "http://auth0.com/oauth/grant-type/password-realm",
            "client_id": self.client_id,
            "username": email,
            "password": password,
            "audience": self.audience,
            "scope": C.AUTH0_SCOPE,
            "realm": self.realm,
        }
        resp = self.http.post(url, json=body, timeout=30)
        if resp.status_code != 200:
            raise AuthError(f"登录失败: HTTP {resp.status_code} {resp.text[:300]}")
        data = resp.json()
        token = data.get("access_token")
        if not token:
            raise AuthError(f"登录响应缺少 access_token: {data}")
        return token

    def signup_and_login(self, email: str, password: str) -> str:
        """一步完成注册并登录，返回 access_token。"""
        try:
            self.signup(email, password)
        except AuthError as exc:
            # 账号已存在时直接尝试登录
            if "exists" not in str(exc).lower():
                raise
        return self.login(email, password)


class TempMail:
    """mail.tm 临时邮箱客户端，用于自动化注册时接收验证邮件。

    与抓包阶段实际使用的流程一致：建账号 -> 取 token -> 轮询收件箱。
    """

    BASE = "https://api.mail.tm"

    def __init__(self, session: Optional[requests.Session] = None) -> None:
        self.http = session or requests.Session()
        self.address: Optional[str] = None
        self.password: Optional[str] = None
        self.token: Optional[str] = None

    def _domain(self) -> str:
        resp = self.http.get(f"{self.BASE}/domains", timeout=30)
        resp.raise_for_status()
        members = resp.json().get("hydra:member", [])
        if not members:
            raise APIError("mail.tm 无可用域名", resp.status_code, resp.text)
        return members[0]["domain"]

    def create_account(
        self, username: Optional[str] = None, password: Optional[str] = None
    ) -> Dict[str, str]:
        """创建临时邮箱账号，返回 {address, password}。"""
        import random
        import string

        domain = self._domain()
        username = username or "qf" + "".join(
            random.choices(string.ascii_lowercase + string.digits, k=10)
        )
        password = password or "Qf" + "".join(
            random.choices(string.ascii_letters + string.digits, k=12)
        )
        address = f"{username}@{domain}"
        resp = self.http.post(
            f"{self.BASE}/accounts",
            json={"address": address, "password": password},
            timeout=30,
        )
        if resp.status_code not in (200, 201):
            raise APIError("创建临时邮箱失败", resp.status_code, resp.text)
        self.address, self.password = address, password
        self._get_token()
        return {"address": address, "password": password}

    def _get_token(self) -> str:
        resp = self.http.post(
            f"{self.BASE}/token",
            json={"address": self.address, "password": self.password},
            timeout=30,
        )
        resp.raise_for_status()
        self.token = resp.json()["token"]
        return self.token

    def _auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def wait_for_code(
        self,
        pattern: str = r"\b(\d{4,8})\b",
        timeout: int = 120,
        interval: int = 5,
    ) -> str:
        """轮询收件箱，用正则从最新邮件正文里提取验证码。"""
        import re

        deadline = time.time() + timeout
        while time.time() < deadline:
            resp = self.http.get(
                f"{self.BASE}/messages", headers=self._auth_headers(), timeout=30
            )
            resp.raise_for_status()
            messages = resp.json().get("hydra:member", [])
            for msg in messages:
                detail = self.http.get(
                    f"{self.BASE}/messages/{msg['id']}",
                    headers=self._auth_headers(),
                    timeout=30,
                )
                detail.raise_for_status()
                text = detail.json().get("text", "") or ""
                m = re.search(pattern, text)
                if m:
                    return m.group(1)
            time.sleep(interval)
        raise AuthError("等待验证码超时")
