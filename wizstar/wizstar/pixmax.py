"""Pixmax 视频生成 API 客户端 — OpenAI 兼容的图生视频接口

与 Wizstar 账号池模式不同，Pixmax 在服务端自管账号池和积分，
本地只需一个 Base URL + 一个 API Key 即可提交图生视频任务并轮询结果。

接口参考：EXTERNAL_API.md
  - POST /v1/video/generations  提交生成（异步）
  - GET  /v1/tasks/{task_id}    查询任务
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from .app_paths import get_wizstar_data_dir

import requests

# 默认地址来自对接文档；API Key 留空作为占位，由 config / 环境变量 / 设置界面覆盖。
DEFAULT_BASE_URL = "http://64.81.113.232:3211"
DEFAULT_API_KEY = ""  # TODO: 填入 sk-pixmax-xxxx，或通过环境变量 PIXMAX_API_KEY 注入
DEFAULT_MODELS = ["pixdance-2-fast", "pixdance-2"]

# 设置界面保存的本地配置文件（与 wizstar.db 同目录）。
CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "pixmax_config.json")

# 时长允许范围（秒），超出由服务端裁剪，这里做一次本地保护。
MIN_DURATION = 4
MAX_DURATION = 15

# 429（并发已达上限）时的自动重试策略：最多重试 N 次，指数退避。
RATE_LIMIT_MAX_RETRIES = 3
RATE_LIMIT_BACKOFF_BASE_S = 3


def _load_config() -> dict:
    """读取设置界面保存的本地配置；文件不存在或损坏时返回空字典。"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_config(api_key: str | None = None, base_url: str | None = None) -> dict:
    """保存 Pixmax 配置到本地文件。仅更新传入的非 None 字段。"""
    config = _load_config()
    if api_key is not None:
        config["api_key"] = api_key.strip()
    if base_url is not None:
        config["base_url"] = base_url.strip()
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


def get_base_url() -> str:
    """优先级：环境变量 > 本地配置文件 > 默认值"""
    env = os.environ.get("PIXMAX_BASE_URL", "").strip()
    if env:
        return env
    saved = _load_config().get("base_url", "").strip()
    return saved or DEFAULT_BASE_URL


def get_api_key() -> str:
    """优先级：环境变量 > 本地配置文件 > 默认值"""
    env = os.environ.get("PIXMAX_API_KEY", "").strip()
    if env:
        return env
    saved = _load_config().get("api_key", "").strip()
    return saved or DEFAULT_API_KEY


