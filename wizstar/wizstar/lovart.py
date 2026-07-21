"""Lovart 渠道七纯协议客户端。"""

from __future__ import annotations

import base64
import email.utils
import hashlib
import hmac
import json
import mimetypes
import os
import random
import re
import string
import subprocess
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

import requests

from .database import LovartAccountDB

WWW_ORIGIN = "https://www.lovart.ai"
LGW_ORIGIN = "https://lgw.lovart.ai"
ARTIFACT_PREFIX = "https://a.lovart.ai/artifacts/"
ASSET_CDN_PREFIX = "https://assets-persist.lovart.ai/"
OSS_BUCKET = "models-online-persist-us"
OSS_HOST = f"{OSS_BUCKET}.oss-accelerate.aliyuncs.com"
OSS_BASE_URL = f"https://{OSS_HOST}"
STS_URL = f"{WWW_ORIGIN}/gateway/common-server-api/common-service/api/sts/v2/0"
DEFAULT_MODEL = "openai/gpt-image-2"
DEFAULT_QUALITY = "medium"
DEFAULT_MODELS = [
    {"id": DEFAULT_MODEL, "name": "GPT Image 2", "media_type": "image"},
]

_MODULE_DIR = Path(__file__).resolve().parent
_SIGNATURE_HELPER = _MODULE_DIR / "lovart_signature.js"
_WASM_CANDIDATES = [
    _MODULE_DIR.parent.parent / "tmp" / "lovart-network" / "26bd3a5bd74c3c92.wasm",
    _MODULE_DIR.parent.parent.parent / "tmp" / "lovart-network" / "26bd3a5bd74c3c92.wasm",
    Path(os.environ.get("LOVART_SIGNATURE_WASM", "")) if os.environ.get("LOVART_SIGNATURE_WASM") else None,
]


class LovartError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _clean_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def _node_bin() -> str:
    return os.environ.get("LOVART_NODE_BIN") or os.environ.get("DOLA_NODE_BIN") or os.environ.get("OIIOII_NODE_BIN") or "node"


def _wasm_path() -> str:
    for candidate in _WASM_CANDIDATES:
        if candidate and candidate.is_file():
            return str(candidate)
    raise LovartError("缺少 Lovart 签名 WASM，请确认 tmp/lovart-network/26bd3a5bd74c3c92.wasm 存在")


def _run_signature_helper(timestamp: str, req_uuid: str) -> str:
    if not _SIGNATURE_HELPER.is_file():
        raise LovartError("缺少 Lovart 签名 helper")
    try:
        result = subprocess.run(
            [_node_bin(), str(_SIGNATURE_HELPER), _wasm_path(), timestamp, req_uuid, "", ""],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            cwd=str(_MODULE_DIR),
        )
    except subprocess.TimeoutExpired as e:
        raise LovartError("Lovart 签名超时") from e
    except OSError as e:
        raise LovartError(f"无法执行 Lovart 签名 helper: {e}") from e
    if result.returncode != 0:
        raise LovartError((result.stderr or result.stdout or "Lovart 签名失败").strip())
    signature = (result.stdout or "").strip()
    if not signature.startswith("1:"):
        raise LovartError("Lovart 签名输出异常")
    return signature


def _cookie_header(account: dict) -> str:
    cookies = account.get("cookies") if isinstance(account.get("cookies"), list) else []
    parts: list[str] = []
    for cookie in cookies:
        if not isinstance(cookie, dict):
            continue
        name = _clean_str(cookie.get("name"))
        value = _clean_str(cookie.get("value"))
        if name and value:
            parts.append(f"{name}={value}")
    return "; ".join(parts)


def _storage_values(account: dict) -> list[Any]:
    values: list[Any] = []
    for key in ("local_storage", "session_storage"):
        storage = account.get(key)
        if isinstance(storage, dict):
            values.append(storage)
            values.extend(storage.values())
    indexed_db = account.get("indexed_db")
    if isinstance(indexed_db, list):
        values.extend(indexed_db)
    return values


def _walk_values(value: Any):
    if isinstance(value, dict):
        for item in value.values():
            yield from _walk_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_values(item)
    elif value is not None:
        yield value


def _normalize_field_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", _clean_str(value).lower())


def _cookie_value(account: dict, *names: str) -> str:
    wanted = {_normalize_field_name(name) for name in names}
    cookies = account.get("cookies") if isinstance(account.get("cookies"), list) else []
    for cookie in cookies:
        if not isinstance(cookie, dict):
            continue
        name = _normalize_field_name(cookie.get("name"))
        if name in wanted:
            return _clean_str(cookie.get("value"))
    return ""


