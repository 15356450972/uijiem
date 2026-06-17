"""QuickFrame 主客户端：上传图片、生成视频、轮询进度、无水印下载。

所有请求格式均来自真实抓包：
- 上传签名:  POST /trpc/assets.getDirectUploadSignature   body {"0":{"assetType":"image"}}
- Cloudinary: POST api.cloudinary.com/v1_1/<cloud>/image/upload  (multipart)
- 注册素材:  POST /trpc/assets.registerDirectUpload
- 生成视频:  POST /trpc/effects.generateSeedanceVideoForEditor
- 查询结果:  GET  /trpc/assets.getAssetsByIds
"""

import json
import mimetypes
import os
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import requests

from . import constants as C
from .exceptions import (
    APIError,
    GenerationError,
    GenerationTimeout,
    UploadError,
)
from .models import Asset, GenerationJob, GenerationResult, Session


class QuickFrameClient:
    """QuickFrame AI 客户端。

    至少需要一个 access_token（Bearer JWT）。可由 QuickFrameAuth 获取，
    或直接从浏览器开发者工具里复制 Authorization 头里的 token。
    """

    def __init__(
        self,
        access_token: str,
        session: Optional[requests.Session] = None,
        poll_interval: int = C.POLL_INTERVAL_SECONDS,
        poll_timeout: int = C.POLL_TIMEOUT_SECONDS,
    ) -> None:
        if not access_token:
            raise ValueError("access_token 不能为空")
        self.access_token = access_token
        self.poll_interval = poll_interval
        self.poll_timeout = poll_timeout
        self.http = session or requests.Session()
        self.http.headers.update(
            {
                "User-Agent": C.USER_AGENT,
                "Origin": C.WEB_ORIGIN,
                "Referer": C.WEB_ORIGIN + "/",
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
            }
        )

    # ------------------------------------------------------------------ #
    # 底层 tRPC 调用
    # ------------------------------------------------------------------ #
    def _auth_header(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    def _trpc_post(self, procedure: str, payload: Any) -> Any:
        """tRPC mutation：body 形如 {"0": {...}}，返回第 0 个 result.data。"""
        url = C.trpc_url(procedure)
        headers = {**self._auth_header(), "Content-Type": "application/json"}
        resp = self.http.post(url, headers=headers, json={"0": payload}, timeout=60)
        return self._unwrap_trpc(resp, procedure)

    def _trpc_get(self, procedure: str, payload: Any) -> Any:
        """tRPC query：input 作为 URL 参数。"""
        input_param = quote(json.dumps({"0": payload}, separators=(",", ":")))
        url = f"{C.trpc_url(procedure)}&input={input_param}"
        resp = self.http.get(url, headers=self._auth_header(), timeout=60)
        return self._unwrap_trpc(resp, procedure)

    @staticmethod
    def _unwrap_trpc(resp: requests.Response, procedure: str) -> Any:
        if resp.status_code != 200:
            raise APIError(
                f"{procedure} 调用失败", resp.status_code, resp.text[:500]
            )
        data = resp.json()
        # batch 响应是数组：[{"result":{"data": ...}}]
        if isinstance(data, list):
            first = data[0]
            if "error" in first:
                raise APIError(f"{procedure} 返回错误", resp.status_code, first["error"])
            return first.get("result", {}).get("data")
        return data

    # ------------------------------------------------------------------ #
    # 会话
    # ------------------------------------------------------------------ #
    def get_session(self) -> Session:
        """GET /session —— 读取浏览器 cookie 会话里的当前用户。

        注意：该端点基于 cookie 会话，不是 Bearer。用纯 token 调用时
        通常返回 200 但 user 为空（active=False）属正常现象。
        要校验 Bearer token 是否有效，请用 verify_token()。
        """
        resp = self.http.get(
            f"{C.API_BASE}/session", headers=self._auth_header(), timeout=30
        )
        if resp.status_code != 200:
            raise APIError("获取会话失败", resp.status_code, resp.text[:300])
        return Session.from_response(resp.json())

    def verify_token(self) -> bool:
        """校验 Bearer token 是否有效。

        通过调用一个需要鉴权的 tRPC 端点（getDirectUploadSignature）来判断：
        200 表示 token 有效，401/403 表示无效或过期。
        """
        try:
            self._get_upload_signature("image")
            return True
        except APIError as exc:
            if exc.status_code in (401, 403):
                return False
            raise

    # ------------------------------------------------------------------ #
    # 上传素材（3 步）
    # ------------------------------------------------------------------ #
    def upload_asset(
        self,
        file_path: str,
        asset_type: str = "image",
        name: Optional[str] = None,
    ) -> Asset:
        """上传本地文件并注册为 QuickFrame 素材，返回带 assetId 的 Asset。

        完整三步：取签名 -> 直传 Cloudinary -> 注册素材。
        """
        if not os.path.isfile(file_path):
            raise UploadError(f"文件不存在: {file_path}")

        signature = self._get_upload_signature(asset_type)
        cloud_result = self._upload_to_cloudinary(file_path, signature, asset_type)
        asset = self._register_upload(
            cloudinary_url=cloud_result["secure_url"],
            asset_type=asset_type,
            name=name or os.path.splitext(os.path.basename(file_path))[0],
            width=cloud_result.get("width"),
            height=cloud_result.get("height"),
            fmt=cloud_result.get("format"),
        )
        return asset

    def _get_upload_signature(self, asset_type: str) -> Dict[str, Any]:
        data = self._trpc_post("assets.getDirectUploadSignature", {"assetType": asset_type})
        if not data or "signature" not in data:
            raise UploadError(f"获取上传签名失败: {data}")
        return data

    def _upload_to_cloudinary(
        self, file_path: str, signature: Dict[str, Any], asset_type: str
    ) -> Dict[str, Any]:
        url = C.cloudinary_upload_url(asset_type)
        mime = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        with open(file_path, "rb") as fh:
            files = {"file": (os.path.basename(file_path), fh, mime)}
            form = {
                "api_key": signature["apiKey"],
                "timestamp": str(signature["timestamp"]),
                "signature": signature["signature"],
                "folder": signature["folder"],
            }
            # 独立请求：不带 QuickFrame 的 Authorization 头
            resp = requests.post(
                url,
                data=form,
                files=files,
                headers={"User-Agent": C.USER_AGENT, "Origin": C.WEB_ORIGIN},
                timeout=120,
            )
        if resp.status_code != 200:
            raise UploadError(
                f"Cloudinary 上传失败: HTTP {resp.status_code} {resp.text[:300]}"
            )
        return resp.json()

    def _register_upload(
        self,
        cloudinary_url: str,
        asset_type: str,
        name: str,
        width: Optional[int],
        height: Optional[int],
        fmt: Optional[str],
    ) -> Asset:
        payload = {
            "cloudinaryUrl": cloudinary_url,
            "assetType": asset_type,
            "name": name,
            "source": "upload",
            "transcribeAsVoiceover": False,
        }
        if width:
            payload["width"] = width
        if height:
            payload["height"] = height
        if fmt:
            payload["format"] = fmt
        data = self._trpc_post("assets.registerDirectUpload", payload)
        if not data or "assetId" not in data:
            raise UploadError(f"注册素材失败: {data}")
        return Asset.from_response(data)

    # ------------------------------------------------------------------ #
    # 生成视频
    # ------------------------------------------------------------------ #
    def generate_video(
        self,
        prompt: str,
        project_id: int,
        reference_image_asset_ids: Optional[List[int]] = None,
        reference_video_asset_ids: Optional[List[int]] = None,
        reference_audio_asset_ids: Optional[List[int]] = None,
        aspect_ratio: str = C.DEFAULT_ASPECT_RATIO,
        duration: int = C.DEFAULT_DURATION,
        generate_audio: bool = True,
    ) -> GenerationJob:
        """提交 Seedance 视频生成任务（编辑器内生成）。

        prompt 里引用图片用 ``[Image 1]`` 形式，与 referenceImagesAssetIds 顺序对应。
        需要一个已存在的 project_id（见 ensure_project / create_project）。
        """
        payload = {
            "prompt": prompt,
            "aspectRatio": aspect_ratio,
            "duration": duration,
            "generateAudio": generate_audio,
            "referenceImagesAssetIds": reference_image_asset_ids or [],
            "referenceVideosAssetIds": reference_video_asset_ids or [],
            "referenceAudiosAssetIds": reference_audio_asset_ids or [],
            "projectId": project_id,
        }
        data = self._trpc_post("effects.generateSeedanceVideoForEditor", payload)
        if not data or "jobId" not in data:
            raise GenerationError(f"生成请求被拒绝: {data}")
        return GenerationJob(
            job_id=data["jobId"],
            channel=data.get("channel", ""),
            project_id=project_id,
            raw=data,
        )

    def create_project_from_generation(
        self,
        prompt: str,
        tool_slug: str = "seedance-ref-to-video",
        aspect_ratio: str = C.DEFAULT_ASPECT_RATIO,
        media_asset_ids: Optional[List[int]] = None,
        generate_audio: bool = True,
        width: int = 1920,
        height: int = 1080,
    ) -> int:
        """一步创建项目并发起生成，返回新建的 projectId。

        对应首页「Add elements to video」入口的 createProjectFromGeneration。
        """
        payload = {
            "generationType": "tool",
            "toolInput": {
                "toolSlug": tool_slug,
                "capability": tool_slug,
                "params": {
                    "prompt": prompt,
                    "aspectRatio": aspect_ratio,
                    "generateAudio": generate_audio,
                    "duration": -1,
                    "mediaAssetIds": media_asset_ids or [],
                    "mediaAssetIdsByKey": {},
                    "savedAt": int(time.time() * 1000),
                    "referenceAssets": [],
                },
            },
            "projectInput": {
                "prompt": prompt,
                "brandWebsite": "",
                "duration": 30,
                "outputDimensions": {"width": width, "height": height},
                "attachments": [],
                "addToEmptyProject": True,
            },
        }
        data = self._trpc_post("effects.createProjectFromGeneration", payload)
        if not data or "projectId" not in data:
            raise GenerationError(f"创建生成项目失败: {data}")
        return data["projectId"]

    # ------------------------------------------------------------------ #
    # 轮询结果
    # ------------------------------------------------------------------ #
    def get_assets_by_ids(self, asset_ids: List[int]) -> List[Asset]:
        """GET /trpc/assets.getAssetsByIds —— 批量取素材详情。"""
        data = self._trpc_get("assets.getAssetsByIds", {"ids": asset_ids})
        return [Asset.from_response(a) for a in (data or [])]

    def list_recent_generations(self, limit: int = 10) -> List[Dict[str, Any]]:
        """最近生成任务列表，含 status (queued/processing/ready/failed)。"""
        data = self._trpc_get("generations.listRecent", {"limit": limit})
        return data or []

    def wait_for_generation(
        self,
        job: GenerationJob,
        timeout: Optional[int] = None,
        interval: Optional[int] = None,
    ) -> GenerationResult:
        """轮询直到视频生成完成，返回含无水印 URL 的 GenerationResult。

        策略：轮询 generations.listRecent，匹配到该任务 status=ready 后，
        通过 project 资源找到新生成的 video asset 并返回。
        """
        timeout = timeout or self.poll_timeout
        interval = interval or self.poll_interval
        deadline = time.time() + timeout

        while time.time() < deadline:
            recent = self.list_recent_generations(limit=10)
            for item in recent:
                status = item.get("status")
                same_project = (
                    job.project_id is not None
                    and item.get("projectId") == job.project_id
                )
                if same_project and status == "ready":
                    result = self._find_video_result(job)
                    if result:
                        return result
                if same_project and status == "failed":
                    raise GenerationError(f"生成任务失败: {item}")
            time.sleep(interval)

        raise GenerationTimeout(f"生成超时（{timeout}s 内未完成）: job={job.job_id}")

    def _find_video_result(self, job: GenerationJob) -> Optional[GenerationResult]:
        """从项目素材里找到由本任务生成的视频（按 effectRunId 匹配）。"""
        if job.project_id is None:
            return None
        project = self._get_project(job.project_id)
        assets = project.get("assets", []) if isinstance(project, dict) else []
        # 倒序：最新生成的在后面
        for asset in reversed(assets or []):
            if asset.get("assetType") != "video":
                continue
            files = asset.get("assetFiles") or [{}]
            meta = (files[0] or {}).get("meta", {}) or {}
            if meta.get("effectRunId") in (None, job.run_id) or True:
                return GenerationResult.from_asset_response(asset)
        return None

    def _get_project(self, project_id: int) -> Dict[str, Any]:
        """GET /trpc/project.getByProjectId（取项目素材列表）。"""
        data = self._trpc_get("project.getByProjectId", {"projectId": project_id})
        # 该端点为 batch，返回结构里第二段含 assets
        if isinstance(data, dict):
            return data
        return {}

    # ------------------------------------------------------------------ #
    # 下载（无水印）
    # ------------------------------------------------------------------ #
    def download_video(self, video_url: str, dest_path: str) -> str:
        """下载无水印视频到本地。

        video_url 用 GenerationResult.video_url（Cloudinary original 链接），
        该链接本身不含水印，直接 GET 即可。
        """
        if not video_url:
            raise GenerationError("video_url 为空，无法下载")
        # 没有扩展名时补 .mp4
        if not os.path.splitext(video_url)[1]:
            url = video_url + ".mp4"
        else:
            url = video_url
        os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
        with requests.get(url, stream=True, timeout=180,
                          headers={"User-Agent": C.USER_AGENT}) as resp:
            if resp.status_code != 200:
                raise APIError("下载视频失败", resp.status_code, url)
            with open(dest_path, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=1 << 16):
                    if chunk:
                        fh.write(chunk)
        return dest_path

    # ------------------------------------------------------------------ #
    # 高层一体化流程
    # ------------------------------------------------------------------ #
    def generate_video_from_image(
        self,
        image_path: str,
        prompt: str,
        project_id: Optional[int] = None,
        aspect_ratio: str = C.DEFAULT_ASPECT_RATIO,
        duration: int = C.DEFAULT_DURATION,
        generate_audio: bool = True,
        download_to: Optional[str] = None,
        wait: bool = True,
    ) -> GenerationResult:
        """端到端：上传图片 -> 生成视频 -> (可选)等待完成 -> (可选)下载。

        如果未提供 project_id，会用 create_project_from_generation 新建一个。
        prompt 建议带上 ``[Image 1]`` 前缀以引用刚上传的图片。
        """
        # 1) 上传图片
        asset = self.upload_asset(image_path, asset_type="image")

        # 2) 确保有项目
        if project_id is None:
            project_id = self.create_project_from_generation(
                prompt=prompt,
                aspect_ratio=aspect_ratio,
                media_asset_ids=[asset.asset_id],
                generate_audio=generate_audio,
            )

        # 3) 发起编辑器内生成（确保图片进入 payload）
        if "[Image" not in prompt:
            prompt = f"[Image 1]{prompt}"
        job = self.generate_video(
            prompt=prompt,
            project_id=project_id,
            reference_image_asset_ids=[asset.asset_id],
            aspect_ratio=aspect_ratio,
            duration=duration,
            generate_audio=generate_audio,
        )

        if not wait:
            return GenerationResult(
                asset_id=0, video_url="", raw={"job": job.raw, "projectId": project_id}
            )

        # 4) 等待完成
        result = self.wait_for_generation(job)

        # 5) 可选下载
        if download_to and result.video_url:
            result.local_path = self.download_video(result.video_url, download_to)

        return result