class PixmaxError(RuntimeError):
    """Pixmax 接口调用失败（含 HTTP 错误与业务错误）

    status_code: 对应的 HTTP 状态码（如 401/403/429/400），无则为 None。
    error_type: Pixmax 返回的 error.type（如 authentication_error/permission_error）。
    """

    def __init__(self, message: str, status_code: int | None = None, error_type: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.error_type = error_type


class PixmaxClient:
    """轻量 Pixmax 客户端：提交图生视频 + 查询任务状态"""

    def __init__(self, api_key: str | None = None, base_url: str | None = None, timeout: int = 60):
        self.api_key = (api_key or get_api_key()).strip()
        self.base_url = (base_url or get_base_url()).strip().rstrip("/")
        self.timeout = timeout

    def _headers(self) -> dict:
        if not self.api_key:
            raise PixmaxError("缺少 Pixmax API Key，请在系统设置中填写或配置环境变量 PIXMAX_API_KEY")
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _clamp_duration(duration: int) -> int:
        try:
            d = int(duration)
        except (TypeError, ValueError):
            d = 5
        return max(MIN_DURATION, min(MAX_DURATION, d))

    def create_video(
        self,
        prompt: str = "",
        image: str = "",
        images: list[str] | None = None,
        aliases: list[str] | None = None,
        model: str = "pixdance-2-fast",
        duration: int = 5,
        resolution: str = "",
        aspect_ratio: str = "",
    ) -> dict:
        """提交图生视频任务。

        Pixmax 是图生视频模式，必须提供至少 1 张图片（image 或 images）。
        返回 {"task_id": ..., "status": "pending", ...}
        """
        valid_images = [u for u in (images or []) if u]
        if not image and not valid_images:
            raise PixmaxError("Pixmax 为图生视频模式，必须提供至少 1 张输入图片")

        payload: dict = {
            "model": model,
            "prompt": prompt or "",
            "duration": self._clamp_duration(duration),
        }
        if valid_images:
            payload["images"] = valid_images
        else:
            payload["image"] = image
        valid_aliases = [a for a in (aliases or []) if a]
        if valid_aliases:
            payload["aliases"] = valid_aliases
        if resolution:
            payload["resolution"] = resolution
        if aspect_ratio:
            payload["aspect_ratio"] = aspect_ratio

        headers = self._headers()
        last_error: PixmaxError | None = None
        # 429（当前 Key 并发已达上限）做指数退避重试，其余错误立即抛出。
        for attempt in range(RATE_LIMIT_MAX_RETRIES + 1):
            try:
                resp = requests.post(
                    f"{self.base_url}/v1/video/generations",
                    headers=headers,
                    json=payload,
                    timeout=self.timeout,
                )
            except requests.RequestException as e:
                raise PixmaxError(f"请求 Pixmax 失败: {e}") from e

            data = self._parse_json(resp)
            if resp.status_code < 400:
                return data

            if resp.status_code == 429 and attempt < RATE_LIMIT_MAX_RETRIES:
                wait_s = self._retry_after_seconds(resp, attempt)
                last_error = self._build_error(data, resp.status_code)
                time.sleep(wait_s)
                continue

            raise self._build_error(data, resp.status_code)

        # 重试用尽仍是 429
        raise last_error or PixmaxError("Pixmax 并发已达上限，请稍后重试", status_code=429, error_type="rate_limit_error")

    def get_task(self, task_id: str) -> dict:
        """查询单个任务状态。

        返回标准化后的 {"status", "video_url", "error", "credits_cost", ...}
        status: pending / running / success / failed / not_found
        """
        try:
            resp = requests.get(
                f"{self.base_url}/v1/tasks/{task_id}",
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise PixmaxError(f"查询 Pixmax 任务失败: {e}") from e

        data = self._parse_json(resp)
        if resp.status_code >= 400:
            raise self._build_error(data, resp.status_code)
        return data

    def test_connection(self) -> dict:
        """验证地址可达 + API Key 有效。

        优先请求 /v1/models 获取模型列表；部分部署未开放该接口时，
        回退到 /v1/tasks 做鉴权连通性检查，并使用本地已知模型列表。
        """
        try:
            resp = requests.get(
                f"{self.base_url}/v1/models",
                headers=self._headers(),
                timeout=min(self.timeout, 15),
            )
        except requests.RequestException as e:
            raise PixmaxError(f"无法连接 Pixmax（{self.base_url}）: {e}") from e

        data = self._parse_json(resp)
        if resp.status_code < 400:
            models = [m.get("id") for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]
            return {"ok": True, "models": models or DEFAULT_MODELS}

        if resp.status_code == 404:
            self._probe_tasks_endpoint()
            return {"ok": True, "models": DEFAULT_MODELS, "note": "远端未开放 /v1/models，已通过任务接口完成鉴权测试"}

        raise self._build_error(data, resp.status_code)

    def _probe_tasks_endpoint(self) -> None:
        try:
            resp = requests.get(
                f"{self.base_url}/v1/tasks",
                headers=self._headers(),
                timeout=min(self.timeout, 15),
            )
        except requests.RequestException as e:
            raise PixmaxError(f"无法连接 Pixmax（{self.base_url}）: {e}") from e

        data = self._parse_json(resp)
        if resp.status_code >= 400:
            raise self._build_error(data, resp.status_code)

    @staticmethod
    def _parse_json(resp: requests.Response) -> dict:
        try:
            return resp.json()
        except ValueError:
            return {"_raw": resp.text}

    @staticmethod
    def _retry_after_seconds(resp: requests.Response, attempt: int) -> float:
        """优先采用响应头 Retry-After，否则按指数退避。"""
        header = resp.headers.get("Retry-After", "").strip()
        if header:
            try:
                return max(0.5, float(header))
            except ValueError:
                pass
        return RATE_LIMIT_BACKOFF_BASE_S * (2 ** attempt)

    @classmethod
    def _build_error(cls, data: dict, status_code: int) -> PixmaxError:
        """把 Pixmax 错误响应转成带状态码 + 友好中文的 PixmaxError。"""
        err = data.get("error") if isinstance(data, dict) else None
        error_type = ""
        message = ""
        if isinstance(err, dict):
            error_type = str(err.get("type") or "")
            message = str(err.get("message") or "")
        elif isinstance(err, str):
            message = err
        if not message:
            raw = data.get("_raw") if isinstance(data, dict) else None
            message = raw or f"Pixmax HTTP {status_code}"

        friendly = cls._friendly_message(status_code, error_type, message)
        return PixmaxError(friendly, status_code=status_code, error_type=error_type)

    @staticmethod
    def _friendly_message(status_code: int, error_type: str, message: str) -> str:
        """对常见状态码补充更易懂的中文说明，保留服务端原文。"""
        if status_code == 401:
            return f"Pixmax API Key 无效或缺失，请检查配置（{message}）"
        if status_code == 403:
            return f"Pixmax 拒绝访问：该 API Key 已被禁用或出片配额已用尽（{message}）"
        if status_code == 429:
            return f"Pixmax 并发已达上限，请稍后重试（{message}）"
        return message
