"""Wizstar 主客户端：邮箱登录 + 用户信息 + 上传 + 视频生成 + 轮询"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

import requests

from .enums import Model, Ratio, Resolution, TaskType


BASE_URL = "https://wizstar.com"

DEFAULT_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://wizstar.com",
    "Referer": "https://wizstar.com/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
    ),
    "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}


@dataclass
class WizstarCredentials:
    """浏览器授权后复用的 Wizstar 会话凭证。"""

    email: str
    password: str = ""
    uid: int = 0
    display_name: str = ""
    osduss: str = ""
    refresh_token: str = ""
    pass_os_refresh_tk: str = ""
    portrait_url: str = ""
    auth_token: str = ""
    cookies: dict = field(default_factory=dict)
    raw: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "email": self.email,
            "password": self.password,
            "uid": self.uid,
            "displayName": self.display_name,
            "osduss": self.osduss,
            "refreshToken": self.refresh_token,
            "passOsRefreshTk": self.pass_os_refresh_tk,
            "portraitURL": self.portrait_url,
            "authToken": self.auth_token,
            "cookies": self.cookies,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "WizstarCredentials":
        return cls(
            email=d.get("email", ""),
            password=d.get("password", ""),
            uid=d.get("uid", 0),
            display_name=d.get("displayName", ""),
            osduss=d.get("osduss", ""),
            refresh_token=d.get("refreshToken", ""),
            pass_os_refresh_tk=d.get("passOsRefreshTk", ""),
            portrait_url=d.get("portraitURL", ""),
            auth_token=d.get("authToken", ""),
            cookies=d.get("cookies") or {},
        )


# reCAPTCHA v2 invisible 配置：服务端要求验证时的 sitekey / 校验页面。
# 来自真实抓包：api2/clr?k=6LdPwTMtAAAAAKKEpYw0P1AAkpyEapV1LOoIP4zV。
# 服务端如更换 sitekey，可通过 WizstarClient(... recaptcha_sitekey=...) 注入。
RECAPTCHA_SITEKEY_DEFAULT = "6LdPwTMtAAAAAKKEpYw0P1AAkpyEapV1LOoIP4zV"
RECAPTCHA_PAGE_URL_DEFAULT = "https://wizstar.com/tools/generate_video"

# 服务端在创建任务前要求人机验证时的错误码。
ERRNO_RECAPTCHA_REQUIRED = 10100090


class WizstarClient:
    """所有请求复用 requests.Session，cookie 与浏览器授权令牌保持一致。"""

    def __init__(
        self,
        credentials: WizstarCredentials | None = None,
        *,
        yescap_key: str | None = None,
        recaptcha_sitekey: str | None = None,
        recaptcha_page_url: str | None = None,
    ):
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self.creds = credentials
        # yescap key 不在 import 期解析；为 None 时调用前懒加载 quickframe_bridge。
        self._yescap_key = yescap_key
        self.recaptcha_sitekey = recaptcha_sitekey or RECAPTCHA_SITEKEY_DEFAULT
        self.recaptcha_page_url = recaptcha_page_url or RECAPTCHA_PAGE_URL_DEFAULT
        if credentials:
            self._apply_credentials(credentials)

    def _resolve_yescap_key(self) -> str:
        """惰性解析 yescap key：构造器注入 > quickframe_bridge.get_yescap_key > 空。"""
        if self._yescap_key:
            return self._yescap_key
        try:
            from .quickframe_bridge import get_yescap_key
            return get_yescap_key()
        except Exception:
            return ""

    def _pass_recaptcha_v2(self) -> None:
        """触发一次 reCAPTCHA v2 invisible 解码，并把 token 提交到站点 verify 接口。

        - 复用 self.session 让 cookie 与会话令牌自动带上。
        - verify 失败抛 RuntimeError，由调用方决定是否回失败给上层。
        - errcode/errno 透传短文本，不打印 token、cookie、邮箱。
        """
        from .yescaptcha import solve_recaptcha_v2, YesCaptchaError

        key = self._resolve_yescap_key()
        if not key:
            raise RuntimeError("create task failed: yescaptcha key not configured")

        try:
            token = solve_recaptcha_v2(
                client_key=key,
                website_url=self.recaptcha_page_url,
                website_key=self.recaptcha_sitekey,
                is_invisible=True,
            )
        except YesCaptchaError as e:
            raise RuntimeError(f"create task failed: yescaptcha solve failed: {e}")

        verify_resp = self.session.post(
            f"{BASE_URL}/wizstar/gcode/verify",
            json={"recaptcha_response": token},
            timeout=30,
        ).json()
        if verify_resp.get("errno") != 0:
            raise RuntimeError(
                f"create task failed: gcode verify errno={verify_resp.get('errno')} "
                f"msg={verify_resp.get('message')}"
            )

    def _apply_credentials(self, creds: WizstarCredentials) -> None:
        for name, value in (creds.cookies or {}).items():
            if value not in (None, ""):
                self.session.cookies.set(str(name), str(value), domain="wizstar.com", path="/")
        if creds.osduss:
            self.session.cookies.set("osduss", creds.osduss, domain="wizstar.com", path="/")
        if creds.pass_os_refresh_tk:
            self.session.cookies.set(
                "passOsRefreshTk", creds.pass_os_refresh_tk, domain="wizstar.com", path="/"
            )
        auth_token = creds.auth_token or (creds.refresh_token if not creds.osduss else "")
        if auth_token:
            self.session.headers["Authorization"] = (
                auth_token if auth_token.startswith("Bearer ") else f"Bearer {auth_token}"
            )

    # ---------- 用户信息 / 积分 ----------

    def user_info(self) -> dict:
        return self.session.get(f"{BASE_URL}/wizstar/user/info", timeout=30).json()

    def points_balance(self) -> dict:
        return self.session.get(f"{BASE_URL}/wizstar/points/balance", timeout=30).json()

    def estimate_points(self, task_type: int, **task_params) -> dict:
        body = {"task_type": task_type, **task_params}
        return self.session.post(
            f"{BASE_URL}/wizstar/tools/common/point", json=body, timeout=30
        ).json()

    # ---------- 能力查询（在线） ----------

    def get_tags(self, task_type: int) -> dict:
        """查询某个任务类型支持的模型/比例/分辨率/时长/数量等动态配置。"""
        return self.session.get(
            f"{BASE_URL}/wizstar/tools/common/tags",
            params={"task_type": task_type},
            timeout=30,
        ).json()

    def get_all_tags(self, task_types: list[int] | None = None) -> dict[int, dict]:
        """批量查询多个任务类型的能力清单。"""
        if task_types is None:
            task_types = [1, 2, 3, 4, 5, 6, 7, 8]
        return {tt: self.get_tags(tt) for tt in task_types}

    def upload_check(self, file_url: str, task_type: int, content_type: str = "image/jpeg") -> dict:
        """上传后调用此接口让服务端校验文件是否可用于指定任务类型。"""
        return self.session.get(
            f"{BASE_URL}/wizstar/tools/common/upload/check",
            params={
                "task_type": task_type,
                "file_url": file_url,
                "source": 0,
                "content_type": content_type,
            },
            timeout=30,
        ).json()

    # ---------- 图片上传（init -> S3 PUT -> complete） ----------

    def upload_image(self, file_path: str, scene: str = "tools") -> str:
        with open(file_path, "rb") as f:
            data = f.read()
        ext = file_path.rsplit(".", 1)[-1].lower()
        content_type = {
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "png": "image/png",
            "webp": "image/webp",
        }.get(ext, "image/jpeg")
        file_name = file_path.replace("\\", "/").rsplit("/", 1)[-1]

        init_resp = self.session.post(
            f"{BASE_URL}/wizstar/v1/common-uploads/init",
            json={
                "scene": scene,
                "file_name": file_name,
                "file_size": len(data),
                "content_type": content_type,
            },
            timeout=30,
        ).json()
        if init_resp.get("errno") != 0:
            raise RuntimeError(f"upload init failed: {init_resp}")
        key = init_resp["data"]["key"]
        presign = init_resp["data"]["presign_url"]

        put_resp = requests.put(
            presign, data=data, headers={"Content-Type": content_type}, timeout=120
        )
        if not put_resp.ok:
            raise RuntimeError(f"S3 PUT failed: {put_resp.status_code} {put_resp.text[:200]}")

        comp_resp = self.session.post(
            f"{BASE_URL}/wizstar/v1/common-uploads/complete",
            json={
                "key": key,
                "multipart_upload_id": "",
                "parts": [],
                "content_type": content_type,
                "need_risk_detect": True,
                "scene": scene,
            },
            timeout=30,
        ).json()
        if comp_resp.get("errno") != 0:
            raise RuntimeError(f"upload complete failed: {comp_resp}")
        if comp_resp["data"].get("risk_result") != "PASS":
            raise RuntimeError(f"image risk check failed: {comp_resp['data']}")
        return comp_resp["data"]["url"]

    # ---------- 视频生成 ----------

    def create_task(
        self,
        task_type: int,
        prompt: str = "",
        *,
        model: str = Model.SEEDANCE_2_0,
        video_ratio: str = Ratio.PORTRAIT,
        video_resolution: str = Resolution.P720,
        video_duration: int = 5,
        video_num: int = 1,
        params: dict | None = None,
        extra: dict | None = None,
    ) -> dict:
        """通用任务创建接口，覆盖文生视频/图生视频/视频参考等所有场景。

        params 为任务专属字段（pic_url、video_url 等），SDK 会自动按服务端约定
        编码成 JSON 字符串放进 params 字段。
        extra 用于附加任意服务端字段（subtitle_on 等），会覆盖默认值。
        """
        body = {
            "task_type": task_type,
            "params": json.dumps(params or {}),
            "video_duration": video_duration,
            "video_ratio": video_ratio,
            "video_resolution": video_resolution,
            "video_num": video_num,
            "model": model,
            "prompt": prompt,
        }
        if extra:
            body.update(extra)

        # 第一次创建可能触发 reCAPTCHA v2 invisible 风控（errno=10100090）。
        # 抓包证明：通过 yescap 解码 -> POST /wizstar/gcode/verify -> 用同 body 重试，
        # 即可成功创建任务。失败时保留原"create task failed"契约。
        result = self.session.post(
            f"{BASE_URL}/wizstar/tools/common/create", json=body, timeout=30
        ).json()
        if result.get("errno") == ERRNO_RECAPTCHA_REQUIRED:
            self._pass_recaptcha_v2()
            result = self.session.post(
                f"{BASE_URL}/wizstar/tools/common/create", json=body, timeout=30
            ).json()
        if result.get("errno") != 0:
            raise RuntimeError(f"create task failed: {result}")
        return result["data"]["tasks"][0]

    def create_text_to_video(
        self,
        prompt: str,
        *,
        model: str = Model.SEEDANCE_2_0,
        video_ratio: str = Ratio.PORTRAIT,
        video_resolution: str = Resolution.P720,
        video_duration: int = 5,
        video_num: int = 1,
    ) -> dict:
        """文生视频。"""
        return self.create_task(
            TaskType.TEXT_TO_VIDEO,
            prompt=prompt,
            model=model,
            video_ratio=video_ratio,
            video_resolution=video_resolution,
            video_duration=video_duration,
            video_num=video_num,
            params={},
        )

    def create_image_to_video(
        self,
        pic_url: str,
        prompt: str,
        *,
        model: str = Model.SEEDANCE_2_0,
        video_ratio: str = Ratio.PORTRAIT,
        video_resolution: str = Resolution.P720,
        video_duration: int = 5,
        video_num: int = 1,
    ) -> dict:
        """图生视频（task_type=2）。"""
        return self.create_task(
            TaskType.IMAGE_TO_VIDEO,
            prompt=prompt,
            model=model,
            video_ratio=video_ratio,
            video_resolution=video_resolution,
            video_duration=video_duration,
            video_num=video_num,
            params={"pic_url": pic_url},
        )

    def create_video_reference(
        self,
        video_url: str,
        prompt: str,
        *,
        model: str = Model.KLING,
        video_ratio: str = Ratio.PORTRAIT,
        video_resolution: str = Resolution.P720,
        video_duration: int = 5,
        video_num: int = 1,
    ) -> dict:
        """视频参考（task_type=3，目前仅 kling）。"""
        return self.create_task(
            TaskType.VIDEO_REFERENCE,
            prompt=prompt,
            model=model,
            video_ratio=video_ratio,
            video_resolution=video_resolution,
            video_duration=video_duration,
            video_num=video_num,
            params={"video_url": video_url},
        )

    def get_task_detail(self, task_id: str) -> dict:
        return self.session.post(
            f"{BASE_URL}/wizstar/tools/common/detail",
            json={"task_ids": [task_id]},
            timeout=30,
        ).json()

    def poll_task(
        self, task_id: str, *, max_wait: int = 600, interval: int = 10
    ) -> dict:
        deadline = time.time() + max_wait
        while time.time() < deadline:
            resp = self.get_task_detail(task_id)
            tasks = resp.get("data", {}).get("list", [])
            if not tasks:
                time.sleep(interval)
                continue
            vr = (tasks[0].get("video_result") or [{}])[0]
            status = vr.get("status")
            queue_pos = vr.get("queue_position")
            elapsed = int(max_wait - (deadline - time.time()))
            print(
                f"  [poll] {elapsed}s status={status} "
                f"queue_pos={queue_pos} has_video_url={bool(vr.get('video_url'))}"
            )
            if vr.get("video_url"):
                return vr
            if status == 4 or vr.get("fail_reason"):
                raise RuntimeError(f"task failed: {vr}")
            time.sleep(interval)
        raise TimeoutError(f"polling task {task_id} timed out after {max_wait}s")
