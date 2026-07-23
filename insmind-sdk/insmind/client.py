"""insMind 主客户端：素材上传 + Seedance 生成 + 轮询。"""

from __future__ import annotations

import json
import mimetypes
import time
import uuid
from pathlib import Path
from typing import Any, Optional, Sequence, Union
from urllib.parse import quote

from . import constants as C
from .aws_sigv4 import put_object
from .http import ApiError, request
from .tenant import ensure_tenant

PathLike = Union[str, Path]


class InsMindClient:
    def __init__(
        self,
        access_token: str,
        *,
        channel_id: str = C.CHANNEL_ID,
        product_type: str = C.PRODUCT_TYPE,
        device_id: Optional[str] = None,
        user_id: Optional[str] = None,
        poll_interval: int = C.DEFAULT_POLL_INTERVAL,
        poll_timeout: int = C.DEFAULT_POLL_TIMEOUT,
        cookie: Optional[str] = None,
        auto_ensure_tenant: bool = False,
    ) -> None:
        if not access_token:
            raise ValueError("access_token is required")
        self.access_token = access_token
        self.channel_id = str(channel_id)
        self.product_type = product_type
        self.device_id = device_id or uuid.uuid4().hex
        self.user_id = user_id
        self.poll_interval = poll_interval
        self.poll_timeout = poll_timeout
        self.cookie = cookie or ""
        self.org_id: Optional[str] = None
        self._repository_id: Optional[str] = None
        if auto_ensure_tenant:
            self.ensure_tenant()

    def ensure_tenant(self) -> dict:
        info = ensure_tenant(self.access_token, channel_id=self.channel_id)
        self.org_id = str(info["org_id"])
        self.cookie = info.get("cookie") or self.cookie
        return info

    def _headers(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Authorization": f"Bearer {self.access_token}",
            "Origin": C.WEB_ORIGIN,
            "Referer": f"{C.WEB_ORIGIN}/",
            "x-channel-id": self.channel_id,
            "x-product-type": self.product_type,
        }
        if self.cookie:
            headers["Cookie"] = self.cookie
        if self.user_id:
            headers["x-user-id"] = str(self.user_id)
        if extra:
            headers.update(extra)
        return headers

    def _api(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        headers: Optional[dict[str, str]] = None,
        timeout: int = 60,
    ) -> Any:
        resp = request(
            f"{C.WEB_ORIGIN}{path}",
            method=method,
            headers=self._headers(headers),
            body=body,
            timeout=timeout,
        )
        if resp["status"] >= 400:
            raise ApiError(
                f"{method} {path} failed: {resp.get('text', '')[:400]}",
                resp["status"],
                resp.get("json"),
            )
        return resp.get("json")

    # ------------------------------------------------------------------ #
    # 仓库 / 内容 ID
    # ------------------------------------------------------------------ #
    def list_repositories(self) -> list[dict]:
        data = self._api("GET", "/api/tb-dam/repositories")
        return data if isinstance(data, list) else []

    def personal_repository_id(self) -> str:
        if self._repository_id:
            return self._repository_id
        repos = self.list_repositories()
        for item in repos:
            if item.get("type") == 1 or item.get("name") in ("个人库", "Personal"):
                self._repository_id = str(item["repository_id"])
                return self._repository_id
        if repos:
            self._repository_id = str(repos[0]["repository_id"])
            return self._repository_id
        raise ApiError("no repository found; account may need tenant binding on www.insmind.com")

    def new_content_id(self) -> str:
        data = self._api("POST", "/api/tb-dam/asset/id", body={})
        return str(data["id"])

    # ------------------------------------------------------------------ #
    # 上传
    # ------------------------------------------------------------------ #
    def get_upload_token(
        self,
        content_id: str,
        *,
        fmt: str,
        directory: str = "",
    ) -> dict:
        return self._api(
            "POST",
            "/api/tb-dam/asset/upload/tokens",
            body={
                "format": fmt,
                "content_id": str(content_id),
                "dir": directory,
                "device_id": self.device_id,
                "is_cname": False,
            },
        )

    def upload_file(
        self,
        file_path: PathLike,
        *,
        content_id: Optional[str] = None,
        register_asset: bool = True,
        title: Optional[str] = None,
        repository_id: Optional[str] = None,
    ) -> dict:
        """上传本地文件到 DAM，返回 {content_id, url, size, title, format}。"""
        path = Path(file_path)
        if not path.is_file():
            raise FileNotFoundError(path)
        data = path.read_bytes()
        ext = path.suffix.lstrip(".").lower() or "bin"
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        cid = content_id or self.new_content_id()
        token = self.get_upload_token(cid, fmt=ext)
        put_object(
            endpoint=token.get("accelerate_endpoint") or token["endpoint"],
            bucket=token["bucket_name"],
            object_name=token["object_name"],
            access_key_id=token["access_key_id"],
            access_key_secret=token["access_key_secret"],
            session_token=token["security_token"],
            region=token.get("region") or "oss-us-east-1",
            body=data,
            content_type=ctype,
        )
        host = (token.get("host") or "").rstrip("/")
        url = f"{host}/{token['object_name']}"
        result = {
            "content_id": cid,
            "url": url,
            "size": len(data),
            "title": title or path.name,
            "format": ext,
            "object_name": token["object_name"],
            "bucket": token["bucket_name"],
        }
        if register_asset and ext in {"png", "jpg", "jpeg", "webp", "gif"}:
            repo = repository_id or self.personal_repository_id()
            self._api(
                "POST",
                "/api/tb-dam/asset",
                body={
                    "asset_info": {
                        "id": cid,
                        "origin_url": url,
                        "size": len(data),
                        "title": result["title"],
                    },
                    "folder_id": "0",
                    "repository_id": str(repo),
                    "storage_format": "gdpic",
                },
            )
            result["repository_id"] = str(repo)
        return result

    # ------------------------------------------------------------------ #
    # Seedance 生成
    # ------------------------------------------------------------------ #
    def call_async(self, model: str, arguments: dict) -> str:
        payload = {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "tools/call",
            "params": {"name": model, "arguments": arguments},
        }
        data = self._api(
            "POST",
            "/api/gdesign/tool/v1/dify/call_async",
            body=payload,
            headers={"Referer": f"{C.WEB_ORIGIN}/editor/canvas"},
            timeout=60,
        )
        if isinstance(data, dict) and data.get("error"):
            err = data["error"]
            raise ApiError(f"call_async error: {err}", body=data)
        task_id = data.get("task_id") if isinstance(data, dict) else None
        if not task_id:
            raise ApiError(f"call_async missing task_id: {data}")
        return str(task_id)

    def process_batch(self, task_ids: Sequence[str]) -> list[dict]:
        data = self._api(
            "POST",
            "/api/gdesign/tool/v1/dify/process/batch",
            body={"task_ids": list(task_ids)},
            headers={"Referer": f"{C.WEB_ORIGIN}/editor/canvas"},
            timeout=60,
        )
        return data if isinstance(data, list) else []

    @staticmethod
    def parse_process_result(item: dict) -> dict:
        """解析 process/batch 单条，返回 {task_id, done, error, video_url, raw}。"""
        task_id = item.get("task_id")
        raw_result = item.get("result")
        parsed: dict = {}
        if isinstance(raw_result, str):
            try:
                parsed = json.loads(raw_result)
            except ValueError:
                parsed = {"raw": raw_result}
        elif isinstance(raw_result, dict):
            parsed = raw_result
        result = parsed.get("result") if isinstance(parsed, dict) else None
        video_url = ""
        is_error = False
        if isinstance(result, dict):
            is_error = bool(result.get("isError"))
            for content in result.get("content") or []:
                resource = (content or {}).get("resource") or {}
                uri = resource.get("uri") or ""
                mime = (resource.get("mimeType") or "").lower()
                if uri and ("mp4" in mime or uri.endswith(".mp4")):
                    video_url = uri
                    break
                if uri and not video_url:
                    video_url = uri
        done = bool(video_url) or is_error
        return {
            "task_id": task_id,
            "done": done,
            "error": is_error,
            "video_url": video_url,
            "code": item.get("code"),
            "message": item.get("message"),
            "raw": parsed,
        }

    def wait_task(self, task_id: str, *, timeout: Optional[int] = None, interval: Optional[int] = None) -> dict:
        timeout = timeout if timeout is not None else self.poll_timeout
        interval = interval if interval is not None else self.poll_interval
        deadline = time.time() + timeout
        last: dict = {}
        while time.time() < deadline:
            batch = self.process_batch([task_id])
            if batch:
                last = self.parse_process_result(batch[0])
                if last.get("done"):
                    if last.get("error"):
                        raise ApiError(f"generation failed: {last}")
                    return last
            time.sleep(interval)
        raise TimeoutError(f"task {task_id} not finished within {timeout}s; last={last}")

    def generate_omni(
        self,
        *,
        prompt: str,
        image_urls: Sequence[str],
        audio_urls: Optional[Sequence[str]] = None,
        content_id: Optional[str] = None,
        model: str = C.MODEL_SEEDANCE_MINI,
        resolution: str = "480P",
        duration: str = "5",
        ratio: str = "original",
        audio_enabled: bool = True,
        wait: bool = True,
    ) -> dict:
        """全能参考模式（omni_reference）。image_urls/audio_urls 顺序对应 [imageN]/[audioN]。"""
        cid = content_id or self.new_content_id()
        arguments = {
            "mode": "omni_reference",
            "audioEnabled": "on" if audio_enabled else "off",
            "resolution": resolution,
            "duration": str(duration),
            "ratio": ratio,
            "prompt": prompt,
            "image_urls": json.dumps(list(image_urls), ensure_ascii=False),
            "audio_urls": json.dumps(list(audio_urls or []), ensure_ascii=False),
            "content_id": str(cid),
        }
        task_id = self.call_async(model, arguments)
        result = {"task_id": task_id, "content_id": str(cid), "arguments": arguments}
        if wait:
            done = self.wait_task(task_id)
            result.update(done)
        return result

    def generate_start_end_frame(
        self,
        *,
        prompt: str,
        start_frame: str,
        content_id: Optional[str] = None,
        model: str = C.MODEL_SEEDANCE_MINI,
        resolution: str = "480P",
        duration: str = "5",
        ratio: str = "16:9",
        audio_enabled: bool = True,
        wait: bool = True,
    ) -> dict:
        cid = content_id or self.new_content_id()
        arguments = {
            "mode": "start_end_frame",
            "audioEnabled": "on" if audio_enabled else "off",
            "resolution": resolution,
            "duration": str(duration),
            "ratio": ratio,
            "start_frame": start_frame,
            "prompt": prompt,
            "content_id": str(cid),
        }
        task_id = self.call_async(model, arguments)
        result = {"task_id": task_id, "content_id": str(cid), "arguments": arguments}
        if wait:
            done = self.wait_task(task_id)
            result.update(done)
        return result

    def activity_skus(self, model: str = C.MODEL_SEEDANCE_MINI) -> list[dict]:
        path = f"/api/mns/models/activity-skus-by-models?model_codes={quote(model)}"
        data = self._api("GET", path)
        return data if isinstance(data, list) else []
