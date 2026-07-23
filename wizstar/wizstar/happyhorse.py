"""HappyHorse 视频生成 API 客户端 — 渠道十一

通过 Google OAuth 登录 https://www.happyhorse.com 后，
使用 accessToken 调用 api-gateway.aorizon.com / gw.happyhorse.com。

完整流程：
  1. happyhorse-google-login 获取 accessToken (+ device_id)
  2. POST /api/v1/media/sts-token 获取 OSS STS
  3. PUT 图片到 cn-delta-media-asset OSS
  4. POST /api/v1/media/asset 登记素材
  5. POST /api/v2/projects 创建项目
  6. POST /api/v2/tasks 提交 R2V 任务
  7. GET gw.happyhorse.com/api/task/list?projectId=... 轮询至 SUCCEEDED
"""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from email.utils import formatdate
from pathlib import Path
from urllib.parse import quote

import requests

from .app_paths import get_wizstar_data_dir

API_GATEWAY = "https://api-gateway.aorizon.com"
GW_BASE = "https://gw.happyhorse.com"
HH_ORIGIN = "https://www.happyhorse.com"

_DEFAULT_LOGIN_MODULE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "happyhorse-google-login",
)
LOGIN_MODULE_DIR = os.environ.get("HAPPYHORSE_LOGIN_MODULE_DIR", "").strip() or _DEFAULT_LOGIN_MODULE_DIR
NODE_BIN = (
    os.environ.get("HAPPYHORSE_NODE_BIN", "").strip()
    or os.environ.get("FRAMIA_NODE_BIN", "").strip()
    or os.environ.get("DOLA_NODE_BIN", "").strip()
    or "node"
)
LOGIN_TIMEOUT_SECONDS = int(os.environ.get("HAPPYHORSE_LOGIN_TIMEOUT_SECONDS", "360") or "360")
CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "happyhorse_config.json")

DEFAULT_MODELS = [
    {"id": "r2v-1.5", "name": "HappyHorse R2V 1.5", "cost_per_sec": 5},
]
DEFAULT_RATIOS = ["16:9", "9:16", "1:1"]
DEFAULT_MODEL_VERSION = "1.5"  # 官网 UI 显示为 HH 1.1，API 仍为 1.5
DEFAULT_RESOLUTION = "720p"
DEFAULT_DURATION = 3
MIN_DURATION = 3
MAX_DURATION = 15
ALLOWED_RESOLUTIONS = ("720p", "1080p")


def normalize_generation_params(
    *,
    aspect_ratio: str = "16:9",
    duration_s: int | float = DEFAULT_DURATION,
    resolution: str = DEFAULT_RESOLUTION,
) -> dict:
    """对齐官网：时长 3–15s，分辨率仅 720p/1080p，比例 16:9 / 9:16 / 1:1。"""
    ratio = str(aspect_ratio or "16:9").strip()
    if ratio not in DEFAULT_RATIOS:
        ratio = "16:9"
    try:
        duration = int(round(float(duration_s or DEFAULT_DURATION)))
    except (TypeError, ValueError):
        duration = DEFAULT_DURATION
    duration = max(MIN_DURATION, min(MAX_DURATION, duration))
    res = str(resolution or DEFAULT_RESOLUTION).strip().lower()
    if res in ("720", "720p"):
        res = "720p"
    elif res in ("1080", "1080p"):
        res = "1080p"
    else:
        # 例如从 Tensor.Art 残留的 480p，官网不支持
        res = DEFAULT_RESOLUTION
    return {
        "aspect_ratio": ratio,
        "duration_s": duration,
        "resolution": res,
    }


class HappyHorseError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _parse_json(resp: requests.Response) -> dict:
    try:
        return resp.json()
    except ValueError:
        return {"_raw": resp.text}


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_config(**kwargs) -> dict:
    config = _load_config()
    for key, value in kwargs.items():
        if value is not None:
            config[key] = value
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