def _jsonish(value: str) -> Any:
    text = _clean_str(value)
    if not text or text[0] not in "[{":
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def _walk_named_values(value: Any):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from _walk_named_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_named_values(item)
    elif isinstance(value, str):
        parsed = _jsonish(value)
        if parsed is not None:
            yield from _walk_named_values(parsed)


def _storage_named_value(account: dict, *names: str) -> str:
    wanted = {_normalize_field_name(name) for name in names}
    for root_key in ("local_storage", "session_storage", "indexed_db"):
        root = account.get(root_key)
        if not isinstance(root, (dict, list)):
            continue
        for key, value in _walk_named_values(root):
            if _normalize_field_name(key) not in wanted:
                continue
            candidate = _clean_str(value)
            if candidate:
                return candidate
    return ""


def _find_auth_token(account: dict) -> str:
    names = ("usertoken", "userToken", "user_token", "accessToken", "access_token")
    return _cookie_value(account, *names) or _storage_named_value(account, *names)


def has_auth_token(account: dict) -> bool:
    return bool(_find_auth_token(account))


def _decode_jwt_payload(token: str) -> dict:
    try:
        part = token.split(".")[1]
        part += "=" * ((4 - len(part) % 4) % 4)
        return json.loads(base64.urlsafe_b64decode(part.encode("ascii")).decode("utf-8"))
    except Exception:
        return {}


def _extract_user_uuid(account: dict) -> str:
    names = ("useruuid", "userUuid", "user_uuid", "uuid")
    direct = _cookie_value(account, *names) or _storage_named_value(account, *names)
    if direct:
        return direct
    token_payload = _decode_jwt_payload(_find_auth_token(account))
    for key in ("uuid", "useruuid", "user_uuid", "sub"):
        candidate = _clean_str(token_payload.get(key))
        if candidate:
            return candidate
    return ""


def _extract_project_id(account: dict, fallback: str = "") -> str:
    if fallback:
        return fallback
    for source in (account.get("location"),):
        text = _clean_str(source)
        if not text:
            continue
        try:
            parsed = urllib.parse.urlparse(text)
            project_id = urllib.parse.parse_qs(parsed.query).get("projectId", [""])[0]
            if project_id:
                return project_id
        except Exception:
            pass
    return ""


def _make_cid() -> str:
    suffix = "".join(random.choice(string.ascii_lowercase) for _ in range(8))
    return f"{int(time.time() * 1000)}{suffix}"


def _dimension_for_ratio(aspect_ratio: str, size: str = "") -> dict:
    explicit = re.match(r"^\s*(\d{3,5})\s*[x*]\s*(\d{3,5})\s*$", size or "")
    if explicit:
        width = int(explicit.group(1))
        height = int(explicit.group(2))
        return {"width": width, "height": height, "size": f"{width}*{height}", "ratio_label": aspect_ratio or f"{width}:{height}"}
    normalized = _clean_str(aspect_ratio, "16:9").lower().replace(" ", "")
    table = {
        "16:9": (2048, 1152, "16:9(2k)"),
        "9:16": (1152, 2048, "9:16(2k)"),
        "1:1": (2048, 2048, "1:1(2k)"),
        "4:3": (2048, 1536, "4:3(2k)"),
        "3:4": (1536, 2048, "3:4(2k)"),
        "21:9": (2048, 878, "21:9(2k)"),
    }
    width, height, label = table.get(normalized, table["16:9"])
    return {"width": width, "height": height, "size": f"{width}*{height}", "ratio_label": label}


def _normalize_status(status: str) -> str:
    value = _clean_str(status).lower()
    if value in {"completed", "success", "succeeded", "done"}:
        return "completed"
    if value in {"failed", "fail", "error", "canceled", "cancelled"}:
        return "failed"
    return "processing" if value else "pending"


def _first_artifact_url(data: dict) -> str:
    artifacts = data.get("artifacts")
    if isinstance(artifacts, list):
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            content = _clean_str(artifact.get("content") or artifact.get("url"))
            if content:
                return content
    for key in ("image_url", "url", "output_url"):
        value = _clean_str(data.get(key))
        if value:
            return value
    return ""


def _safe_json_response(resp: requests.Response) -> dict:
    try:
        return resp.json()
    except ValueError:
        return {"_raw": resp.text}


def _raise_for_lovart_response(resp: requests.Response, data: dict, action: str) -> None:
    if resp.status_code >= 400:
        message = data.get("message") or data.get("msg") or data.get("error") or resp.text
        raise LovartError(f"Lovart {action} 请求失败：HTTP {resp.status_code} {message}", resp.status_code)
    code = data.get("code")
    if code not in (None, 0):
        message = data.get("message") or data.get("msg") or data.get("error") or data
        raise LovartError(f"Lovart {action} 失败：{message}", 500)


