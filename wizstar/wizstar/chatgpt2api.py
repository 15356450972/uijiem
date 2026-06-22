"""ChatGPT2API 图片生成通道客户端。

对接 OpenAI 兼容图片接口：
- POST /v1/images/generations 文生图
- POST /v1/images/edits 图生图 / 图片编辑
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
from pathlib import Path

import requests

from .app_paths import get_wizstar_data_dir

DEFAULT_BASE_URL = "http://64.81.113.232:3000"
DEFAULT_API_KEY = ""
DEFAULT_MODEL = "gpt-image-2"
CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "chatgpt2api_config.json")
TASK_TTL_SECONDS = 60 * 60 * 6
_task_cache: dict[str, dict] = {}


class ChatGPT2APIError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_config(api_key: str | None = None, base_url: str | None = None) -> dict:
    config = _load_config()
    if api_key is not None:
        config["api_key"] = api_key.strip()
    if base_url is not None:
        config["base_url"] = base_url.strip().rstrip("/")
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


def get_base_url() -> str:
    env = os.environ.get("CHATGPT2API_BASE_URL", "").strip()
    if env:
        return env.rstrip("/")
    saved = _load_config().get("base_url", "").strip()
    return (saved or DEFAULT_BASE_URL).rstrip("/")


def get_api_key() -> str:
    env = os.environ.get("CHATGPT2API_API_KEY", "").strip()
    if env:
        return env
    saved = _load_config().get("api_key", "").strip()
    return saved or DEFAULT_API_KEY


def _image_path_to_data_uri(file_path: str) -> str:
    clean_path = (file_path or "").strip()
    if not clean_path:
        return ""
    if not os.path.isfile(clean_path):
        raise ChatGPT2APIError(f"本地图片文件不存在: {clean_path}", status_code=400)
    mime, _ = mimetypes.guess_type(clean_path)
    if not mime:
        mime = "image/png"
    with open(clean_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _normalize_image_input(value: str) -> str:
    clean = (value or "").strip()
    if not clean:
        return ""
    if clean.startswith("data:image/") or clean.startswith("http://") or clean.startswith("https://"):
        return clean
    if clean.startswith("file://"):
        try:
            clean = Path(clean.replace("file://", "")).as_posix()
        except Exception:
            clean = clean.replace("file://", "")
    if os.path.isfile(clean):
        return _image_path_to_data_uri(clean)
    return clean


def _first_image_url(data: dict) -> str:
    items = data.get("data") or []
    if not isinstance(items, list) or not items:
        return ""
    first = items[0] if isinstance(items[0], dict) else {}
    if first.get("url"):
        return first["url"]
    if first.get("b64_json"):
        return "data:image/png;base64," + first["b64_json"]
    return ""


def _cleanup_task_cache() -> None:
    now = time.time()
    expired = [task_id for task_id, item in _task_cache.items() if now - float(item.get("created_at", now)) > TASK_TTL_SECONDS]
    for task_id in expired:
        _task_cache.pop(task_id, None)


def _normalize_image_size(size: str) -> str:
    clean = (size or "").strip()
    ratio_size_map = {
        "1:1": "1024x1024",
        "16:9": "1536x1024",
        "4:3": "1536x1024",
        "9:16": "1024x1536",
        "3:4": "1024x1536",
    }
    if clean in ratio_size_map:
        return ratio_size_map[clean]
    allowed_sizes = {"1024x1024", "1536x1024", "1024x1536", "auto"}
    return clean if clean in allowed_sizes else "auto"


class ChatGPT2APIClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None, timeout: int = 180):
        self.api_key = (api_key or get_api_key()).strip()
        self.base_url = (base_url or get_base_url()).strip().rstrip("/")
        self.timeout = timeout

    def _headers(self) -> dict:
        if not self.api_key:
            raise ChatGPT2APIError("缺少 ChatGPT2API API Key，请在系统设置中填写或配置环境变量 CHATGPT2API_API_KEY")
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def test_connection(self) -> dict:
        try:
            resp = requests.get(f"{self.base_url}/v1/models", headers=self._headers(), timeout=15)
        except requests.RequestException as e:
            raise ChatGPT2APIError(f"无法连接 ChatGPT2API（{self.base_url}）: {e}") from e
        data = self._parse_json(resp)
        if resp.status_code >= 400:
            raise self._build_error(data, resp.status_code)
        models = [m.get("id") for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]
        return {"ok": True, "models": models or [DEFAULT_MODEL]}

    def create_image(
        self,
        prompt: str,
        model: str = DEFAULT_MODEL,
        size: str = "16:9",
        resolution: str = "2K",
        image_url: str = "",
        image_path: str = "",
        reference_images: list[str] | None = None,
    ) -> dict:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ChatGPT2APIError("请填写图片提示词", status_code=400)

        images = [_normalize_image_input(x) for x in (reference_images or []) if _normalize_image_input(x)]
        if image_url:
            images.insert(0, image_url)
        if image_path:
            images.insert(0, _image_path_to_data_uri(image_path))

        payload = {
            "prompt": prompt,
            "model": model or DEFAULT_MODEL,
            "response_format": "url",
        }
        normalized_size = _normalize_image_size(size)
        if normalized_size:
            payload["size"] = normalized_size
        if resolution:
            payload["resolution"] = resolution

        endpoint = "/v1/images/edits" if images else "/v1/images/generations"
        if images:
            payload["images"] = images
        else:
            payload["n"] = 1

        try:
            resp = requests.post(
                f"{self.base_url}{endpoint}",
                headers=self._headers(),
                json=payload,
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise ChatGPT2APIError(f"请求 ChatGPT2API 生图失败: {e}") from e

        data = self._parse_json(resp)
        if resp.status_code >= 400:
            raise self._build_error(data, resp.status_code)

        task_id = f"chatgpt2api-{int(time.time() * 1000)}"
        image = _first_image_url(data)
        if not image:
            raise ChatGPT2APIError("ChatGPT2API 未返回图片 URL 或 base64 数据")
        _cleanup_task_cache()
        _task_cache[task_id] = {
            "task_id": task_id,
            "status": "completed",
            "image_url": image,
            "video_url": image,
            "media_type": "image",
            "raw": data,
            "created_at": time.time(),
        }
        return {"task_id": task_id, "status": "completed", "image_url": image, "media_type": "image"}

    def get_task_status(self, task_id: str) -> dict:
        _cleanup_task_cache()
        item = _task_cache.get(task_id)
        if not item:
            return {"task_id": task_id, "status": "failed", "error": "本地任务缓存不存在或已过期", "media_type": "image"}
        return item

    @staticmethod
    def _parse_json(resp: requests.Response) -> dict:
        try:
            return resp.json()
        except ValueError:
            return {"_raw": resp.text}

    @staticmethod
    def _build_error(data: dict, status_code: int) -> ChatGPT2APIError:
        msg = ""
        detail = data.get("detail")
        if isinstance(detail, dict):
            msg = detail.get("error") or detail.get("message") or ""
        elif isinstance(detail, str):
            msg = detail
        error = data.get("error")
        if not msg and isinstance(error, dict):
            msg = error.get("message") or ""
        if not msg:
            msg = data.get("_raw") or f"HTTP {status_code}"
        return ChatGPT2APIError(msg, status_code=status_code)