class HappyHorseClient:
    """HappyHorse / aorizon API 客户端。"""

    def __init__(
        self,
        access_token: str,
        cookie: str = "",
        user_agent: str = "",
        device_id: str = "",
        bx_umidtoken: str = "",
        timeout: int = 60,
    ):
        self.access_token = (access_token or "").strip()
        if not self.access_token:
            raise HappyHorseError("缺少 HappyHorse accessToken")
        self.cookie = (cookie or "").strip()
        self.user_agent = (user_agent or "").strip() or (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
        )
        self.device_id = (device_id or "").strip() or "unknown"
        self.bx_umidtoken = (bx_umidtoken or "").strip()
        self.timeout = timeout

    def _headers(self, *, json_body: bool = True) -> dict:
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Accept": "application/json, text/plain, */*",
            "User-Agent": self.user_agent,
            "Origin": HH_ORIGIN,
            "Referer": f"{HH_ORIGIN}/creation/generation",
            "x-app-id": "aorizon",
            "x-language": "en-US",
            "x-consent-ad-user-data": "granted",
            "x-consent-ad-personalization": "granted",
        }
        if json_body:
            headers["Content-Type"] = "application/json"
        if self.cookie:
            headers["Cookie"] = self.cookie
        return headers

    def _request(self, method: str, url: str, **kwargs) -> dict:
        headers = kwargs.pop("headers", None) or self._headers()
        try:
            resp = requests.request(method, url, headers=headers, timeout=self.timeout, **kwargs)
        except requests.RequestException as e:
            raise HappyHorseError(f"请求失败: {e}") from e
        data = _parse_json(resp)
        if resp.status_code >= 400:
            msg = data.get("errorMsg") or data.get("message") or data.get("_raw") or resp.text
            raise HappyHorseError(f"HTTP {resp.status_code}: {msg}", status_code=resp.status_code)
        if data.get("success") is False:
            raise HappyHorseError(data.get("errorMsg") or "接口返回失败")
        return data

    def test_connection(self) -> dict:
        data = self._request("GET", f"{API_GATEWAY}/api/v1/user/newcomer")
        return {"ok": True, "data": data.get("data", data)}

    def get_points(self, resource_type: int = 1) -> dict:
        data = self._request(
            "POST",
            f"{API_GATEWAY}/api/v1/benefit/points/query",
            json={"resourceType": int(resource_type)},
        )
        return data.get("data", data) if isinstance(data, dict) else {}

    def get_credits_balance(self, resource_type: int = 1) -> dict:
        """查询积分：可用余额取 availableCount。"""
        raw = self.get_points(resource_type=resource_type)
        balance = _extract_points_balance(raw)
        details = raw.get("playCodeDetails") if isinstance(raw, dict) else None
        return {
            "credits_balance": balance,
            "total_count": int(raw.get("totalCount") or 0) if isinstance(raw, dict) else 0,
            "available_count": int(raw.get("availableCount") or 0) if isinstance(raw, dict) else 0,
            "in_use_count": int(raw.get("inUseCount") or 0) if isinstance(raw, dict) else 0,
            "used_count": int(raw.get("usedCount") or 0) if isinstance(raw, dict) else 0,
            "play_code_details": details if isinstance(details, list) else [],
            "points": raw,
        }

    def grant_daily_signin(self) -> dict:
        """每日签到领取积分。"""
        data = self._request(
            "POST",
            f"{API_GATEWAY}/api/v1/benefit/points/grant",
            json={
                "playCode": "DAILY_SIGNIN",
                "activityCode": "DAILY_SIGNIN_ACTIVITY",
            },
        )
        inner = data.get("data", data) if isinstance(data, dict) else {}
        if not isinstance(inner, dict):
            inner = {}
        return {
            "success": bool(inner.get("success", True)),
            "grant_points": int(inner.get("grantPoints") or 0),
            "available_count": int(inner.get("availableCount") or 0),
            "play_code": inner.get("playCode") or "DAILY_SIGNIN",
            "record_id": inner.get("recordId"),
            "idempotent_key": inner.get("idempotentKey") or "",
            "raw": inner,
        }

    def get_sts_token(self, file_types: list[str] | None = None) -> dict:
        payload = {"fileTypes": file_types or ["image"]}
        data = self._request("POST", f"{API_GATEWAY}/api/v1/media/sts-token", json=payload)
        inner = data.get("data") or {}
        creds_raw = inner.get("credentials")
        if isinstance(creds_raw, str):
            try:
                creds = json.loads(creds_raw)
            except json.JSONDecodeError as e:
                raise HappyHorseError(f"解析 STS credentials 失败: {e}") from e
        elif isinstance(creds_raw, dict):
            creds = creds_raw
        else:
            raise HappyHorseError("STS 未返回 credentials")
        return {
            "credentials": creds,
            "bucket": inner.get("bucket") or "cn-delta-media-asset",
            "region": inner.get("region") or "oss-cn-hangzhou",
            "pathPrefix": inner.get("pathPrefix") or "",
        }

    @staticmethod
    def _oss_sign_put(
        *,
        access_key_id: str,
        access_key_secret: str,
        security_token: str,
        bucket: str,
        object_key: str,
        content_type: str,
        content_md5: str = "",
    ) -> dict:
        date = formatdate(timeval=None, localtime=False, usegmt=True)
        canonical_resource = f"/{bucket}/{object_key}"
        oss_headers = {"x-oss-security-token": security_token}
        canonical_oss_headers = "".join(f"{k}:{v}\n" for k, v in sorted(oss_headers.items()))
        string_to_sign = f"PUT\n{content_md5}\n{content_type}\n{date}\n{canonical_oss_headers}{canonical_resource}"
        signature = base64_hmac_sha1(access_key_secret, string_to_sign)
        return {
            "Authorization": f"OSS {access_key_id}:{signature}",
            "Content-Type": content_type,
            "Date": date,
            "x-oss-security-token": security_token,
            **({"Content-MD5": content_md5} if content_md5 else {}),
        }

    def upload_image(self, file_path: str) -> dict:
        """上传本地图片，返回 mediaId / ossPath / 尺寸等。"""
        if not file_path or not os.path.isfile(file_path):
            raise HappyHorseError(f"图片不存在: {file_path}")

        with open(file_path, "rb") as f:
            content = f.read()
        checksum = hashlib.md5(content).hexdigest()
        mime = mimetypes.guess_type(file_path)[0] or "image/png"
        ext = os.path.splitext(file_path)[1].lstrip(".") or "png"
        filename = os.path.basename(file_path)

        width, height = _image_size(content)

        sts = self.get_sts_token(["image"])
        creds = sts["credentials"]
        bucket = sts["bucket"]
        path_prefix = (sts["pathPrefix"] or "").rstrip("/")
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        object_key = f"{path_prefix}/image/{date_str}/{checksum}.{ext}".lstrip("/")
        host = f"{bucket}.oss-accelerate.aliyuncs.com"
        upload_url = f"https://{host}/{object_key}"

        headers = self._oss_sign_put(
            access_key_id=creds["accessKeyId"],
            access_key_secret=creds["accessKeySecret"],
            security_token=creds["securityToken"],
            bucket=bucket,
            object_key=object_key,
            content_type=mime,
        )
        try:
            put_resp = requests.put(upload_url, data=content, headers=headers, timeout=self.timeout)
        except requests.RequestException as e:
            raise HappyHorseError(f"OSS 上传失败: {e}") from e
        if put_resp.status_code >= 400:
            raise HappyHorseError(f"OSS 上传失败 HTTP {put_resp.status_code}: {put_resp.text[:300]}")

        oss_path = f"oss://{bucket}/{object_key}"
        asset_body = {
            "checksum": checksum,
            "mediaId": checksum,
            "ossPath": oss_path,
            "fileName": filename,
            "fileSize": len(content),
            "mimeType": mime,
            "createSource": "web",
            "width": width,
            "height": height,
        }
        asset_data = self._request("POST", f"{API_GATEWAY}/api/v1/media/asset", json=asset_body)
        media_id = str((asset_data.get("data") or {}).get("mediaId") or "")
        if not media_id:
            raise HappyHorseError("登记素材失败：未返回 mediaId")
        return {
            "mediaId": media_id,
            "ossPath": oss_path,
            "checksum": checksum,
            "fileName": filename,
            "width": width,
            "height": height,
        }

    def create_project(
        self,
        *,
        name: str = "My Video Project",
        description: str = "An AI video editing project",
        cover_oss_path: str = "",
        cover_media_id: str = "",
    ) -> dict:
        body = {
            "name": name,
            "description": description,
            "coverOssPath": cover_oss_path or "",
            "videoOssPath": "",
            "coverMediaId": str(cover_media_id or ""),
            "videoMediaId": "",
        }
        data = self._request("POST", f"{API_GATEWAY}/api/v2/projects", json=body)
        project = data.get("data") or {}
        if not project.get("id"):
            raise HappyHorseError("创建项目失败：未返回 project id")
        return project

    def create_task(
        self,
        *,
        project_id: int | str,
        prompt: str,
        image_media_ids: list[str],
        image_oss_paths: list[str],
        aspect_ratio: str = "16:9",
        duration_s: int = DEFAULT_DURATION,
        resolution: str = DEFAULT_RESOLUTION,
        model_version: str = DEFAULT_MODEL_VERSION,
        bx_ua: str = "",
        bx_et: str = "",
    ) -> dict:
        params = normalize_generation_params(
            aspect_ratio=aspect_ratio,
            duration_s=duration_s,
            resolution=resolution,
        )
        labels = [{"label": f"image_{i + 1}"} for i in range(len(image_media_ids))]
        body: dict = {
            "projectId": int(project_id),
            "prompt": prompt,
            "ossPaths": [],
            "imageOssPaths": image_oss_paths,
            "videoMediaIds": [],
            "imageMediaIds": [str(x) for x in image_media_ids],
            "taskType": "R2V" if image_media_ids else "T2V",
            "parameters": {
                "shotType": "single",
                "aspectRatio": params["aspect_ratio"],
                "durationS": int(params["duration_s"]),
                "resolution": params["resolution"],
                "useAudioInVideo": True,
                "modelVersion": model_version,
            },
            "duration": str(params["duration_s"]),
            "concurrency": 1,
            "imageInfoList": labels,
        }
        if bx_ua:
            body["bx-ua"] = bx_ua
        if self.bx_umidtoken:
            body["bx-umidtoken"] = self.bx_umidtoken
        if bx_et:
            body["bx_et"] = bx_et

        data = self._request("POST", f"{API_GATEWAY}/api/v2/tasks", json=body)
        task = data.get("data") or {}
        if not task.get("id"):
            raise HappyHorseError("创建任务失败：未返回 task id")
        return task

    def list_project_tasks(self, project_id: int | str) -> dict:
        url = f"{GW_BASE}/api/task/list?projectId={quote(str(project_id))}&calculatePrice=true"
        # gw uses same bearer auth
        data = self._request("GET", url)
        return data.get("data") or {}

    def get_task_from_list(self, project_id: int | str, task_id: int | str) -> dict | None:
        listing = self.list_project_tasks(project_id)
        for item in listing.get("list") or []:
            if str(item.get("taskId")) == str(task_id):
                return item
        return None


def _extract_points_balance(payload) -> int | float:
    """从 benefit/points/query 响应中尽量挖出可用积分数。"""
    if payload is None:
        return 0
    if isinstance(payload, (int, float)):
        return payload
    if isinstance(payload, str):
        try:
            return float(payload) if "." in payload else int(payload)
        except ValueError:
            return 0
    if not isinstance(payload, dict):
        return 0

    preferred_keys = (
        "availableCount",
        "totalCount",
        "credits_balance",
        "creditBalance",
        "remainingPoints",
        "availablePoints",
        "pointBalance",
        "pointsBalance",
        "balance",
        "totalPoints",
        "points",
        "grantPoints",
        "amount",
        "total",
        "remain",
        "remaining",
    )

    def _as_number(value):
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            try:
                return float(value) if "." in value else int(value)
            except ValueError:
                return None
        return None

    for key in preferred_keys:
        if key not in payload:
            continue
        value = payload[key]
        num = _as_number(value)
        if num is not None:
            return num
        if isinstance(value, dict):
            nested = _extract_points_balance(value)
            return nested

    for nested_key in ("data", "pointsInfo", "pointInfo", "userPoints", "account", "result"):
        nested = payload.get(nested_key)
        if isinstance(nested, dict):
            return _extract_points_balance(nested)

    for key, value in payload.items():
        num = _as_number(value)
        if num is not None and any(
            token in str(key).lower() for token in ("point", "credit", "balance", "remain")
        ):
            return num
    return 0


def base64_hmac_sha1(secret: str, message: str) -> str:
    import base64

    digest = hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def _image_size(content: bytes) -> tuple[int, int]:
    """Minimal PNG/JPEG size reader without Pillow dependency."""
    try:
        if content[:8] == b"\x89PNG\r\n\x1a\n" and len(content) >= 24:
            w = int.from_bytes(content[16:20], "big")
            h = int.from_bytes(content[20:24], "big")
            return w, h
        if content[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(content):
                if content[i] != 0xFF:
                    break
                marker = content[i + 1]
                if marker in (0xC0, 0xC1, 0xC2):
                    h = int.from_bytes(content[i + 5 : i + 7], "big")
                    w = int.from_bytes(content[i + 7 : i + 9], "big")
                    return w, h
                length = int.from_bytes(content[i + 2 : i + 4], "big")
                i += 2 + length
    except Exception:
        pass
    return 1280, 720


_LOGIN_PROC_LOCK = threading.Lock()
_LOGIN_PROCS: set[subprocess.Popen] = set()
_LOGIN_CANCEL = threading.Event()


class HappyHorseLoginCancelled(HappyHorseError):
    """批量/单次登录被用户取消。"""


def begin_login_batch() -> None:
    """开始一批登录前清除取消标记。"""
    _LOGIN_CANCEL.clear()


def is_login_cancelled() -> bool:
    return _LOGIN_CANCEL.is_set()


def cancel_login_batch() -> dict:
    """取消进行中的 HappyHorse 登录：置位取消标记并杀掉 Node 登录进程。"""
    _LOGIN_CANCEL.set()
    killed = 0
    with _LOGIN_PROC_LOCK:
        procs = list(_LOGIN_PROCS)
    for proc in procs:
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)
                killed += 1
        except Exception:
            try:
                proc.kill()
                killed += 1
            except Exception:
                pass
    return {"cancelled": True, "killed_processes": killed}


def login_with_google(
    email: str,
    password: str,
    visible: bool = True,
    proxy: str = "",
    keep_open: bool = False,
) -> dict:
    if is_login_cancelled():
        raise HappyHorseLoginCancelled("登录已取消")

    node_script = os.path.join(LOGIN_MODULE_DIR, "index.mjs")
    if not os.path.isfile(node_script):
        raise HappyHorseError(f"happyhorse-google-login 模块未找到: {node_script}")

    args = [NODE_BIN, node_script, "--email", email, "--password", password]
    if not visible:
        args.append("--headless")
    if keep_open:
        args.append("--keep-open")
    if proxy:
        args.extend(["--proxy", proxy])

    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=LOGIN_MODULE_DIR,
        )
    except FileNotFoundError as e:
        raise HappyHorseError(f"Node.js 未安装或不在 PATH 中: {NODE_BIN}") from e

    with _LOGIN_PROC_LOCK:
        _LOGIN_PROCS.add(proc)

    try:
        try:
            stdout, stderr = proc.communicate(timeout=LOGIN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as e:
            try:
                proc.kill()
                proc.communicate(timeout=5)
            except Exception:
                pass
            raise HappyHorseError(f"HappyHorse 登录超时（{LOGIN_TIMEOUT_SECONDS}秒）") from e
    finally:
        with _LOGIN_PROC_LOCK:
            _LOGIN_PROCS.discard(proc)

    if is_login_cancelled() or proc.returncode in (-15, -9):
        raise HappyHorseLoginCancelled("登录已取消")

    if proc.returncode != 0:
        output = ((stderr or "").strip() or (stdout or "").strip()).strip()
        raise HappyHorseError(
            f"HappyHorse 登录失败（exit={proc.returncode}）: {output[-2000:] or '无输出'}"
        )

    for line in (stdout or "").splitlines():
        if line.startswith("[happyhorse-login] state_json:"):
            json_str = line.split("state_json:", 1)[1].strip()
            try:
                return json.loads(json_str)
            except json.JSONDecodeError as e:
                raise HappyHorseError(f"解析登录结果失败: {json_str[:200]}") from e

    raise HappyHorseError("登录成功但未找到 state_json 输出")


def has_valid_token(account: dict) -> bool:
    token = str(account.get("access_token") or "").strip()
    if not token:
        return False
    expires_at = int(account.get("expires_at") or 0)
    if expires_at and expires_at < int(time.time() * 1000):
        return False
    return True


def pick_account(account_id: int = 0) -> dict:
    from .database import HappyhorseAccountDB

    if account_id:
        account = HappyhorseAccountDB.get(account_id)
        if not account:
            raise HappyHorseError("HappyHorse 账号不存在")
        if account.get("status") != "active":
            raise HappyHorseError(f"该渠道十一账号不可用：{account.get('status')}")
        if not has_valid_token(account):
            raise HappyHorseError("该渠道十一账号 accessToken 已过期，请重新登录")
        return account

    accounts = HappyhorseAccountDB.list_all_internal()
    available = [a for a in accounts if a.get("status") == "active" and has_valid_token(a)]
    if not available:
        raise HappyHorseError("没有可用的渠道十一账号，请先登录采集账号")

    from .database import TaskDB

    for account in available:
        active_count = TaskDB.active_count_for_account(int(account.get("id") or 0), model_prefix="happyhorse:")
        if active_count == 0:
            return account
    return available[0]


def map_task_status(raw_status: str) -> str:
    status = (raw_status or "").upper()
    if status in ("SUCCEEDED", "SUCCESS", "COMPLETED", "DONE"):
        return "completed"
    if status in ("FAILED", "ERROR", "CANCELLED", "CANCELED"):
        return "failed"
    return "processing"


def extract_result_urls(task_item: dict) -> tuple[str, str]:
    """从 task/list item 提取视频与封面 URL。"""
    video_url = ""
    cover_url = ""
    results = task_item.get("concurrentResults") or []
    if results:
        first = results[0] or {}
        video_url = first.get("resultVideoUrl") or ""
        cover_url = first.get("resultCoverUrl") or ""
    if not video_url:
        video_url = task_item.get("resultVideoUrl") or ""
    if not cover_url:
        cover_url = task_item.get("resultCoverUrl") or ""
    return video_url, cover_url


def extract_failure_reason(task_item: dict) -> str:
    """从 task/list item 提取可读失败原因。"""
    if not isinstance(task_item, dict):
        return ""
    for key in ("failReason", "failureReason", "errorMsg", "errorMessage", "message"):
        value = task_item.get(key)
        if value:
            return str(value)
    results = task_item.get("concurrentResults") or []
    if results:
        first = results[0] or {}
        for key in ("failureReason", "failReason", "errorMsg", "errorMessage", "message"):
            value = first.get(key)
            if value:
                text = str(value)
                # 截断过长 traceback，保留关键错误码
                if "errorCode=" in text:
                    head = text.split("\n", 1)[0]
                    return head[:300]
                return text[:300]
    return ""