class LovartClient:
    def __init__(self, account: dict, timeout: int = 180):
        if not account:
            raise LovartError("Lovart 账号不存在", 404)
        self.account = account
        self.timeout = timeout
        self.session = requests.Session()
        cookie = _cookie_header(account)
        user_agent = _clean_str(account.get("user_agent"), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36")
        self.base_headers = {
            "user-agent": user_agent,
            "accept": "application/json, text/plain, */*",
            "accept-language": "en",
            "referer": f"{WWW_ORIGIN}/",
            "origin": WWW_ORIGIN,
        }
        if cookie:
            self.base_headers["cookie"] = cookie
        token = _find_auth_token(account)
        if token:
            self.base_headers["token"] = token

    def _headers(self, *, signed: bool = False, json_body: bool = True, extra: dict | None = None) -> dict:
        headers = dict(self.base_headers)
        if json_body:
            headers["content-type"] = "application/json"
        if signed:
            timestamp = str(int(time.time() * 1000))
            req_uuid = uuid.uuid4().hex
            headers.update({
                "x-send-timestamp": timestamp,
                "x-req-uuid": req_uuid,
                "x-client-signature": _run_signature_helper(timestamp, req_uuid),
            })
        if extra:
            headers.update({k: v for k, v in extra.items() if v is not None})
        return headers

    def _post_json(self, url: str, payload: dict, *, signed: bool = False, action: str = "API") -> dict:
        try:
            resp = self.session.post(url, headers=self._headers(signed=signed), json=payload, timeout=self.timeout)
        except requests.RequestException as e:
            raise LovartError(f"Lovart {action} 请求异常：{e}") from e
        data = _safe_json_response(resp)
        _raise_for_lovart_response(resp, data, action)
        return data

    def _get_json(self, url: str, *, signed: bool = False, action: str = "API") -> dict:
        try:
            resp = self.session.get(url, headers=self._headers(signed=signed, json_body=False), timeout=self.timeout)
        except requests.RequestException as e:
            raise LovartError(f"Lovart {action} 请求异常：{e}") from e
        data = _safe_json_response(resp)
        _raise_for_lovart_response(resp, data, action)
        return data

    def list_models(self) -> dict:
        try:
            model_list = self._get_json(f"{LGW_ORIGIN}/v1/generator/list?biz_type=16", signed=True, action="模型列表")
            schema = self._get_json(f"{LGW_ORIGIN}/v1/generator/schema?biz_type=16", signed=True, action="模型 schema")
            return {"models": model_list.get("data") or DEFAULT_MODELS, "schema": schema.get("data") or schema}
        except LovartError:
            return {"models": DEFAULT_MODELS, "schema": {}}

    def pricing(self, payload: dict) -> dict:
        return self._post_json(f"{LGW_ORIGIN}/v1/generator/pricing", payload, signed=True, action="定价")

    def upload_link_artifact(self, project_id: str, artifact_content: str, cid: str = "", artifact_type: str = "image") -> str:
        payload = {
            "project_id": project_id,
            "artifact_type": artifact_type,
            "artifact_content": artifact_content,
        }
        if cid:
            payload["cid"] = cid
        data = self._post_json(f"{WWW_ORIGIN}/api/canva/agent/uploadLinkArtifacts", payload, signed=False, action="上传 artifact")
        artifact = data.get("artifact") if isinstance(data.get("artifact"), dict) else {}
        content = _clean_str(artifact.get("artifact_content"))
        return content or artifact_content

    def _get_sts(self) -> dict:
        data = self._get_json(STS_URL, signed=False, action="STS")
        sts = data.get("data") if isinstance(data.get("data"), dict) else {}
        for key in ("accessKeyId", "accessKeySecret", "securityToken"):
            if not _clean_str(sts.get(key)):
                raise LovartError("Lovart STS 返回缺少上传凭证")
        return sts

    def _put_oss(self, content: bytes, content_type: str, object_key: str) -> str:
        sts = self._get_sts()
        date = email.utils.formatdate(usegmt=True)
        oss_headers = {
            "x-oss-security-token": sts["securityToken"],
        }
        canonical_oss_headers = "".join(f"{k}:{v}\n" for k, v in sorted(oss_headers.items()))
        canonical_resource = f"/{OSS_BUCKET}/{object_key}"
        string_to_sign = f"PUT\n\n{content_type}\n{date}\n{canonical_oss_headers}{canonical_resource}"
        digest = hmac.new(
            sts["accessKeySecret"].encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha1,
        ).digest()
        signature = base64.b64encode(digest).decode("ascii")
        headers = {
            "date": date,
            "content-type": content_type,
            "authorization": f"OSS {sts['accessKeyId']}:{signature}",
            "x-oss-security-token": sts["securityToken"],
            "origin": WWW_ORIGIN,
            "referer": f"{WWW_ORIGIN}/",
            "user-agent": self.base_headers["user-agent"],
        }
        url = f"{OSS_BASE_URL}/{object_key}"
        try:
            resp = self.session.put(url, headers=headers, data=content, timeout=self.timeout)
        except requests.RequestException as e:
            raise LovartError(f"Lovart OSS 上传异常：{e}") from e
        if resp.status_code >= 400:
            raise LovartError(f"Lovart OSS 上传失败：HTTP {resp.status_code} {resp.text[:300]}", resp.status_code)
        return f"{ASSET_CDN_PREFIX}{object_key}"

    def upload_file_artifact(self, file_path: str, project_id: str, cid: str = "") -> str:
        path = Path(_clean_str(file_path))
        if not path.is_file():
            raise LovartError(f"本地图片不存在：{file_path}", 400)
        content = path.read_bytes()
        content_type = mimetypes.guess_type(str(path))[0] or "image/png"
        ext = mimetypes.guess_extension(content_type) or path.suffix or ".png"
        if ext == ".jpe":
            ext = ".jpg"
        user_uuid = _extract_user_uuid(self.account)
        if not user_uuid:
            raise LovartError("Lovart 登录态缺少 useruuid，无法上传本地图片，请重新采集渠道七账号")
        digest = hashlib.sha1(content).hexdigest()
        object_key = f"img/{user_uuid}/{digest}{ext}"
        asset_url = self._put_oss(content, content_type, object_key)
        return self.upload_link_artifact(project_id, asset_url, cid=cid, artifact_type="image")

    def upload_data_url_artifact(self, data_url: str, project_id: str, cid: str = "") -> str:
        match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", _clean_str(data_url), re.S)
        if not match:
            raise LovartError("图片 data URL 格式不正确", 400)
        content_type = match.group(1).lower()
        content = base64.b64decode(match.group(2), validate=True)
        ext = mimetypes.guess_extension(content_type) or ".png"
        user_uuid = _extract_user_uuid(self.account)
        if not user_uuid:
            raise LovartError("Lovart 登录态缺少 useruuid，无法上传本地图片，请重新采集渠道七账号")
        digest = hashlib.sha1(content).hexdigest()
        object_key = f"img/{user_uuid}/{digest}{ext}"
        asset_url = self._put_oss(content, content_type, object_key)
        return self.upload_link_artifact(project_id, asset_url, cid=cid, artifact_type="image")

    def normalize_reference_image(self, value: str, project_id: str, cid: str = "") -> str:
        clean = _clean_str(value)
        if not clean:
            return ""
        if clean.startswith(ARTIFACT_PREFIX):
            return clean
        if clean.startswith("data:image/"):
            return self.upload_data_url_artifact(clean, project_id, cid)
        if clean.startswith("file://"):
            clean = urllib.parse.unquote(urllib.parse.urlparse(clean).path)
        if os.path.isfile(clean):
            return self.upload_file_artifact(clean, project_id, cid)
        if clean.startswith("http://") or clean.startswith("https://"):
            return self.upload_link_artifact(project_id, clean, cid=cid, artifact_type="image")
        raise LovartError(f"不支持的 Lovart 参考图输入：{clean[:120]}", 400)

    def create_image(
        self,
        prompt: str,
        project_id: str = "",
        cid: str = "",
        model: str = DEFAULT_MODEL,
        aspect_ratio: str = "16:9",
        size: str = "",
        quality: str = DEFAULT_QUALITY,
        image_path: str = "",
        image_url: str = "",
        reference_images: list[str] | None = None,
        with_pricing: bool = False,
    ) -> dict:
        prompt = _clean_str(prompt)
        if not prompt:
            raise LovartError("请填写图片提示词", 400)
        project_id = _extract_project_id(self.account, _clean_str(project_id))
        if not project_id:
            raise LovartError("缺少 Lovart project_id，请从 Lovart 画布 URL 传入 projectId", 400)
        cid = _clean_str(cid) or _make_cid()
        model = _clean_str(model, DEFAULT_MODEL)
        quality = _clean_str(quality, DEFAULT_QUALITY)
        dims = _dimension_for_ratio(aspect_ratio, size)

        refs: list[str] = []
        for raw in [image_path, image_url, *(reference_images or [])]:
            artifact = self.normalize_reference_image(raw, project_id, cid) if _clean_str(raw) else ""
            if artifact and artifact not in refs:
                refs.append(artifact)

        original_unit_data = {
            "w": dims["width"],
            "h": dims["height"],
            "title": "Image Generator",
            "name": "Image Generator 1",
            "fillColor": "#E6E6E6",
            "generatorName": model,
            "prompt": prompt,
            "ratio": dims["ratio_label"],
            "configWidth": dims["width"],
            "configHeight": dims["height"],
            "quality": quality,
            "count": 1,
            "image": [{"type": "image", "url": url} for url in refs],
            "isAdaptiveSize": False,
            "generator_name": model,
            "width": dims["width"],
            "height": dims["height"],
        }
        input_args = {
            "width": dims["width"],
            "height": dims["height"],
            "prompt": prompt,
            "quality": quality,
            "size": dims["size"],
            "n": 1,
            "original_unit_data": original_unit_data,
        }
        if refs:
            input_args["image"] = refs

        generator_payload = {
            "cid": cid,
            "project_id": project_id,
            "generator_name": model,
            "input_args": input_args,
        }
        pricing_data = None
        if with_pricing:
            pricing_payload = {"generator_name": model, "input_args": input_args}
            pricing_data = self.pricing(pricing_payload)

        data = self._post_json(f"{LGW_ORIGIN}/v1/generator/tasks", generator_payload, signed=True, action="创建任务")
        task_data = data.get("data") if isinstance(data.get("data"), dict) else {}
        task_id = _clean_str(task_data.get("generator_task_id") or task_data.get("task_id"))
        if not task_id:
            raise LovartError("Lovart 未返回任务 ID")
        return {
            "task_id": task_id,
            "status": _normalize_status(task_data.get("status") or "submitted"),
            "media_type": "image",
            "image_url": _first_artifact_url(task_data),
            "video_url": _first_artifact_url(task_data),
            "project_id": project_id,
            "cid": cid,
            "model": model,
            "quality": quality,
            "size": dims["size"],
            "reference_images": refs,
            "pricing": pricing_data.get("data") if isinstance(pricing_data, dict) else None,
            "raw": data,
        }

    def get_task_status(self, task_id: str) -> dict:
        clean_id = _clean_str(task_id)
        if not clean_id:
            raise LovartError("缺少 Lovart task_id", 400)
        query = urllib.parse.urlencode({"task_id": clean_id})
        data = self._get_json(f"{LGW_ORIGIN}/v1/generator/tasks?{query}", signed=True, action="查询任务")
        task_data = data.get("data") if isinstance(data.get("data"), dict) else {}
        status = _normalize_status(task_data.get("status"))
        image_url = _first_artifact_url(task_data)
        queue_info = task_data.get("queue_info") if isinstance(task_data.get("queue_info"), dict) else {}
        fail_reason = _clean_str(task_data.get("fail_reason") or task_data.get("error") or task_data.get("message"))
        return {
            "task_id": clean_id,
            "status": status,
            "image_url": image_url,
            "video_url": image_url,
            "media_type": "image",
            "fail_reason": fail_reason,
            "queue_position": queue_info.get("position"),
            "remaining_seconds": queue_info.get("remaining_time_seconds"),
            "estimated_wait_seconds": queue_info.get("remaining_time_seconds"),
            "model": task_data.get("generator_name") or "",
            "raw": data,
        }


def pick_account(account_id: int = 0) -> dict:
    if account_id:
        account = LovartAccountDB.get(account_id)
        if not account:
            raise LovartError("lovart account not found", 404)
        if account.get("status") != "active" or not has_auth_token(account):
            raise LovartError("Lovart 账号未激活或缺少 usertoken，请重新采集渠道七账号", 400)
        return account
    accounts = LovartAccountDB.list_all()
    active = [account for account in accounts if account.get("status") == "active" and has_auth_token(account)]
    if not active:
        raise LovartError("请先采集包含 usertoken 的渠道七 Lovart 登录态", 400)
    active.sort(key=lambda account: (float(account.get("updated_at") or 0), int(account.get("id") or 0)))
    return active[0]


def create_image(account: dict, **kwargs) -> dict:
    return LovartClient(account).create_image(**kwargs)


def get_task_status(account: dict, task_id: str) -> dict:
    return LovartClient(account).get_task_status(task_id)


def models(account: dict | None = None) -> dict:
    if account:
        return LovartClient(account).list_models()
    return {"models": DEFAULT_MODELS, "schema": {}}