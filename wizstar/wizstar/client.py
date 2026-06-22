"""Wizstar 主客户端：注册 + 用户信息 + 上传 + 视频生成 + 轮询"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

import requests

from .crypto import rsa_encrypt
from .enums import Model, Ratio, Resolution, TaskType
from .mailbox import OutlookMailbox


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
    """注册成功后服务端返回的凭证。osduss + passOsRefreshTk 是真正的认证 cookie"""

    email: str
    password: str
    uid: int = 0
    display_name: str = ""
    osduss: str = ""
    refresh_token: str = ""
    pass_os_refresh_tk: str = ""
    portrait_url: str = ""
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
        )


class WizstarClient:
    """所有请求复用 requests.Session，cookie 自动维持登录态"""

    def __init__(self, credentials: WizstarCredentials | None = None):
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self.creds = credentials
        if credentials:
            self._apply_credentials(credentials)

    def _apply_credentials(self, creds: WizstarCredentials) -> None:
        if creds.osduss:
            self.session.cookies.set("osduss", creds.osduss, domain="wizstar.com", path="/")
        if creds.pass_os_refresh_tk:
            self.session.cookies.set(
                "passOsRefreshTk", creds.pass_os_refresh_tk, domain="wizstar.com", path="/"
            )

    # ---------- 注册 ----------

    def send_register_code(self, email: str) -> dict:
        ts = int(time.time())
        url = f"{BASE_URL}/passport/email/send_code?ts={ts}&tpl=wizstar&lang=en-US&client=pc"
        payload = {
            "tpl": "wizstar",
            "client": "pc",
            "lang": "en-US",
            "scene": "email_register_send_code",
            "email": rsa_encrypt(email),
            "ext": json.dumps({"actionName": "email_register_send_code_send"}),
        }
        return self.session.post(url, json=payload, timeout=30).json()

    def register(self, email: str, password: str, verify_code: str) -> WizstarCredentials:
        ts = int(time.time())
        url = f"{BASE_URL}/passport/reg/email?ts={ts}&tpl=wizstar&lang=en-US&client=pc"
        payload = {
            "tpl": "wizstar",
            "client": "pc",
            "lang": "en-US",
            "email": rsa_encrypt(email),
            "password": rsa_encrypt(password),
            "verify_code": verify_code,
        }
        resp = self.session.post(url, json=payload, timeout=30)
        result = resp.json()
        if result.get("errno") != 0:
            raise RuntimeError(f"register failed: {result}")
        data = result.get("data", {})

        cookies = {c.name: c.value for c in resp.cookies}
        creds = WizstarCredentials(
            email=email,
            password=password,
            uid=data.get("uid", 0),
            display_name=data.get("displayName", ""),
            osduss=data.get("osduss") or cookies.get("osduss", ""),
            refresh_token=data.get("refreshToken", ""),
            pass_os_refresh_tk=cookies.get("passOsRefreshTk", "") or data.get("refreshToken", ""),
            portrait_url=data.get("portraitURL", ""),
            raw=data,
        )
        self.creds = creds
        self._apply_credentials(creds)
        return creds

    def register_auto(self, mailbox: OutlookMailbox, password: str) -> WizstarCredentials:
        print(f"[register] sending code to {mailbox.email}...")
        result = self.send_register_code(mailbox.email)
        if result.get("errno") != 0:
            raise RuntimeError(f"send_code failed: {result}")
        print("[register] code sent, waiting for email arrival...")
        time.sleep(8)
        code = mailbox.fetch_verification_code(max_wait=90)
        print(f"[register] got verification code: {code}")
        creds = self.register(mailbox.email, password, code)
        print(f"[register] success! uid={creds.uid}, displayName={creds.display_name}")
        self._warm_up_session()
        return creds

    def _warm_up_session(self) -> None:
        """新账号注册后必须先调一次 user/info，服务端才会下发 WIZSTARID 会话 cookie。
        没这步的话 upload/init、tools/create 等接口会报 user not exists。"""
        try:
            info = self.user_info()
            if info.get("errno") == 0:
                names = [c.name for c in self.session.cookies]
                print(f"[register] session warmed up (cookies: {names})")
        except Exception as e:
            print(f"[register] warm-up failed (will retry on first call): {e}")

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
