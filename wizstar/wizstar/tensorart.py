"""Tensor.Art Canvas API 客户端（渠道十）。

流程：
  1. 邮箱 magic-link 登录（必要时通过 YesCaptcha 处理 Turnstile）
  2. 创建 Canvas 项目
  3. 获取 R2 预签名地址并上传参考图
  4. 把参考图登记到角色库，构建 IMAGE -> VIDEO 工作流
  5. 启动节点、轮询运行状态
  6. 从 ``currentOutput.downloadUrl`` 直接取得视频下载地址
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import imaplib
import ipaddress
import json
import mimetypes
import os
import random
import re
import socket
import string
import time
import uuid
from email import message_from_bytes
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse

import requests

try:
    from curl_cffi import requests as curl_requests
    from curl_cffi.requests.exceptions import (
        RequestException as CurlRequestException,
    )
except ImportError:  # 打包缺依赖时保留其余渠道十 API 能力
    curl_requests = None
    CurlRequestException = None


_HTTP_REQUEST_ERRORS = (requests.RequestException,)
if CurlRequestException is not None:
    _HTTP_REQUEST_ERRORS += (CurlRequestException,)


API_BASE = "https://api.tensor.art"
CANVAS_ORIGIN = "https://canvas.tensor.art"
MAIN_ORIGIN = "https://tensor.art"
LOGIN_PAGE = "https://tensor.art/login?redirect=https://canvas.tensor.art/"
TURNSTILE_SITE_KEY = "0x4AAAAAAAS1_AKN3XKlym8v"

MAIN_PACKAGE_ID = "3000"
CANVAS_PACKAGE_ID = "3010"
_DEFAULT_SIGNING_KEY = "2TJhRTpCpUIgnWl3qwIaoMMt3KhL2nkC"
SIGNING_KEY = os.environ.get("TENSORART_SIGNING_KEY", "").strip() or _DEFAULT_SIGNING_KEY

DEFAULT_MODEL_ID = os.environ.get(
    "TENSORART_VIDEO_MODEL_ID", "1014073603487977875"
).strip()
DEFAULT_MODEL_FILE_ID = os.environ.get(
    "TENSORART_VIDEO_MODEL_FILE_ID", "1014073603487977876"
).strip()
MIN_VIDEO_DURATION = 4
MAX_VIDEO_DURATION = 10
VIDEO_DURATION_CREDITS = {
    4: 19,
    5: 24,
    6: 28,
    7: 33,
    8: 37,
    9: 42,
    10: 47,
}
DEFAULT_MODELS = [
    {
        "id": "tensorart-default",
        "name": "Tensor.Art 默认视频",
        "model_id": DEFAULT_MODEL_ID,
        "model_file_id": DEFAULT_MODEL_FILE_ID,
        "resolution": "480p",
        "duration": 4,
        "duration_options": [
            {"seconds": seconds, "credits": credits}
            for seconds, credits in VIDEO_DURATION_CREDITS.items()
        ],
    }
]
DEFAULT_RATIOS = ["16:9", "9:16", "1:1"]

_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/150.0.0.0 Safari/537.36"
)
_DEVICE_ALPHABET = string.ascii_letters + string.digits + "_-"
_MAX_IMAGE_BYTES = 25 * 1024 * 1024
_ALLOWED_REMOTE_IMAGE_HOSTS = (
    "tensor.art",
    "tensorartassets.com",
    "cloudflarestorage.com",
    "aliyuncs.com",
    "cloudfront.net",
    "hogiai.cn",
    "oiioii.ai",
    "byteimg.com",
    "ibytedtos.com",
    "douyinvod.com",
    "bytecdn.cn",
    "framia.pro",
    "converge.ai",
    "oreateai.com",
    "googleapis.com",
    "googleusercontent.com",
    "blob.core.windows.net",
    "oaistatic.com",
    "openai.com",
    "unsplash.com",
)


class TensorArtError(RuntimeError):
    """Tensor.Art API 调用失败。"""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        code: str = "",
    ):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def normalize_video_duration(value: object) -> int:
    try:
        duration = int(value or MIN_VIDEO_DURATION)
    except (TypeError, ValueError) as error:
        raise TensorArtError("Tensor.Art 视频时长必须是 4–10 秒整数", 400) from error
    if duration not in VIDEO_DURATION_CREDITS:
        raise TensorArtError("Tensor.Art 视频时长仅支持 4–10 秒", 400)
    return duration


def video_credits_for_duration(value: object) -> int:
    duration = normalize_video_duration(value)
    return VIDEO_DURATION_CREDITS[duration]


def generate_device_id(length: int = 21) -> str:
    return "".join(random.SystemRandom().choice(_DEVICE_ALPHABET) for _ in range(length))


def canonical_query(query: dict[str, Any] | list[tuple[str, Any]] | str | None) -> str:
    """按 Tensor.Art 前端规则生成签名用查询串（key 降序）。"""
    if not query:
        return ""
    if isinstance(query, str):
        pairs = parse_qsl(query.lstrip("?"), keep_blank_values=True)
    elif isinstance(query, dict):
        pairs = []
        for key, value in query.items():
            values = value if isinstance(value, (list, tuple)) else [value]
            pairs.extend((str(key), "" if item is None else str(item)) for item in values)
    else:
        pairs = [(str(key), "" if value is None else str(value)) for key, value in query]
    pairs.sort(key=lambda item: item[0], reverse=True)
    return urlencode(pairs)


def request_sign(
    path: str,
    timestamp: str,
    query: dict[str, Any] | list[tuple[str, Any]] | str | None = None,
    request_id: str = "",
    *,
    signing_key: str = SIGNING_KEY,
) -> str:
    message = f"{path}{canonical_query(query)}{request_id}{timestamp}".encode("utf-8")
    digest_hex = hmac.new(
        signing_key.encode("utf-8"),
        message,
        hashlib.sha256,
    ).hexdigest()
    return base64.b64encode(digest_hex.encode("utf-8")).decode("ascii")


def decode_jwt_payload(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
        data = json.loads(decoded.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except (IndexError, ValueError, TypeError, json.JSONDecodeError):
        return {}


def encode_task_id(
    run_id: str,
    canvas_id: str,
    node_id: str,
    account_id: int = 0,
) -> str:
    values = (str(run_id or ""), str(canvas_id or ""), str(node_id or ""))
    if not all(values) or any(":" in value for value in values):
        raise TensorArtError("无法编码 Tensor.Art 任务上下文")
    if account_id:
        return ":".join((values[0], values[1], str(int(account_id)), values[2]))
    return ":".join(values)


def decode_task_id(task_id: str) -> dict[str, str]:
    parts = str(task_id or "").split(":")
    if len(parts) == 3 and all(parts):
        return {
            "run_id": parts[0],
            "canvas_id": parts[1],
            "node_id": parts[2],
            "account_id": "",
        }
    if len(parts) == 4 and all(parts):
        try:
            int(parts[2])
        except ValueError as error:
            raise TensorArtError("Tensor.Art task_id 账号上下文无效") from error
        return {
            "run_id": parts[0],
            "canvas_id": parts[1],
            "node_id": parts[3],
            "account_id": parts[2],
        }
    if not all(parts):
        raise TensorArtError("Tensor.Art task_id 格式无效")
    raise TensorArtError("Tensor.Art task_id 格式无效")


def _response_json(response: requests.Response, action: str) -> dict:
    try:
        payload = response.json()
    except ValueError as error:
        text = (response.text or "").strip()
        raise TensorArtError(
            f"{action}失败：HTTP {response.status_code}，响应不是 JSON"
            + (f"（{text[:160]}）" if text else ""),
            status_code=response.status_code,
        ) from error
    if not isinstance(payload, dict):
        raise TensorArtError(f"{action}失败：响应格式不正确", response.status_code)
    return payload


def _message_from_payload(payload: dict) -> str:
    return str(
        payload.get("message")
        or payload.get("msg")
        or payload.get("errorMessage")
        or payload.get("error")
        or ""
    ).strip()


def _extract_first(data: Any, keys: tuple[str, ...]) -> Any:
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if value not in (None, "", [], {}):
                return value
        for value in data.values():
            found = _extract_first(value, keys)
            if found not in (None, "", [], {}):
                return found
    elif isinstance(data, list):
        for value in data:
            found = _extract_first(value, keys)
            if found not in (None, "", [], {}):
                return found
    return None


def _extract_run_id(payload: dict) -> str:
    value = _extract_first(payload, ("runId", "run_id", "workflowRunId"))
    if isinstance(value, (str, int)) and str(value):
        return str(value)
    run_ids = _extract_first(payload, ("runIds", "run_ids"))
    if isinstance(run_ids, list) and run_ids:
        first = run_ids[0]
        if isinstance(first, (str, int)):
            return str(first)
        nested = _extract_first(first, ("runId", "id"))
        return str(nested or "")
    if isinstance(run_ids, dict):
        first = next(iter(run_ids.values()), "")
        if isinstance(first, (str, int)):
            return str(first)
        nested = _extract_first(first, ("runId", "id"))
        return str(nested or "")
    runs = _extract_first(payload, ("runs",))
    if isinstance(runs, list) and runs:
        nested = _extract_first(runs[0], ("runId", "id"))
        return str(nested or "")
    if isinstance(runs, dict):
        nested = _extract_first(runs, ("runId", "id"))
        return str(nested or "")
    return ""


def _extract_asset_id(payload: dict) -> str:
    value = _extract_first(payload, ("assetId", "asset_id"))
    return str(value or "")


def _find_node_by_id(payload: Any, node_id: str) -> dict:
    if isinstance(payload, dict):
        if str(payload.get("id") or payload.get("nodeId") or "") == str(node_id):
            return payload
        for value in payload.values():
            found = _find_node_by_id(value, node_id)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _find_node_by_id(value, node_id)
            if found:
                return found
    return {}


def _normal_status(value: object) -> str:
    return str(value or "").strip().upper()


def extract_video_url(payload: Any, node_id: str = "") -> str:
    """从 Canvas 详情或运行响应中提取视频直链。"""
    video_candidates: list[str] = []

    def walk(value: Any, inside_target: bool = False) -> None:
        if isinstance(value, dict):
            current_target = inside_target or (
                bool(node_id)
                and str(value.get("id") or value.get("nodeId") or "") == str(node_id)
            )
            media_type = _normal_status(
                value.get("mediaType")
                or value.get("contentType")
                or value.get("mimeType")
                or value.get("type")
            )
            for key in ("downloadUrl", "signedUrl", "rawUrl", "videoUrl", "url"):
                candidate = value.get(key)
                if not isinstance(candidate, str) or not candidate.startswith(("http://", "https://")):
                    continue
                parsed_path = urlparse(candidate).path.lower()
                if (
                    key == "videoUrl"
                    or "VIDEO" in media_type
                    or parsed_path.endswith((".mp4", ".webm", ".mov", ".m4v"))
                ):
                    video_candidates.append(candidate)
            for nested in value.values():
                walk(nested, current_target)
        elif isinstance(value, list):
            for nested in value:
                walk(nested, inside_target)

    walk(payload)
    return next(iter(video_candidates), "")


def parse_run_result(payload: dict, run_id: str = "") -> dict:
    """把 runs/query 响应归一化为前端可消费的状态。"""
    data = payload.get("data", payload)
    runs: list[dict] = []
    if isinstance(data, dict):
        raw_runs = data.get("runs") or data.get("items") or data.get("list") or []
        if isinstance(raw_runs, list):
            runs = [item for item in raw_runs if isinstance(item, dict)]
        elif isinstance(raw_runs, dict):
            runs = [raw_runs]
        elif any(key in data for key in ("status", "currentOutput", "outputs")):
            runs = [data]
    elif isinstance(data, list):
        runs = [item for item in data if isinstance(item, dict)]

    run = next(
        (
            item
            for item in runs
            if str(item.get("runId") or item.get("id") or "") == str(run_id)
        ),
        runs[0] if runs else {},
    )
    raw_status = _normal_status(
        run.get("status")
        or run.get("runStatus")
        or _extract_first(data, ("status", "runStatus"))
    )
    status_map = {
        "SUCCESS": "completed",
        "SUCCEEDED": "completed",
        "COMPLETED": "completed",
        "FAILED": "failed",
        "FAIL": "failed",
        "ERROR": "failed",
        "CANCELLED": "failed",
        "CANCELED": "failed",
        "RUNNING": "processing",
        "PENDING": "processing",
        "QUEUED": "processing",
        "CREATED": "processing",
    }
    status = status_map.get(raw_status, "processing")

    output = run.get("currentOutput") or run.get("current_output") or {}
    if not isinstance(output, dict):
        output = {}
    if not output:
        outputs = run.get("outputs") or []
        if isinstance(outputs, list):
            output = next(
                (
                    item
                    for item in reversed(outputs)
                    if isinstance(item, dict)
                    and _normal_status(item.get("mediaType") or item.get("type")) == "VIDEO"
                ),
                next((item for item in reversed(outputs) if isinstance(item, dict)), {}),
            )

    video_url = str(extract_video_url(output) or extract_video_url(run) or "")
    progress_value = (
        run.get("processProgress")
        or run.get("progress")
        or _extract_first(data, ("processProgress", "progress"))
        or 0
    )
    try:
        progress = float(progress_value)
    except (TypeError, ValueError):
        progress = 0.0
    error = str(
        run.get("errorMessage")
        or run.get("failMessage")
        or run.get("failureReason")
        or run.get("statusMessage")
        or run.get("message")
        or _extract_first(
            data,
            ("errorMessage", "failMessage", "failureReason", "statusMessage"),
        )
        or ""
    )
    fail_code = str(
        run.get("failCode")
        or run.get("errorCode")
        or _extract_first(data, ("failCode", "errorCode"))
        or ""
    )
    return {
        "status": status,
        "raw_status": raw_status,
        "progress": progress,
        "media_type": "video",
        "video_url": video_url,
        "download_url": video_url,
        "filename": str(output.get("filename") or "tensorart-video.mp4"),
        "width": output.get("width"),
        "height": output.get("height"),
        "duration_sec": output.get("durationSec") or output.get("duration"),
        "asset_id": str(output.get("assetId") or ""),
        "error": error,
        "fail_code": fail_code,
    }


def _safe_remote_image_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if not any(
        host == allowed or host.endswith("." + allowed)
        for allowed in _ALLOWED_REMOTE_IMAGE_HOSTS
    ):
        return False
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
        }
        return all(ipaddress.ip_address(address).is_global for address in addresses)
    except (OSError, ValueError):
        return False


def _image_file_type(filename: str, mime_type: str) -> str:
    extension = Path(filename).suffix.lower().lstrip(".")
    aliases = {"jpg": "JPG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}
    if extension in aliases:
        return aliases[extension]
    mime_extension = mimetypes.guess_extension(mime_type or "") or ".png"
    return aliases.get(mime_extension.lstrip(".").lower(), "PNG")


def _read_image_source(source: str) -> tuple[bytes, str, str, str]:
    value = str(source or "").strip()
    if not value:
        raise TensorArtError("参考图为空")

    if value.startswith("data:"):
        header, separator, encoded = value.partition(",")
        if not separator or ";base64" not in header.lower():
            raise TensorArtError("仅支持 base64 data-uri 参考图")
        mime_type = header[5:].split(";", 1)[0].lower() or "image/png"
        try:
            content = base64.b64decode(encoded, validate=False)
        except ValueError as error:
            raise TensorArtError("参考图 base64 解码失败") from error
        extension = mimetypes.guess_extension(mime_type) or ".png"
        filename = f"reference-{uuid.uuid4().hex}{extension}"
    elif value.startswith(("http://", "https://")):
        current_url = value
        response: requests.Response | None = None
        remote_session = requests.Session()
        remote_session.trust_env = False
        try:
            for _redirect in range(6):
                if not _safe_remote_image_url(current_url):
                    raise TensorArtError("不允许读取该远程参考图地址")
                response = remote_session.get(
                    current_url,
                    headers={"User-Agent": _DEFAULT_USER_AGENT, "Accept": "image/*"},
                    timeout=45,
                    allow_redirects=False,
                    stream=True,
                )
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location", "")
                    response.close()
                    if not location:
                        raise TensorArtError("远程参考图重定向缺少 Location")
                    current_url = urljoin(current_url, location)
                    response = None
                    continue
                break
            else:
                raise TensorArtError("远程参考图重定向次数过多")
        except TensorArtError:
            remote_session.close()
            raise
        except requests.RequestException as error:
            remote_session.close()
            raise TensorArtError(f"下载远程参考图失败：{error}") from error
        if response is None:
            remote_session.close()
            raise TensorArtError("下载远程参考图失败")
        try:
            if response.status_code >= 400:
                raise TensorArtError(
                    f"下载远程参考图失败：HTTP {response.status_code}",
                    response.status_code,
                )
            content_length = int(response.headers.get("Content-Length") or 0)
            if content_length > _MAX_IMAGE_BYTES:
                raise TensorArtError("参考图超过 25MB")
            chunks: list[bytes] = []
            received = 0
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                received += len(chunk)
                if received > _MAX_IMAGE_BYTES:
                    raise TensorArtError("参考图超过 25MB")
                chunks.append(chunk)
            content = b"".join(chunks)
            mime_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
        finally:
            response.close()
            remote_session.close()
        filename = Path(urlparse(current_url).path).name or f"reference-{uuid.uuid4().hex}.png"
    else:
        file_path = os.path.abspath(os.path.expanduser(value))
        if not os.path.isfile(file_path):
            raise TensorArtError(f"参考图不存在：{value}")
        if os.path.getsize(file_path) > _MAX_IMAGE_BYTES:
            raise TensorArtError("参考图超过 25MB")
        content = Path(file_path).read_bytes()
        mime_type = mimetypes.guess_type(file_path)[0] or "image/png"
        filename = os.path.basename(file_path)

    if not content:
        raise TensorArtError("参考图内容为空")
    if len(content) > _MAX_IMAGE_BYTES:
        raise TensorArtError("参考图超过 25MB")
    if not mime_type.startswith("image/"):
        raise TensorArtError(f"参考文件不是图片：{mime_type or '未知类型'}")
    file_type = _image_file_type(filename, mime_type)
    return content, mime_type, filename, file_type


class TensorArtClient:
    """带请求签名的 Tensor.Art API 客户端。"""

    def __init__(
        self,
        access_token: str,
        device_id: str = "",
        user_agent: str = "",
        timeout: int = 60,
        session: requests.Session | None = None,
    ):
        self.access_token = str(access_token or "").strip()
        if not self.access_token:
            raise TensorArtError("缺少 Tensor.Art access token")
        token_payload = decode_jwt_payload(self.access_token)
        self.device_id = (
            str(device_id or "").strip()
            or str(token_payload.get("deviceId") or "").strip()
            or generate_device_id()
        )
        self.user_agent = str(user_agent or "").strip() or _DEFAULT_USER_AGENT
        self.timeout = int(timeout or 60)
        self.session = session or requests.Session()

    def _headers(
        self,
        path: str,
        *,
        package_id: str = CANVAS_PACKAGE_ID,
        origin: str = CANVAS_ORIGIN,
        query: dict[str, Any] | None = None,
        request_id: str = "",
        captcha_token: str = "",
        include_auth: bool = True,
    ) -> dict[str, str]:
        timestamp = str(int(time.time() * 1000))
        headers = {
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Content-Type": "application/json",
            "Origin": origin,
            "Referer": f"{origin}/",
            "User-Agent": self.user_agent,
            "X-Device-Id": self.device_id,
            "X-Request-Lang": "en-US",
            "X-Request-Package-Id": package_id,
            "X-Request-Package-Sign-Version": "0.0.1",
            "X-Request-Sign": request_sign(path, timestamp, query, request_id),
            "X-Request-Sign-Type": "HMAC_SHA256",
            "X-Request-Sign-Version": "v1",
            "X-Request-Timestamp": timestamp,
        }
        if request_id:
            headers["X-Request-Id"] = request_id
        if captcha_token:
            headers["X-Captcha-Token"] = captcha_token
        if include_auth:
            headers["Authorization"] = f"Bearer {self.access_token}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict | None = None,
        query: dict[str, Any] | None = None,
        package_id: str = CANVAS_PACKAGE_ID,
        origin: str = CANVAS_ORIGIN,
        action: str = "请求 Tensor.Art",
    ) -> dict:
        retryable = method.upper() == "GET" or path.endswith(
            ("/runs/query", "/canvas/detail", "/get_asset")
        )
        attempts = 3 if retryable else 1
        response: requests.Response | None = None
        last_error: requests.RequestException | None = None
        for attempt in range(attempts):
            try:
                response = self.session.request(
                    method,
                    f"{API_BASE}{path}",
                    params=query,
                    json=json_body,
                    headers=self._headers(
                        path,
                        package_id=package_id,
                        origin=origin,
                        query=query,
                    ),
                    timeout=self.timeout,
                )
                if (
                    retryable
                    and attempt + 1 < attempts
                    and (
                        response.status_code in {408, 425, 429}
                        or response.status_code >= 500
                    )
                ):
                    response.close()
                    response = None
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                break
            except requests.RequestException as error:
                last_error = error
                if attempt + 1 < attempts:
                    time.sleep(0.5 * (2 ** attempt))
        if response is None:
            raise TensorArtError(f"{action}失败：{last_error}") from last_error
        payload = _response_json(response, action)
        code = str(payload.get("code", "0"))
        if response.status_code >= 400 or code not in {"", "0"}:
            message = _message_from_payload(payload) or f"HTTP {response.status_code}"
            error_status = response.status_code if response.status_code >= 400 else 400
            raise TensorArtError(
                f"{action}失败：{message}",
                status_code=error_status,
                code=code,
            )
        return payload

    def get_profile(self) -> dict:
        payload = self._request(
            "GET",
            "/user-web/v1/user/profile/detail",
            package_id=MAIN_PACKAGE_ID,
            origin=MAIN_ORIGIN,
            action="读取 Tensor.Art 用户资料",
        )
        data = payload.get("data", payload)
        if isinstance(data, dict) and isinstance(data.get("info"), dict):
            return data["info"]
        return data if isinstance(data, dict) else {}

    def get_energy(self) -> dict:
        payload = self._request(
            "GET",
            "/user-web/v1/user/energy",
            package_id=MAIN_PACKAGE_ID,
            origin=MAIN_ORIGIN,
            action="读取 Tensor.Art 能量",
        )
        data = payload.get("data", payload)
        return data if isinstance(data, dict) else {}

    def test_connection(self) -> dict:
        profile = self.get_profile()
        return {
            "ok": True,
            "user_id": str(profile.get("userId") or profile.get("id") or ""),
            "name": str(profile.get("name") or profile.get("nickname") or ""),
        }

    def create_canvas(self, name: str = "Untitled") -> dict:
        payload = self._request(
            "POST",
            "/canvas/v1/canvas/create",
            json_body={"name": name or "Untitled", "mode": "WORKFLOW"},
            action="创建 Tensor.Art Canvas",
        )
        data = payload.get("data", payload)
        canvas_id = ""
        if isinstance(data, dict):
            canvas = data.get("canvas") or {}
            if isinstance(canvas, dict) and isinstance(canvas.get("canvas"), dict):
                canvas_id = str(canvas["canvas"].get("id") or "")
            if not canvas_id and isinstance(canvas, dict):
                canvas_id = str(canvas.get("id") or canvas.get("canvasId") or "")
            canvas_id = canvas_id or str(data.get("canvasId") or data.get("id") or "")
        if not canvas_id:
            raise TensorArtError("创建 Tensor.Art Canvas 成功但未返回 canvasId")
        return {"canvas_id": canvas_id, "raw": payload}

    def canvas_detail(self, canvas_id: str) -> dict:
        return self._request(
            "POST",
            "/canvas/v1/canvas/detail",
            json_body={"canvasId": str(canvas_id)},
            action="读取 Tensor.Art Canvas",
        )

    def apply_actions(self, canvas_id: str, actions: list[dict]) -> dict:
        return self._request(
            "POST",
            "/canvas/v1/canvas/workflow/actions",
            json_body={
                "canvasId": str(canvas_id),
                "actions": actions,
                "createdBy": "user",
            },
            action="保存 Tensor.Art 工作流",
        )

    def add_video_node(self, canvas_id: str, node_id: str) -> None:
        self.apply_actions(
            canvas_id,
            [
                {
                    "action": "add",
                    "nodes": [
                        {
                            "id": node_id,
                            "type": "VIDEO",
                            "subType": "GENERATE",
                            "title": "Generate video",
                            "position": {"x": 620, "y": 500},
                            "status": "IDLE",
                        }
                    ],
                }
            ],
        )

    def request_upload(self, file_type: str) -> dict:
        payload = self._request(
            "POST",
            "/community-web/v1/media/upload/create",
            json_body={"scene": "CANVAS", "fileType": file_type.upper()},
            action="申请 Tensor.Art 图片上传地址",
        )
        data = payload.get("data", payload)
        if not isinstance(data, dict):
            data = {}
        result = {
            "media_id": str(data.get("mediaId") or ""),
            "upload_url": str(data.get("uploadUrl") or ""),
            "display_url": str(data.get("displayUrl") or ""),
        }
        if not result["upload_url"] or not result["display_url"]:
            raise TensorArtError("Tensor.Art 上传接口未返回 uploadUrl/displayUrl")
        return result

    def upload_reference(self, source: str) -> dict:
        content, mime_type, filename, file_type = _read_image_source(source)
        upload = self.request_upload(file_type)
        try:
            response = requests.put(
                upload["upload_url"],
                data=content,
                headers={"Content-Type": mime_type},
                timeout=120,
            )
        except requests.RequestException as error:
            raise TensorArtError(f"上传参考图到 Tensor.Art R2 失败：{error}") from error
        if response.status_code >= 400:
            raise TensorArtError(
                f"上传参考图到 Tensor.Art R2 失败：HTTP {response.status_code}",
                response.status_code,
            )

        payload = self._request(
            "POST",
            "/canvas/v1/canvas/role_library/create_asset",
            json_body={
                "groupType": "VIRTUAL_PORTRAIT",
                "imageUrl": upload["display_url"],
                "assetType": "Image",
            },
            action="登记 Tensor.Art 参考素材",
        )
        asset_id = _extract_asset_id(payload)
        if not asset_id:
            raise TensorArtError("Tensor.Art 素材登记成功但未返回 assetId")

        asset = self.wait_for_asset_ready(asset_id)
        image_url = str(
            (asset.get("imageUrl") if isinstance(asset, dict) else "")
            or upload["display_url"]
        )
        return {
            "asset_id": asset_id,
            "image_url": image_url,
            "filename": filename,
            "media_id": upload["media_id"],
        }

    def wait_for_asset_ready(
        self,
        asset_id: str,
        *,
        timeout: float = 45,
        interval: float = 0.75,
    ) -> dict:
        deadline = time.monotonic() + max(1.0, float(timeout))
        last_status = ""
        last_message = ""
        while True:
            asset_payload = self._request(
                "POST",
                "/canvas/v1/canvas/role_library/get_asset",
                json_body={"assetIds": [str(asset_id)]},
                action="读取 Tensor.Art 参考素材",
            )
            assets = (asset_payload.get("data") or {}).get("assets") or []
            asset = assets[0] if isinstance(assets, list) and assets else {}
            if isinstance(asset, dict):
                last_status = str(asset.get("status") or "").upper()
                last_message = str(asset.get("statusMessage") or "")
                if last_status.endswith("_ACTIVE") or last_status in {
                    "ACTIVE",
                    "READY",
                    "SUCCESS",
                    "COMPLETED",
                }:
                    return asset
                if any(
                    marker in last_status
                    for marker in ("FAILED", "REJECTED", "BLOCKED", "DISABLED", "DELETED")
                ):
                    raise TensorArtError(
                        "Tensor.Art 参考素材审核失败"
                        + (f"：{last_message}" if last_message else f"（{last_status}）"),
                        status_code=422,
                    )
            if time.monotonic() >= deadline:
                raise TensorArtError(
                    "等待 Tensor.Art 参考素材审核超时"
                    + (f"（{last_status}）" if last_status else ""),
                    status_code=504,
                )
            time.sleep(max(0.1, float(interval)))

    def add_image_node(
        self,
        canvas_id: str,
        video_node_id: str,
        asset_id: str,
        image_url: str,
        index: int,
    ) -> str:
        image_node_id = f"IMAGE-{uuid.uuid4()}"
        self.apply_actions(
            canvas_id,
            [
                {
                    "action": "add",
                    "nodes": [
                        {
                            "id": image_node_id,
                            "type": "IMAGE",
                            "subType": "ROLE_LIBRARY",
                            "title": "Character Library",
                            "position": {"x": 20, "y": 360 + (index * 250)},
                            "status": "SUCCESS",
                            "data": {
                                "image": {
                                    "url": image_url,
                                    "assetId": asset_id,
                                }
                            },
                        }
                    ],
                },
                {
                    "action": "connect",
                    "connections": [
                        {
                            "id": f"edge-{uuid.uuid4()}",
                            "source": image_node_id,
                            "target": video_node_id,
                        }
                    ],
                },
            ],
        )
        return image_node_id

    def update_video_node(
        self,
        canvas_id: str,
        node_id: str,
        prompt: str,
        *,
        aspect_ratio: str = "16:9",
        resolution: str = "480p",
        duration: int = 4,
        model_id: str = DEFAULT_MODEL_ID,
        model_file_id: str = DEFAULT_MODEL_FILE_ID,
    ) -> None:
        normalized_duration = normalize_video_duration(duration)
        request_payload = {
            "params": {
                "prompt": str(prompt or "").strip(),
                "negativePrompt": "",
                "imageCount": 1,
                "steps": 20,
                "cfgScale": 7,
                "seed": "-1",
                "baseModel": {
                    "modelId": str(model_id),
                    "modelFileId": str(model_file_id),
                },
                "promptExtend": False,
                "videoParams": {
                    "dur": str(normalized_duration),
                    "mode": "NORMAL",
                    "fps": "24",
                    "useUpscale": False,
                    "interFrame": False,
                    "hasAudioOutput": True,
                    "keepOriginSound": False,
                },
                "aspectRatio": aspect_ratio if aspect_ratio in DEFAULT_RATIOS else "16:9",
                "imageSize": resolution or "480p",
                "useFirstLastFrame": False,
            },
            "taskType": "REF2VIDEO",
            "credits": video_credits_for_duration(normalized_duration),
            "overrider": {},
            "isRemix": False,
            "remixPostId": "0",
            "remixPostImageId": "0",
            "workspaceType": "VIDEO_WORKSPACE",
        }
        self.apply_actions(
            canvas_id,
            [
                {
                    "action": "update",
                    "updates": [
                        {
                            "id": node_id,
                            "position": {"x": 420, "y": 500},
                            "title": "Generate video",
                            "status": "RUNNING",
                            "data": {
                                "generation": {
                                    "params": {
                                        "request": request_payload,
                                    }
                                }
                            },
                            "updateFields": [
                                "position",
                                "size",
                                "title",
                                "status",
                                "data",
                                "parentId",
                            ],
                        }
                    ],
                }
            ],
        )

    def run_node(self, canvas_id: str, node_id: str) -> dict:
        client_request_id = str(uuid.uuid4())
        run_error: TensorArtError | None = None
        try:
            payload = self._request(
                "POST",
                "/canvas/v1/canvas/workflow/nodes/run",
                json_body={
                    "triggerRole": "user",
                    "canvasId": str(canvas_id),
                    "runTarget": {"type": "node", "nodeIds": [node_id]},
                    "clientRequestId": client_request_id,
                },
                action="启动 Tensor.Art 视频生成",
            )
        except TensorArtError as error:
            # 请求可能已在服务端生效但响应链路中断，先从 Canvas 上下文恢复 runId，
            # 避免重发非幂等的生成请求造成重复扣费。
            payload = {}
            run_error = error
        run_id = _extract_run_id(payload)
        if not run_id:
            # 部分 Canvas 版本的 nodes/run 响应不直接暴露 runId；
            # 运行上下文会同步到目标节点的 generation.currentRunId。
            for _attempt in range(8):
                time.sleep(0.75)
                try:
                    detail = self.canvas_detail(canvas_id)
                except TensorArtError:
                    continue
                node = _find_node_by_id(detail, node_id)
                generation = (
                    (node.get("data") or {}).get("generation") or {}
                    if isinstance(node, dict)
                    else {}
                )
                run_id = str(
                    generation.get("currentRunId")
                    or _extract_run_id({"runs": generation.get("runs") or []})
                    or ""
                )
                if run_id:
                    break
        if not run_id:
            if run_error:
                raise run_error
            raise TensorArtError("Tensor.Art 已接收生成请求但未返回 runId")
        return {
            "run_id": run_id,
            "client_request_id": client_request_id,
            "raw": payload,
        }

    def query_run(self, canvas_id: str, node_id: str, run_id: str) -> dict:
        return self._request(
            "POST",
            "/canvas/v1/canvas/workflow/runs/query",
            json_body={
                "canvasId": str(canvas_id),
                "nodeIds": [str(node_id)],
                "runIds": [str(run_id)],
            },
            action="查询 Tensor.Art 视频任务",
        )

    def start_video_generation(
        self,
        prompt: str,
        image_sources: list[str],
        *,
        aspect_ratio: str = "16:9",
        resolution: str = "480p",
        duration: int = 4,
        model_id: str = DEFAULT_MODEL_ID,
        model_file_id: str = DEFAULT_MODEL_FILE_ID,
    ) -> dict:
        duration = normalize_video_duration(duration)
        sources = [str(source).strip() for source in image_sources if str(source).strip()]
        sources = list(dict.fromkeys(sources))[:2]
        if not sources:
            raise TensorArtError("渠道十当前按已抓取协议仅支持图生视频，请先添加垫图")
        prompt = str(prompt or "").strip()
        if not prompt:
            raise TensorArtError("提示词不能为空")

        canvas = self.create_canvas("Untitled")
        canvas_id = canvas["canvas_id"]
        node_id = f"VIDEO-{uuid.uuid4()}"
        self.add_video_node(canvas_id, node_id)

        assets: list[dict] = []
        for index, source in enumerate(sources):
            asset = self.upload_reference(source)
            asset["node_id"] = self.add_image_node(
                canvas_id,
                node_id,
                asset["asset_id"],
                asset["image_url"],
                index,
            )
            assets.append(asset)

        missing_mentions = [
            f"@Image{index + 1}"
            for index in range(len(assets))
            if f"@image{index + 1}" not in prompt.lower()
        ]
        generation_prompt = (
            f"{' '.join(missing_mentions)} {prompt}".strip()
            if missing_mentions
            else prompt
        )
        self.update_video_node(
            canvas_id,
            node_id,
            generation_prompt,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            duration=duration,
            model_id=model_id,
            model_file_id=model_file_id,
        )
        run = self.run_node(canvas_id, node_id)
        return {
            "canvas_id": canvas_id,
            "node_id": node_id,
            "run_id": run["run_id"],
            "client_request_id": run["client_request_id"],
            "assets": assets,
            "status": "processing",
            "duration": duration,
            "credits": video_credits_for_duration(duration),
        }


def _decode_header(value: str) -> str:
    chunks: list[str] = []
    for chunk, encoding in decode_header(value or ""):
        if isinstance(chunk, bytes):
            chunks.append(chunk.decode(encoding or "utf-8", errors="ignore"))
        else:
            chunks.append(str(chunk))
    return "".join(chunks)


def _message_body(message: Any) -> str:
    parts: list[str] = []
    iterable = message.walk() if message.is_multipart() else [message]
    for part in iterable:
        if part.get_content_type() not in {"text/plain", "text/html"}:
            continue
        payload = part.get_payload(decode=True)
        if payload:
            parts.append(
                payload.decode(part.get_content_charset() or "utf-8", errors="ignore")
            )
    return "\n".join(parts)


def _find_tensorart_link(text: str) -> str:
    decoded = html.unescape(text or "").replace("\\/", "/")
    links = [
        link.rstrip(").,;]")
        for link in re.findall(
            r"https?://[^\s\"'<>]+",
            decoded,
            flags=re.IGNORECASE,
        )
    ]
    # 邮件首个 trick-noreply 地址通常是 /track/open2/ 统计像素，
    # 只有 click 跟踪链接才会进入登录回调并下发 ta_token_prod。
    for cleaned in links:
        parsed = urlparse(cleaned)
        host = (parsed.hostname or "").lower()
        if (
            host == "trick-noreply.tensor.art"
            and parsed.path.lower().startswith("/track/click")
        ):
            return cleaned
    for cleaned in links:
        parsed = urlparse(cleaned)
        host = (parsed.hostname or "").lower()
        if (host == "tensor.art" or host.endswith(".tensor.art")) and (
            "signin/auth/callback" in parsed.path.lower()
        ):
            return cleaned
    return ""


def wait_for_magic_link(
    mailbox: Any,
    *,
    not_before: float,
    max_wait: int = 210,
    poll_interval: int = 5,
) -> str:
    token = mailbox.get_access_token()
    deadline = time.time() + max(30, int(max_wait or 210))
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            client = imaplib.IMAP4_SSL(mailbox.IMAP_HOST, timeout=30)
            client.authenticate(
                "XOAUTH2",
                lambda _challenge: mailbox._xoauth2(mailbox.email, token),
            )
            try:
                for folder in ("INBOX", "Junk"):
                    try:
                        client.select(folder)
                        status, messages = client.search(None, "ALL")
                    except Exception:
                        continue
                    ids = messages[0].split() if status == "OK" else []
                    for message_id in reversed(ids[-40:]):
                        if time.time() >= deadline:
                            break
                        try:
                            _, raw = client.fetch(message_id, "(RFC822)")
                            message = message_from_bytes(raw[0][1])
                            subject = _decode_header(str(message.get("subject", "")))
                            sender = str(message.get("from", ""))
                            if "tensor" not in f"{subject} {sender}".lower():
                                continue
                            sender_address = parseaddr(sender)[1].lower()
                            sender_domain = sender_address.rpartition("@")[2]
                            if sender_domain and not (
                                sender_domain == "tensor.art"
                                or sender_domain.endswith(".tensor.art")
                            ):
                                continue
                            try:
                                sent_at = parsedate_to_datetime(
                                    str(message.get("date", ""))
                                ).timestamp()
                                # Magic-link 与发起登录时的设备会话绑定，不能复用上一次
                                # 注册邮件；仅保留几秒邮件服务器时钟误差。
                                if sent_at < not_before - 5:
                                    continue
                            except (TypeError, ValueError, OverflowError):
                                pass
                            link = _find_tensorart_link(_message_body(message))
                            if link:
                                return link
                        except Exception:
                            continue
            finally:
                try:
                    client.logout()
                except Exception:
                    pass
        except Exception as error:  # noqa: BLE001
            last_error = error
        time.sleep(max(2, int(poll_interval or 5)))
    raise TensorArtError(
        f"等待 Tensor.Art 登录邮件超时（{max_wait}s）"
        + (f"：{last_error}" if last_error else "")
    )


def _signin_headers(
    path: str,
    device_id: str,
    user_agent: str,
    captcha_token: str = "",
) -> dict[str, str]:
    timestamp = str(int(time.time() * 1000))
    headers = {
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Content-Type": "application/json",
        "Origin": MAIN_ORIGIN,
        "Referer": LOGIN_PAGE,
        "X-Device-Id": device_id,
        "X-Request-Lang": "en-US",
        "X-Request-Package-Id": MAIN_PACKAGE_ID,
        "X-Request-Package-Sign-Version": "0.0.1",
        "X-Request-Sign": request_sign(path, timestamp),
        "X-Request-Sign-Type": "HMAC_SHA256",
        "X-Request-Sign-Version": "v1",
        "X-Request-Timestamp": timestamp,
    }
    if captcha_token:
        headers["X-Captcha-Token"] = captcha_token
    return headers


def _signin(
    session: Any,
    email_address: str,
    device_id: str,
    user_agent: str,
    captcha_token: str = "",
) -> dict:
    path = "/user-web/v1/signin"
    try:
        response = session.post(
            f"{API_BASE}{path}",
            headers=_signin_headers(path, device_id, user_agent, captcha_token),
            json={
                "email": email_address,
                "type": "EMAIL",
                "returnUrl": LOGIN_PAGE,
            },
            timeout=45,
        )
    except _HTTP_REQUEST_ERRORS as error:
        raise TensorArtError(f"发送 Tensor.Art 登录邮件失败：{error}") from error
    payload = _response_json(response, "发送 Tensor.Art 登录邮件")
    return {
        "http_status": response.status_code,
        "code": str(payload.get("code", "")),
        "message": _message_from_payload(payload),
        "payload": payload,
    }


def _captcha_required(result: dict) -> bool:
    code = str(result.get("code") or "").upper()
    message = str(result.get("message") or "").upper()
    return (
        code in {"1300100", "WORKS_NEED_RECAPTCHA", "NEED_CAPTCHA"}
        or "CAPTCHA" in code
        or "CAPTCHA" in message
        or "RECAPTCHA" in message
    )


def _extract_session_token(session: Any, responses: list[Any]) -> str:
    cookies = getattr(session, "cookies", None)
    try:
        cookie_values = cookies.get_dict() if cookies is not None else {}
        if cookie_values.get("ta_token_prod"):
            return str(cookie_values["ta_token_prod"])
    except Exception:
        pass
    try:
        jar = getattr(cookies, "jar", cookies)
        for cookie in jar or []:
            if getattr(cookie, "name", "") == "ta_token_prod" and getattr(cookie, "value", ""):
                return str(cookie.value)
    except Exception:
        pass
    for response in responses:
        header = response.headers.get("Set-Cookie", "")
        match = re.search(r"(?:^|[,;]\s*)ta_token_prod=([^;,]+)", header)
        if match:
            return match.group(1)
    return ""


def _resolve_register_proxy() -> str:
    """curl_cffi 不走 macOS 系统代理，注册时需显式指定。"""
    for key in (
        "TENSORART_PROXY",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ):
        value = str(os.environ.get(key) or "").strip()
        if value:
            return value
    try:
        from .quickframe_bridge import get_proxy_settings

        configured = str(get_proxy_settings().get("requests_proxy") or "").strip()
    except Exception:
        configured = ""
    candidates = []
    if configured:
        candidates.append(configured)
    for port in (7892, 7890, 1087, 7897, 10809):
        candidates.append(f"http://127.0.0.1:{port}")
    seen = set()
    for proxy in candidates:
        if not proxy or proxy in seen:
            continue
        seen.add(proxy)
        parsed = urlparse(proxy)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            with socket.create_connection((host, port), timeout=0.4):
                return proxy
        except OSError:
            continue
    return ""


def register_with_mailbox(
    email_address: str,
    client_id: str,
    refresh_token: str,
    yescap_key: str,
    *,
    max_wait: int = 210,
    user_agent: str = "",
    proxy: str = "",
) -> dict:
    """使用 Microsoft OAuth 邮箱完成 Tensor.Art magic-link 注册/登录。"""
    from .mailbox import OutlookMailbox
    from .yescaptcha import solve_turnstile

    email_address = str(email_address or "").strip()
    if not email_address or not client_id or not refresh_token:
        raise TensorArtError("Tensor.Art 注册需要 Microsoft OAuth 邮箱三件套")
    if not yescap_key:
        raise TensorArtError("未配置 YesCaptcha Key，请先在设置 → 渠道三中填写")

    device_id = generate_device_id()
    resolved_user_agent = str(user_agent or "").strip() or _DEFAULT_USER_AGENT
    if curl_requests is None:
        raise TensorArtError(
            "Tensor.Art 邮件注册缺少 curl_cffi，请安装后重启后端"
        )
    resolved_proxy = str(proxy or "").strip() or _resolve_register_proxy()
    session_kwargs: dict[str, Any] = {"impersonate": "chrome"}
    if resolved_proxy:
        session_kwargs["proxies"] = {
            "http": resolved_proxy,
            "https": resolved_proxy,
        }
    session = curl_requests.Session(**session_kwargs)
    try:
        session.get(LOGIN_PAGE, timeout=30)
    except _HTTP_REQUEST_ERRORS:
        # 登录页可能被 Cloudflare 拒绝；API 登录仍可继续。
        pass

    requested_at = time.time()
    signin_result = _signin(
        session,
        email_address,
        device_id,
        resolved_user_agent,
    )
    if _captcha_required(signin_result):
        captcha_token = solve_turnstile(
            yescap_key,
            MAIN_ORIGIN,
            TURNSTILE_SITE_KEY,
            max_wait_seconds=180,
            poll_interval_seconds=3,
        )
        signin_result = _signin(
            session,
            email_address,
            device_id,
            resolved_user_agent,
            captcha_token=captcha_token,
        )

    if signin_result["http_status"] >= 400 or signin_result["code"] not in {"", "0"}:
        raise TensorArtError(
            "发送 Tensor.Art 登录邮件失败："
            + (signin_result["message"] or f"code={signin_result['code']}"),
            status_code=signin_result["http_status"],
            code=signin_result["code"],
        )

    mailbox = OutlookMailbox(email_address, client_id, refresh_token)
    magic_link = wait_for_magic_link(
        mailbox,
        not_before=requested_at,
        max_wait=max_wait,
    )
    try:
        callback = session.get(
            magic_link,
            allow_redirects=True,
            timeout=60,
        )
    except _HTTP_REQUEST_ERRORS as error:
        raise TensorArtError(f"打开 Tensor.Art 登录链接失败：{error}") from error
    responses = list(callback.history) + [callback]
    access_token = _extract_session_token(session, responses)
    if not access_token:
        raise TensorArtError("Tensor.Art 邮件链接已打开，但未取得 ta_token_prod")

    token_payload = decode_jwt_payload(access_token)
    token_device_id = str(token_payload.get("deviceId") or device_id)
    client = TensorArtClient(
        access_token,
        device_id=token_device_id,
        user_agent=resolved_user_agent,
    )
    profile = client.get_profile()
    user_id = str(
        profile.get("userId")
        or profile.get("id")
        or token_payload.get("userId")
        or ""
    )
    expires_at = int(token_payload.get("exp") or 0) * 1000
    return {
        "email": email_address,
        "access_token": access_token,
        "device_id": token_device_id,
        "user_agent": resolved_user_agent,
        "user_id": user_id,
        "expires_at": expires_at,
        "status": "active",
    }


def has_valid_token(account: dict) -> bool:
    token = str(account.get("access_token") or "").strip()
    if not token or str(account.get("status") or "active").lower() != "active":
        return False
    expires_at = int(account.get("expires_at") or 0)
    if not expires_at:
        expires_at = int(decode_jwt_payload(token).get("exp") or 0) * 1000
    return not expires_at or expires_at > int(time.time() * 1000) + 60_000


def _account_energy_balance(account: dict) -> int:
    client = TensorArtClient(
        account.get("access_token", ""),
        device_id=account.get("device_id", ""),
        user_agent=account.get("user_agent", ""),
    )
    energy = client.get_energy()
    value = energy.get("totalBalance")
    if value is None:
        value = energy.get("balance", energy.get("energy"))
    if value is None:
        value = sum(
            int(source.get("remainingAmount") or 0)
            for source in energy.get("sources", [])
            if isinstance(source, dict)
        )
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def pick_account(account_id: int = 0, min_credits: int = 0) -> dict:
    from .database import TaskDB, TensorArtAccountDB

    required_credits = max(0, int(min_credits or 0))
    if account_id:
        account = TensorArtAccountDB.get(int(account_id))
        if not account:
            raise TensorArtError("Tensor.Art 账号不存在", status_code=404)
        if not has_valid_token(account):
            raise TensorArtError("Tensor.Art 账号登录态已失效")
        if required_credits:
            balance = _account_energy_balance(account)
            if balance < required_credits:
                raise TensorArtError(
                    f"Tensor.Art 账号积分不足：需要 {required_credits}，当前 {balance}",
                    status_code=402,
                )
        return account

    candidates = [
        account
        for account in TensorArtAccountDB.list_all_internal()
        if has_valid_token(account)
    ]
    if not candidates:
        raise TensorArtError("渠道十没有可用账号，请先从邮箱库注册")
    candidates.sort(
        key=lambda account: (
            TaskDB.active_count_for_account(
                int(account.get("id") or 0),
                model_prefix="tensorart:",
            ),
            str(account.get("updated_at") or ""),
        )
    )
    if required_credits:
        unchecked: list[dict] = []
        highest_balance = 0
        for account in candidates:
            try:
                balance = _account_energy_balance(account)
            except TensorArtError:
                unchecked.append(account)
                continue
            highest_balance = max(highest_balance, balance)
            if balance >= required_credits:
                return account
        if unchecked:
            # 积分接口暂时不可用时保留原有容错，由创建接口返回真实业务错误。
            return unchecked[0]
        raise TensorArtError(
            f"渠道十所有账号积分不足：需要 {required_credits}，最高余额 {highest_balance}",
            status_code=402,
        )
    return candidates[0]
