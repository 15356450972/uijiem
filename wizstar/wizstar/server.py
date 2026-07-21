"""Wizstar 本地 HTTP 服务 — 包装 SDK 为 REST API，供 Electron 前端调用"""

from __future__ import annotations

import os
import json
import hmac
import mimetypes
import re
import threading
import time
import traceback
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
import uvicorn

from .database import init_db, MailboxDB, AccountDB, TaskDB, ProjectDB, QfAccountDB, DolaAccountDB, LovartAccountDB, OreateAIAccountDB, FramiaAccountDB, TensorArtAccountDB
from .client import WizstarClient, WizstarCredentials
from .mailbox import OutlookMailbox
from .enums import TaskType, Model, Ratio, Resolution
from .capabilities import CAPABILITY_MATRIX, POINT_TABLE
from . import quickframe_bridge as qf
from . import pixmax as px
from . import oiioii as oi
from . import dola as dl
from . import lovart as lv
from . import chatgpt2api as cg
from . import framia as fm
from . import tensorart as ta


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Wizstar Local API", version="1.0.0", lifespan=lifespan)
_dola_task_create_lock = threading.Lock()
_wizstar_task_create_lock = threading.Lock()
_tensorart_task_create_lock = threading.Lock()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================== Pydantic Models ====================

class MailboxCreate(BaseModel):
    email: str
    password: str = ""
    client_id: str = ""
    refresh_token: str = ""
    google_password: str = ""
    provider: str = ""


class MailboxBatchImport(BaseModel):
    """兼容 Google 登录与 Microsoft OAuth 邮箱格式。"""
    raw_text: str


class MailboxClaimRequest(BaseModel):
    """由各渠道从全局邮箱库原子领取邮箱。"""
    channel: str
    count: int = 1
    mailbox_ids: list[int] = []
    credential_type: str = "any"
    provider: str = "any"
    lease_seconds: int = 900


class MailboxUsageUpdate(BaseModel):
    """记录邮箱在指定渠道中的注册结果。"""
    channel: str
    status: str
    account_email: str = ""
    error: str = ""


class GoogleAccountLogin(BaseModel):
    """接收 Electron 授权窗口提取的 Wizstar 浏览器会话。"""
    mailbox_id: int = 0
    email: str = ""
    auth_token: str = ""
    cookies: dict[str, str] = {}
    user_info: dict = {}


class AccountConcurrencyUpdate(BaseModel):
    max_concurrency: int = 1


def _account_credentials(account: dict) -> WizstarCredentials:
    """把持久化账号恢复成可复用的 Wizstar 浏览器会话。"""
    raw_cookies = account.get("cookies_json") or {}
    if isinstance(raw_cookies, str):
        try:
            raw_cookies = json.loads(raw_cookies)
        except (TypeError, ValueError):
            raw_cookies = {}
    cookies = raw_cookies if isinstance(raw_cookies, dict) else {}
    return WizstarCredentials(
        email=account.get("email", ""),
        password=account.get("password", ""),
        uid=account.get("uid", 0),
        display_name=account.get("display_name", ""),
        osduss=account.get("osduss", ""),
        refresh_token=account.get("refresh_token", ""),
        pass_os_refresh_tk=account.get("pass_os_refresh_tk", ""),
        auth_token=account.get("auth_token", ""),
        cookies=cookies,
    )


def _session_failure_status(error: object) -> str:
    text = str(error or "").lower()
    if "user forbidden" in text or "forbidden" in text:
        return "forbidden"
    expired_markers = (
        "unauthorized",
        "unauthenticated",
        "token expired",
        "invalid token",
        "login required",
        "not logged in",
        "user not login",
        "登录失效",
        "未登录",
        "请登录",
    )
    return "auth_expired" if any(marker in text for marker in expired_markers) else "error"


def _record_session_failure(account_id: int, error: object, *, include_generic: bool = True) -> str:
    status = _session_failure_status(error)
    if include_generic or status != "error":
        AccountDB.update_session_status(account_id, status, str(error or ""))
    return status


def _require_internal_session_access(request: Request) -> None:
    expected = os.getenv("WIZSTAR_INTERNAL_TOKEN", "").strip()
    supplied = request.headers.get("X-Wizstar-Internal-Token", "").strip()
    if expected:
        if not supplied or not hmac.compare_digest(expected, supplied):
            raise HTTPException(status_code=403, detail="internal session access denied")
        return
    client_host = request.client.host if request.client else ""
    if client_host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(status_code=403, detail="internal session access denied")


class TaskCreate(BaseModel):
    account_id: int
    task_type: int = TaskType.IMAGE_TO_VIDEO
    prompt: str = ""
    model: str = Model.SEEDANCE_2_0
    video_ratio: str = Ratio.PORTRAIT
    video_resolution: str = Resolution.P720
    video_duration: int = 5
    video_num: int = 1
    pic_url: str = ""
    video_url: str = ""


class ImageUpload(BaseModel):
    account_id: int
    file_path: str = ""
    data_url: str = ""
    filename: str = "role-reference.png"


class FaceCensorRequest(BaseModel):
    src: str = ""
    file_path: str = ""
    data_url: str = ""
    scale: float | None = None
    alpha: float | None = None
    line_width_factor: float | None = None
    color: str | None = None
    detect_max_side: int | None = None
    upper_region_ratio: float | None = None




class PixmaxConfigUpdate(BaseModel):
    """保存 Pixmax 通道配置（API Key）"""
    api_key: str | None = None
    base_url: str | None = None
    test: bool = False


class ChatGPT2APIConfigUpdate(BaseModel):
    """保存 ChatGPT2API 生图通道配置（API Key）"""
    api_key: str | None = None
    base_url: str | None = None
    test: bool = False


class QuickFrameConfigUpdate(BaseModel):
    """保存 QuickFrame 通道配置（YesCaptcha key / 动态 IP 代理）"""
    yescap_key: str | None = None
    use_proxy: bool | None = None
    proxy_local_host: str | None = None
    proxy_local_port: int | None = None
    proxy_remote_host: str | None = None
    proxy_remote_port: int | None = None
    proxy_user: str | None = None
    proxy_pass: str | None = None
    requests_proxy: str | None = None


class QuickFrameRegister(BaseModel):
    """使用全局邮箱库注册 QuickFrame 账号。"""
    count: int = 1
    concurrency: int = 3
    domain: str = ""          # 兼容旧临时邮箱流程
    mailbox_ids: list[int] = []


class PixmaxTaskCreate(BaseModel):
    """Pixmax 图生视频提交参数（渠道二）"""
    prompt: str = ""
    image: str = ""           # 单张图片 URL 或 base64 data-uri
    image_url: str = ""       # 兼容字段，同 image
    image_path: str = ""      # 本地图片路径（后端自动读取转 base64）
    images: list[str] = []    # 多张图片（首尾帧）
    image_paths: list[str] = []  # 多张本地图片路径（后端自动读取转 base64）
    image_inputs: list[dict] = []  # 多张有序图片，支持 {image}/{url}/{data_url}/{file_path}
    aliases: list[str] = []    # 多图角色别名
    image_aliases: list[str] = []  # aliases 兼容字段
    model: str = "pixdance-2-fast"
    duration: int = 5
    resolution: str = ""      # 480P / 720P / 1080P
    aspect_ratio: str = ""    # 16:9 / 9:16 / 1:1


class QuickFrameTaskCreate(BaseModel):
    """QuickFrame 图生视频提交参数"""
    account_id: int
    prompt: str = ""
    image_path: str = ""      # 本地图片路径（QuickFrame 走 Cloudinary 直传）
    aspect_ratio: str = "16:9"
    duration: int = 5
    generate_audio: bool = True


class OiiOiiConfigUpdate(BaseModel):
    """保存 OiiOii 通道配置（代理设置 / 注册邮箱来源）"""
    use_proxy: bool | None = None
    proxy_host: str | None = None
    proxy_port: int | None = None
    mail_provider: str | None = None
    test: bool = False


class OiiOiiBatchRegister(BaseModel):
    """OiiOii 批量注册参数"""
    count: int = 1
    concurrency: int = 2
    mail_provider: str | None = None
    mailbox_ids: list[int] = []


class OiiOiiAccountImport(BaseModel):
    """手动导入 OiiOii 账号"""
    email: str
    password: str
    token: str = ""


class OiiOiiTaskCreate(BaseModel):
    """OiiOii 视频生成提交参数（渠道四）"""
    prompt: str = ""
    image_path: str = ""      # 本地参考图路径
    image_url: str = ""       # 远程参考图 URL / hogi:// URI
    reference_images: list[str] = []
    model: str = "gemini"     # 视频模型别名
    duration: int = 10
    aspect_ratio: str = "16:9"
    resolution: str = "720p"
    generate_mode: str = ""
    generateMode: str = ""


class OiiOiiImageCreate(BaseModel):
    """OiiOii 图片生成提交参数（渠道四）"""
    prompt: str = ""
    image_path: str = ""      # 本地参考图路径，可选
    image_url: str = ""       # 远程参考图 URL / hogi:// URI，可选
    reference_images: list[str] = []
    image_to_image: bool = False
    model: str = "gpt-image2" # 图片模型别名
    aspect_ratio: str = "1:1"
    resolution: str = "2K"


class ChatGPT2APIImageCreate(BaseModel):
    """ChatGPT2API 图片生成提交参数（渠道五）"""
    prompt: str = ""
    image_path: str = ""
    image_url: str = ""
    reference_images: list[str] = []
    model: str = "gpt-image-2"
    size: str = "16:9"
    resolution: str = "2K"


class DolaConfigUpdate(BaseModel):
    """保存 Dola 通道配置。"""
    proxy: str | None = None
    env_file: str | None = None
    profile_dir: str | None = None
    send_mode: str | None = None
    browser_headless: bool | None = None


class DolaAccountGrab(BaseModel):
    """采集 Dola 登录态并写入账号库。"""
    name: str = ""
    count: int = 1
    concurrency: int = 1
    visible: bool = False
    keep_open: bool = False
    wait_ms: int = 12000
    proxy: str = ""
    account_id: int = 0
    send_hi: bool = True
    hi_text: str = "你好"
    close_login: bool = True
    note: str = ""


class DolaAccountImport(BaseModel):
    """把已有 Dola API 凭证加入账号库。"""
    name: str = ""
    cookie: str = ""
    ms_token: str = ""
    msToken: str = ""
    env_file: str = ""
    profile_dir: str = ""
    note: str = ""


class LovartAccountImport(BaseModel):
    """把 Lovart 登录态加入渠道七账号库。"""
    email: str
    cookie: str = ""
    cookies: list[dict] = []
    user_agent: str = ""
    location: str = ""
    local_storage: dict = {}
    session_storage: dict = {}
    indexed_db: list[dict] = []
    status: str = "active"
    note: str = ""


class FramiaAccountImport(BaseModel):
    """把 Framia Google OAuth 登录态加入渠道九账号库。"""
    email: str
    password: str = ""
    access_token: str = ""
    expires_at: int = 0
    cookie: str = ""
    user_agent: str = ""
    user_id: str = ""
    location: str = ""
    status: str = "active"
    note: str = ""


class FramiaAccountLogin(BaseModel):
    """通过 Google OAuth 自动登录 Framia 并采集账号。"""
    email: str
    password: str
    visible: bool = True
    proxy: str = ""
    keep_open: bool = False


class FramiaMailboxBatchLogin(BaseModel):
    """从全局邮箱库领取账号并批量登录 Framia。"""
    count: int = 1
    concurrency: int = 1
    mailbox_ids: list[int] = []
    visible: bool = True
    proxy: str = ""
    keep_open: bool = False


class FramiaTaskCreate(BaseModel):
    """Framia 视频生成提交参数（渠道九）。"""
    account_id: int = 0
    prompt: str = ""
    image_path: str = ""
    image_url: str = ""
    model: str = "Seedance 2.0 Mini"
    aspect_ratio: str = "16:9"
    resolution: str = "720p"
    duration: float = 4
    image_paths: list[str] = []


class TensorArtAccountImport(BaseModel):
    """手动导入 Tensor.Art 登录 token。"""
    email: str
    access_token: str
    expires_at: int = 0
    device_id: str = ""
    user_agent: str = ""
    user_id: str = ""
    status: str = "active"
    note: str = ""


class TensorArtMailboxRegister(BaseModel):
    """从全局 Microsoft OAuth 邮箱库注册 Tensor.Art。"""
    count: int = 1
    concurrency: int = 1
    mailbox_ids: list[int] = []
    max_wait: int = 210


class TensorArtTaskCreate(BaseModel):
    """Tensor.Art 图生视频提交参数（渠道十）。"""
    account_id: int = 0
    prompt: str = ""
    image_path: str = ""
    image_url: str = ""
    image_paths: list[str] = []
    model: str = "tensorart-default"
    aspect_ratio: str = "16:9"
    resolution: str = "480p"
    duration: int = 4


class OreateAIAccountImport(BaseModel):
    """保存真实 Chromium 注册并登录后的 OreateAI 渠道八会话。"""
    email: str
    password: str
    cookie: str = ""
    cookies: list[dict] = []
    user_agent: str = ""
    location: str = ""
    status: str = "active"
    note: str = ""


class LovartImageCreate(BaseModel):
    """Lovart 图片生成提交参数（渠道七）。"""
    account_id: int = 0
    prompt: str = ""
    image: str = ""
    image_path: str = ""
    image_url: str = ""
    data_url: str = ""
    reference_images: list[str] = []
    images: list[str] = []
    model: str = "openai/gpt-image-2"
    aspect_ratio: str = "16:9"
    aspectRatio: str = ""
    resolution: str = "2K"
    size: str = ""
    quality: str = "medium"
    project_id: str = ""
    projectId: str = ""
    cid: str = ""
    with_pricing: bool = False


class DolaTaskCreate(BaseModel):
    """Dola 视频生成提交参数（渠道六）。"""
    account_id: int = 0
    prompt: str = ""
    image_path: str = ""
    image_url: str = ""
    reference_images: list[str] = []
    model: str = "seedance-2.0"
    ratio: str = "16:9"
    duration: int = 15
    headless: bool | None = None
    exclude_account_ids: list[int] = []


class DolaTaskCollect(BaseModel):
    """手动采集 Dola 任务结果。"""
    account_id: int = 0
    task_id: str = ""
    conversation_id: str = ""


class DolaAccountOpenBrowser(BaseModel):
    """打开 Dola 账号浏览器，可选直达任务会话。"""
    task_id: str = ""
    conversation_id: str = ""


class ProjectCreate(BaseModel):
    id: str = ""
    title: str
    date: str = ""
    time: str = ""
    status: str = "未生成"
    progress: str = "0/0"
    collection: str = ""
    thumbnail: str = ""
    editable: bool = True


class ProjectUpdate(BaseModel):
    id: str
    title: str = ""
    date: str = ""
    time: str = ""
    status: str = ""
    progress: str = ""
    collection: str = ""
    thumbnail: str = ""
    editable: bool = True


class ProjectPayload(BaseModel):
    # None means "leave the existing MySQL column unchanged". This keeps
    # lightweight segment-only flushes from erasing other project assets.
    segments: list | None = None
    character_assets: list | None = None
    scene_assets: list | None = None
    item_assets: list | None = None
    generation_tasks: list | None = None


# ==================== 项目库 ====================

@app.get("/projects")
def list_projects():
    return {"data": ProjectDB.list_all()}


@app.post("/projects")
def create_project(body: ProjectCreate):
    project = ProjectDB.add(body.model_dump())
    return {"data": project}


@app.put("/projects/{project_id}")
def update_project(project_id: str, body: ProjectUpdate):
    data = body.model_dump()
    data["id"] = project_id
    project = ProjectDB.update(data)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return {"data": project}


@app.delete("/projects/{project_id}")
def delete_project(project_id: str):
    ProjectDB.delete(project_id)
    return {"message": "deleted"}


@app.get("/projects/{project_id}/payload")
def get_project_payload(project_id: str):
    project = ProjectDB.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return {"data": {
        "segments": ProjectDB.get_segments(project_id),
        "character_assets": ProjectDB.get_character_assets(project_id),
        "scene_assets": ProjectDB.get_scene_assets(project_id),
        "item_assets": ProjectDB.get_item_assets(project_id),
        "generation_tasks": ProjectDB.get_generation_tasks(project_id),
    }}


@app.put("/projects/{project_id}/payload")
def save_project_payload(project_id: str, body: ProjectPayload):
    if not ProjectDB.get(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    ProjectDB.save_payload(
        project_id=project_id,
        segments=body.segments,
        character_assets=body.character_assets,
        scene_assets=body.scene_assets,
        item_assets=body.item_assets,
        generation_tasks=body.generation_tasks,
    )
    return {"message": "saved"}


# ==================== 邮箱库 ====================

@app.get("/mailboxes")
def list_mailboxes():
    return {"data": MailboxDB.list_all()}


@app.post("/mailboxes")
def add_mailbox(body: MailboxCreate):
    try:
        mailbox = MailboxDB.add(
            body.email,
            body.client_id,
            body.refresh_token,
            body.google_password,
            password=body.password,
            provider=body.provider,
        )
        return {"data": MailboxDB.public(mailbox)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/mailboxes/{mailbox_id}")
def delete_mailbox(mailbox_id: int):
    MailboxDB.delete(mailbox_id)
    return {"message": "deleted"}


@app.get("/mailboxes/{mailbox_id}")
def get_mailbox(mailbox_id: int):
    mailbox = MailboxDB.get(mailbox_id)
    if not mailbox:
        raise HTTPException(status_code=404, detail="mailbox not found")
    return {"data": MailboxDB.public(mailbox)}


@app.get("/internal/mailboxes/{mailbox_id}")
def get_mailbox_credentials(mailbox_id: int, request: Request):
    _require_internal_session_access(request)
    mailbox = MailboxDB.get(mailbox_id)
    if not mailbox:
        raise HTTPException(status_code=404, detail="mailbox not found")
    mailbox["password"] = mailbox.get("password") or mailbox.get("google_password") or ""
    mailbox["google_password"] = mailbox["password"]
    return {"data": mailbox}


@app.post("/internal/mailboxes/claim")
def claim_mailboxes(body: MailboxClaimRequest, request: Request):
    _require_internal_session_access(request)
    try:
        mailboxes = MailboxDB.claim_for_channel(
            body.channel,
            count=body.count,
            mailbox_ids=body.mailbox_ids,
            credential_type=body.credential_type,
            provider=body.provider,
            lease_seconds=body.lease_seconds,
        )
        return {"data": mailboxes}
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@app.post("/internal/mailboxes/{mailbox_id}/usage")
def update_mailbox_usage(mailbox_id: int, body: MailboxUsageUpdate, request: Request):
    _require_internal_session_access(request)
    if not MailboxDB.get(mailbox_id):
        raise HTTPException(status_code=404, detail="mailbox not found")
    try:
        usage = MailboxDB.mark_channel_usage(
            mailbox_id,
            body.channel,
            body.status,
            account_email=body.account_email,
            error=body.error,
        )
        return {"data": usage}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.delete("/mailboxes/{mailbox_id}/usage/{channel}")
def clear_mailbox_channel_failure(mailbox_id: int, channel: str):
    """手动解除某邮箱在指定渠道的失败冷却；已注册和使用中的记录不可清除。"""
    if not MailboxDB.get(mailbox_id):
        raise HTTPException(status_code=404, detail="mailbox not found")
    try:
        cleared = MailboxDB.clear_channel_failure(mailbox_id, channel)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not cleared:
        raise HTTPException(status_code=409, detail="只有失败或已释放的渠道记录可以解除")
    return {"data": {"cleared": True}}


@app.post("/mailboxes/batch")
def batch_import_mailboxes(body: MailboxBatchImport):
    """批量导入 Google 账号或供渠道八取件的 Microsoft OAuth 邮箱。"""
    lines = [line.strip() for line in body.raw_text.strip().splitlines() if line.strip()]
    imported = []
    errors = []
    for line in lines:
        if "----" in line:
            parts = [part.strip() for part in line.split("----", 3)]
            if len(parts) == 4:
                email, password, third, fourth = parts
                third_is_client_id = bool(re.fullmatch(
                    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
                    third,
                ))
                fourth_is_client_id = bool(re.fullmatch(
                    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
                    fourth,
                ))
                if fourth_is_client_id and not third_is_client_id:
                    refresh_token, client_id = third, fourth
                else:
                    client_id, refresh_token = third, fourth
            elif len(parts) == 3:
                email, second, third = parts
                password = ""
                second_is_client_id = bool(re.fullmatch(
                    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
                    second,
                ))
                third_is_client_id = bool(re.fullmatch(
                    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
                    third,
                ))
                if third_is_client_id and not second_is_client_id:
                    refresh_token, client_id = second, third
                else:
                    client_id, refresh_token = second, third
            else:
                errors.append({"line": line[:50], "error": "格式错误，需要 邮箱----client_id----refresh_token，或四字段兼容格式"})
                continue
            if not email or not client_id or not refresh_token:
                errors.append({"line": line[:50], "error": "邮箱、client_id、refresh_token 不能为空"})
                continue
        else:
            parts = [part.strip() for part in line.split("|", 1)]
            if len(parts) != 2 or not parts[0] or not parts[1]:
                errors.append({"line": line[:50], "error": "格式错误，请使用 邮箱|密码"})
                continue
            email, password = parts
            client_id = ""
            refresh_token = ""
        try:
            mailbox = MailboxDB.add(email, client_id, refresh_token, password)
            imported.append(MailboxDB.public(mailbox))
        except Exception as e:
            errors.append({"line": email, "error": str(e)})
    return {"data": {"imported": imported, "errors": errors, "total": len(lines)}}


@app.post("/mailboxes/{mailbox_id}/test")
def test_mailbox(mailbox_id: int):
    mailbox = MailboxDB.get(mailbox_id)
    if not mailbox:
        raise HTTPException(status_code=404, detail="mailbox not found")
    try:
        mb = OutlookMailbox(mailbox["email"], mailbox["client_id"], mailbox["refresh_token"])
        token = mb.get_access_token()
        MailboxDB.update_status(mailbox_id, "available")
        return {"status": "available", "message": "OAuth2 token obtained successfully"}
    except Exception as e:
        MailboxDB.update_status(mailbox_id, "error")
        return {"status": "error", "message": str(e)}


def _mark_mailbox_channel_by_email(
    email: str,
    channel: str,
    status: str = "registered",
    error: str = "",
) -> None:
    """Best-effort usage tracking for account import/login endpoints."""
    mailbox = MailboxDB.get_by_email(str(email or "").strip())
    if not mailbox:
        return
    try:
        MailboxDB.mark_channel_usage(
            mailbox["id"],
            channel,
            status,
            account_email=email,
            error=error,
        )
    except Exception:
        pass


def _release_mailbox_channel_by_email(email: str, channel: str) -> None:
    """Account deletion makes the mailbox reusable for that channel."""
    mailbox = MailboxDB.get_by_email(str(email or "").strip())
    if not mailbox:
        return
    try:
        MailboxDB.mark_channel_usage(
            mailbox["id"],
            channel,
            "released",
            account_email=email,
        )
    except Exception:
        pass


# ==================== 账号库 ====================

@app.get("/accounts")
def list_accounts():
    accounts = AccountDB.list_all()
    result = []
    for account in accounts:
        public_account = AccountDB.public(account)
        public_account["active_task_count"] = TaskDB.active_count_for_account(account["id"])
        used_15s_count = TaskDB.used_15s_count_for_account(account["id"])
        public_account["used_15s_task_count"] = used_15s_count
        public_account["remaining_15s_task_quota"] = max(0, 1 - used_15s_count)
        result.append(public_account)
    return {"data": result}


@app.get("/accounts/{account_id}")
def get_account(account_id: int):
    account = AccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")
    return {"data": AccountDB.public(account)}


@app.get("/internal/accounts/{account_id}/session")
def get_account_session(account_id: int, request: Request):
    _require_internal_session_access(request)
    account = AccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")
    return {"data": account}


@app.patch("/accounts/{account_id}/concurrency")
def update_account_concurrency(account_id: int, body: AccountConcurrencyUpdate):
    account = AccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")
    max_concurrency = max(1, min(int(body.max_concurrency or 1), 10))
    AccountDB.update_concurrency(account_id, max_concurrency)
    updated = AccountDB.get(account_id)
    return {"data": AccountDB.public(updated)}


@app.post("/accounts/google-login")
def google_login_account(body: GoogleAccountLogin):
    """校验浏览器会话后保存 Google 登录账号。"""
    mailbox = MailboxDB.get(body.mailbox_id) if body.mailbox_id else MailboxDB.get_by_email(body.email)
    if not mailbox and body.email:
        mailbox = MailboxDB.add(body.email, provider="google")
    if not mailbox:
        raise HTTPException(status_code=404, detail="mailbox not found")
    if not body.auth_token and not body.cookies:
        raise HTTPException(status_code=400, detail="Google 登录会话为空")

    try:
        supplied_info = body.user_info or {}
        client = WizstarClient(
            WizstarCredentials(
                email=body.email or mailbox["email"],
                auth_token=body.auth_token,
                cookies=body.cookies,
            )
        )
        info_response = client.user_info()
        if info_response.get("errno") != 0:
            raise RuntimeError(f"user info failed: {info_response}")
        user = info_response.get("data") or supplied_info
        email = user.get("email") or body.email or mailbox["email"]
        if not email:
            raise RuntimeError("Google 登录成功但未取得邮箱")
        uid = user.get("uid") or user.get("user_id") or user.get("userId") or 0
        try:
            uid = int(uid)
        except (TypeError, ValueError):
            uid = 0
        points = user.get("point_number", 0) or 0
        try:
            balance = client.points_balance()
            if balance.get("errno") == 0:
                points = (balance.get("data") or {}).get("total_points", points)
        except Exception:
            pass
        account = AccountDB.add(
            email=email,
            uid=uid,
            display_name=user.get("display_name") or user.get("user_name") or "",
            osduss=body.cookies.get("osduss", ""),
            refresh_token=body.auth_token,
            auth_token=body.auth_token,
            pass_os_refresh_tk=body.cookies.get("passOsRefreshTk", ""),
            cookies=body.cookies,
            points_balance=points,
        )
        MailboxDB.update_status(mailbox["id"], "logged_in")
        MailboxDB.mark_channel_usage(
            mailbox["id"],
            "wizstar",
            "registered",
            account_email=email,
        )
        return {"data": AccountDB.public(account)}
    except HTTPException:
        raise
    except Exception as e:
        MailboxDB.update_status(mailbox["id"], "error")
        MailboxDB.mark_channel_usage(
            mailbox["id"],
            "wizstar",
            "failed",
            account_email=body.email or mailbox.get("email", ""),
            error=str(e),
        )
        raise HTTPException(status_code=502, detail=f"Google 登录失败: {str(e)}")


@app.post("/accounts/batch-refresh")
def batch_refresh_accounts():
    """批量刷新所有账号积分"""
    import concurrent.futures

    accounts = AccountDB.list_all()
    results = {"success": [], "failed": []}

    def refresh_one(account: dict) -> dict:
        try:
            creds = _account_credentials(account)
            client = WizstarClient(credentials=creds)
            info = client.user_info()
            if info.get("errno") == 0:
                points = info.get("data", {}).get("point_number", 0)
                AccountDB.update_points(account["id"], points)
                return {"id": account["id"], "email": account["email"], "points": points, "status": "active"}
            error = f"API error: {info}"
            status = _record_session_failure(account["id"], error)
            return {"id": account["id"], "email": account["email"], "status": status, "error": error}
        except Exception as e:
            status = _record_session_failure(account["id"], e)
            return {"id": account["id"], "email": account["email"], "status": status, "error": str(e)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(refresh_one, acc) for acc in accounts]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if "points" in result:
                results["success"].append(result)
            else:
                results["failed"].append(result)

    return {"data": results}


@app.delete("/accounts/{account_id}")
def delete_account(account_id: int):
    account = AccountDB.get(account_id)
    AccountDB.delete(account_id)
    if account:
        _release_mailbox_channel_by_email(account.get("email", ""), "wizstar")
    return {"message": "deleted"}


@app.post("/accounts/{account_id}/refresh")
def refresh_account(account_id: int):
    """刷新账号积分余额"""
    account = AccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")

    try:
        creds = _account_credentials(account)
        client = WizstarClient(credentials=creds)
        info = client.user_info()
        if info.get("errno") == 0:
            points = info.get("data", {}).get("point_number", 0)
            AccountDB.update_points(account_id, points)
            return {"data": {"points_balance": points, "status": "active", "last_verified_at": time.time()}}
        error = f"API error: {info}"
        status = _record_session_failure(account_id, error)
        status_code = 401 if status == "auth_expired" else (403 if status == "forbidden" else 502)
        raise HTTPException(status_code=status_code, detail={"message": error, "status": status})
    except HTTPException:
        raise
    except Exception as e:
        status = _record_session_failure(account_id, e)
        status_code = 401 if status == "auth_expired" else (403 if status == "forbidden" else 502)
        raise HTTPException(status_code=status_code, detail={"message": str(e), "status": status})


# ==================== 视频生成 ====================

@app.post("/tasks/upload")
def upload_image(body: ImageUpload):
    """上传图片到 wizstar S3"""
    account = AccountDB.get(body.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")

    upload_path = body.file_path.strip()
    temp_path = ""
    if not upload_path and body.data_url:
        import base64
        import re
        import tempfile

        match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", body.data_url.strip(), re.S)
        if not match:
            raise HTTPException(status_code=400, detail="角色图片格式不正确，请重新选择 PNG/JPG/WebP 图片")
        mime = match.group(1).lower()
        ext_map = {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
        }
        ext = ext_map.get(mime, ".png")
        try:
            raw = base64.b64decode(match.group(2), validate=True)
        except Exception as e:
            raise HTTPException(status_code=400, detail="角色图片 base64 解码失败") from e
        fd, temp_path = tempfile.mkstemp(prefix="wizstar_role_", suffix=ext)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        upload_path = temp_path

    if not upload_path:
        raise HTTPException(status_code=400, detail="请提供要上传的图片")

    try:
        creds = _account_credentials(account)
        client = WizstarClient(credentials=creds)
        url = client.upload_image(upload_path)
        return {"data": {"url": url}}
    except Exception as e:
        err_msg = str(e)
        status = _record_session_failure(body.account_id, e, include_generic=False)
        status_code = 401 if status == "auth_expired" else (403 if status == "forbidden" else 500)
        raise HTTPException(status_code=status_code, detail=err_msg)
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


@app.post("/face-censor")
def face_censor_image(body: FaceCensorRequest):
    """后端自动识别人脸并叠加打码符号，避免前端主线程长时间卡顿。"""
    try:
        from .face_censor import censor_image

        user_opts = {
            key: value
            for key, value in {
                "scale": body.scale,
                "alpha": body.alpha,
                "line_width_factor": body.line_width_factor,
                "color": body.color,
                "detect_max_side": body.detect_max_side,
                "upper_region_ratio": body.upper_region_ratio,
            }.items()
            if value is not None
        }
        return {"data": censor_image(
            src=body.src,
            file_path=body.file_path,
            data_url=body.data_url,
            user_opts=user_opts,
        )}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"拉取图片失败: {e}") from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/tasks/create")
def create_task(body: TaskCreate):
    """创建视频生成任务"""
    with _wizstar_task_create_lock:
        account = AccountDB.get(body.account_id)
        if not account:
            raise HTTPException(status_code=404, detail="account not found")
        account_status = str(account.get("status") or "active")
        if account_status in {"forbidden", "auth_expired", "daily_limit"}:
            raise HTTPException(status_code=403, detail=f"该渠道一账号不可用：{account_status}")
        video_duration = int(body.video_duration or 0)
        if video_duration >= 15 and TaskDB.used_15s_count_for_account(body.account_id) >= 1:
            raise HTTPException(status_code=429, detail="该渠道一账号已生成过 15s 视频，请切换新账号")
        active_count = TaskDB.active_count_for_account(body.account_id)
        max_concurrency = max(1, int(account.get("max_concurrency") or 1))
        if active_count >= max_concurrency:
            raise HTTPException(status_code=429, detail=f"该账号已达到并发上限：{active_count}/{max_concurrency}")

        try:
            creds = _account_credentials(account)
            client = WizstarClient(credentials=creds)

            params = {}
            if body.pic_url:
                params["pic_url"] = body.pic_url
            if body.video_url:
                params["video_url"] = body.video_url

            task = client.create_task(
                task_type=body.task_type,
                prompt=body.prompt,
                model=body.model,
                video_ratio=body.video_ratio,
                video_resolution=body.video_resolution,
                video_duration=body.video_duration,
                video_num=body.video_num,
                params=params if params else None,
            )

            task_id = task.get("task_id", "")
            if not task_id:
                raise RuntimeError("渠道一未返回 task_id")
            TaskDB.add(
                task_id=task_id,
                account_id=body.account_id,
                task_type=body.task_type,
                prompt=body.prompt,
                model=body.model,
                video_duration=video_duration,
            )
            return {"data": task}
        except Exception as e:
            err_msg = str(e)
            status = _record_session_failure(body.account_id, e, include_generic=False)
            if any(marker in err_msg for marker in ("达到上限", "已达上限", "生成次数", "明天再来")):
                AccountDB.mark_daily_limit(body.account_id)
            status_code = 401 if status == "auth_expired" else (403 if status == "forbidden" else 500)
            raise HTTPException(status_code=status_code, detail=err_msg)


@app.get("/tasks/{task_id}/status")
def get_task_status(task_id: str):
    """查询单个任务状态"""
    db_task = TaskDB.get(task_id)
    if not db_task:
        raise HTTPException(status_code=404, detail="task not found in local db")

    model_name = str(db_task.get("model") or "")
    if model_name.startswith("dola:"):
        return dola_task_status(task_id)

    account = AccountDB.get(db_task["account_id"])
    if not account:
        raise HTTPException(status_code=404, detail="account not found")

    try:
        creds = _account_credentials(account)
        client = WizstarClient(credentials=creds)
        detail = client.get_task_detail(task_id)
        tasks = detail.get("data", {}).get("list", [])
        if not tasks:
            return {"data": {"status": "pending", "video_url": ""}}

        vr = (tasks[0].get("video_result") or [{}])[0]
        video_url = vr.get("video_url", "")
        status = "completed" if video_url else ("failed" if vr.get("status") == 4 else "processing")

        if video_url:
            TaskDB.update_status(task_id, "completed", video_url)
        elif vr.get("status") == 4:
            TaskDB.update_status(task_id, "failed")
            fail_reason = vr.get("fail_reason", "")
            if fail_reason and any(marker in fail_reason for marker in ("达到上限", "已达上限", "生成次数", "明天再来")):
                AccountDB.mark_daily_limit(db_task["account_id"])

        return {"data": {
            "status": status,
            "video_url": video_url,
            "queue_position": vr.get("queue_position"),
            "fail_reason": vr.get("fail_reason", ""),
        }}
    except Exception as e:
        status = _record_session_failure(db_task["account_id"], e, include_generic=False)
        status_code = 401 if status == "auth_expired" else (403 if status == "forbidden" else 500)
        raise HTTPException(status_code=status_code, detail=str(e))


def _refresh_chatgpt2api_task(task: dict) -> dict:
    if task.get("status") in ("completed", "failed"):
        return task
    if not str(task.get("model") or "").startswith("chatgpt2api-image:"):
        return task
    task_id = task.get("task_id") or ""
    if not task_id:
        return task
    try:
        detail = cg.ChatGPT2APIClient().get_task_status(task_id)
        status = detail.get("status", "completed")
        image_url = detail.get("image_url", "") or detail.get("video_url", "") or ""
        if status == "completed" and image_url:
            TaskDB.update_status(task_id, "completed", image_url)
            return {**task, "status": "completed", "video_url": image_url}
        if status == "failed":
            TaskDB.update_status(task_id, "failed")
            return {**task, "status": "failed"}
    except Exception:
        return task
    return task


def _refresh_dola_task(task: dict) -> dict:
    if task.get("status") in ("completed", "failed"):
        return task
    if not str(task.get("model") or "").startswith("dola:"):
        return task
    task_id = task.get("task_id") or ""
    if not task_id:
        return task
    try:
        detail = dl.get_task_status(task_id)
        status = detail.get("status", task.get("status", "pending"))
        video_url = detail.get("video_url", "") or detail.get("local_path", "") or ""
        if status == "completed" and video_url:
            TaskDB.update_status(task_id, "completed", video_url)
            return {**task, "status": "completed", "video_url": video_url}
        if status == "failed":
            TaskDB.update_status(task_id, "failed")
            return {**task, "status": "failed"}
        return {**task, "status": status, "video_url": video_url or task.get("video_url", "")}
    except Exception:
        return task


@app.get("/tasks")
def list_tasks():
    return {"data": [_refresh_dola_task(_refresh_chatgpt2api_task(t)) for t in TaskDB.list_all()]}


# ==================== Pixmax 通道（渠道二）配置 ====================

@app.get("/pixmax/config")
def pixmax_get_config():
    """返回 Pixmax 通道配置状态（API Key 脱敏）"""
    config = px._load_config()
    api_key = px.get_api_key()
    env_override = bool(os.environ.get("PIXMAX_API_KEY", "").strip())
    masked = ""
    if api_key:
        masked = api_key[:6] + "..." + api_key[-4:] if len(api_key) > 10 else "***"
    return {"data": {
        "configured": bool(api_key),
        "api_key_masked": masked,
        "base_url": px.get_base_url(),
        "env_override": env_override,
    }}


@app.post("/pixmax/config")
def pixmax_update_config(body: PixmaxConfigUpdate):
    """保存 Pixmax 配置，可选测试连接"""
    if body.api_key or body.base_url:
        px.save_config(api_key=body.api_key, base_url=body.base_url)

    api_key = px.get_api_key()
    env_override = bool(os.environ.get("PIXMAX_API_KEY", "").strip())
    masked = ""
    if api_key:
        masked = api_key[:6] + "..." + api_key[-4:] if len(api_key) > 10 else "***"

    result = {
        "configured": bool(api_key),
        "api_key_masked": masked,
        "base_url": px.get_base_url(),
        "env_override": env_override,
    }

    if body.test:
        try:
            client = px.PixmaxClient()
            test_result = client.test_connection()
            result["test"] = {
                "ok": True,
                "models": test_result.get("models", []),
                "note": test_result.get("note", ""),
            }
        except px.PixmaxError as e:
            result["test"] = {"ok": False, "error": str(e)}
        except Exception as e:
            result["test"] = {"ok": False, "error": str(e)}

    return {"data": result}


# ==================== Pixmax 通道（渠道二）任务提交与查询 ====================

@app.post("/pixmax/tasks/create")
def pixmax_create_task(body: PixmaxTaskCreate):
    """通过 Pixmax 提交图生视频任务（异步），返回 task_id"""
    import base64
    import mimetypes

    try:
        def image_path_to_data_uri(file_path: str) -> str:
            file_path = file_path.strip()
            if not os.path.isfile(file_path):
                raise HTTPException(status_code=400, detail=f"本地图片文件不存在: {file_path}")
            mime, _ = mimetypes.guess_type(file_path)
            if not mime:
                mime = "image/png"
            with open(file_path, "rb") as f:
                raw = f.read()
            b64 = base64.b64encode(raw).decode("ascii")
            return f"data:{mime};base64,{b64}"

        image = body.image or body.image_url
        image_inputs = list(body.image_inputs or [])
        images = list(body.images or [])
        aliases = [str(x).strip() for x in (body.aliases or body.image_aliases or []) if str(x).strip()]

        if image_inputs:
            for item in image_inputs:
                if not isinstance(item, dict):
                    continue
                if item.get("file_path"):
                    images.append(image_path_to_data_uri(str(item["file_path"])))
                elif item.get("data_url"):
                    images.append(str(item["data_url"]))
                elif item.get("url"):
                    images.append(str(item["url"]))
                elif item.get("image"):
                    images.append(str(item["image"]))
        elif body.image_paths:
            images.extend(image_path_to_data_uri(path) for path in body.image_paths if path.strip())

        if not image and not images and body.image_path:
            image = image_path_to_data_uri(body.image_path)

        client = px.PixmaxClient()
        result = client.create_video(
            prompt=body.prompt,
            image=image,
            images=images if images else None,
            aliases=aliases if aliases else None,
            model=body.model,
            duration=body.duration,
            resolution=body.resolution,
            aspect_ratio=body.aspect_ratio,
        )
        task_id = result.get("task_id", "")
        if task_id:
            TaskDB.add(
                task_id=task_id,
                account_id=0,
                task_type=TaskType.IMAGE_TO_VIDEO,
                prompt=body.prompt,
                model=f"pixmax:{body.model}",
            )
        return {"data": result}
    except px.PixmaxError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/pixmax/tasks/{task_id}/status")
def pixmax_task_status(task_id: str):
    """查询 Pixmax 任务状态，归一化为前端通用结构"""
    try:
        client = px.PixmaxClient()
        detail = client.get_task(task_id)
        status = detail.get("status", "pending")
        video_url = detail.get("video_url", "") or ""
        progress = detail.get("progress")

        mapped_status = status
        if status == "success":
            mapped_status = "completed"
            if video_url:
                TaskDB.update_status(task_id, "completed", video_url)
        elif status == "failed":
            TaskDB.update_status(task_id, "failed")

        return {"data": {
            "status": mapped_status,
            "video_url": video_url,
            "progress": progress,
            "queue_position": None,
            "fail_reason": detail.get("error", ""),
        }}
    except px.PixmaxError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== QuickFrame 通道（独立账号库 + 临时邮箱注册）====================

@app.get("/quickframe/config")
def quickframe_get_config():
    """返回 QuickFrame 通道配置状态（YesCaptcha key 脱敏 / 代理参数）"""
    return {"data": qf.config_status()}


@app.post("/quickframe/config")
def quickframe_update_config(body: QuickFrameConfigUpdate):
    """保存 QuickFrame 通道配置"""
    qf.save_config(
        yescap_key=body.yescap_key,
        use_proxy=body.use_proxy,
        proxy_local_host=body.proxy_local_host,
        proxy_local_port=body.proxy_local_port,
        proxy_remote_host=body.proxy_remote_host,
        proxy_remote_port=body.proxy_remote_port,
        proxy_user=body.proxy_user,
        proxy_pass=body.proxy_pass,
        requests_proxy=body.requests_proxy,
    )
    return {"data": qf.config_status()}


@app.get("/quickframe/tempmail/domains")
def quickframe_temp_domains():
    """临时邮箱可用域名列表（供前端选择）"""
    try:
        return {"data": {"domains": qf.list_temp_domains()}}
    except qf.QuickFrameError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/quickframe/test-proxy")
def quickframe_test_proxy():
    """测试动态 IP / 出口连通性（注册前自检）：查出口 IP + 探 authorize。"""
    try:
        return {"data": qf.test_proxy()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/quickframe/accounts")
def quickframe_list_accounts():
    return {"data": QfAccountDB.list_all()}


@app.get("/quickframe/stats")
def quickframe_stats():
    """渠道三出片统计：剩余账号数 + 各状态出片数。"""
    return {"data": TaskDB.quickframe_stats()}


@app.delete("/quickframe/accounts/{account_id}")
def quickframe_delete_account(account_id: int):
    account = QfAccountDB.get(account_id)
    QfAccountDB.delete(account_id)
    if account:
        _release_mailbox_channel_by_email(account.get("email", ""), "quickframe")
    return {"message": "deleted"}


@app.post("/quickframe/accounts/{account_id}/refresh")
def quickframe_refresh_account(account_id: int):
    """用 cs_session 重新换取 Bearer（24h 有效）"""
    account = QfAccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")
    try:
        bearer = qf.refresh_bearer(account["cs_session"])
        QfAccountDB.update_tokens(account_id, bearer=bearer, status="active")
        return {"data": {"ok": True}}
    except qf.QuickFrameError as e:
        QfAccountDB.update_status(account_id, "expired")
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/quickframe/register")
def quickframe_register(body: QuickFrameRegister):
    """从全局邮箱库领取 OAuth 邮箱并批量注册 QuickFrame 账号。"""
    claimed_mailboxes: list[dict] = []
    try:
        count = max(1, min(int(body.count or 1), 50))
        claimed_mailboxes = MailboxDB.claim_for_channel(
            "quickframe",
            count=count,
            mailbox_ids=body.mailbox_ids,
            credential_type="oauth",
            provider="microsoft",
            lease_seconds=21600,
        )
        results = qf.register_batch(
            count=count,
            concurrency=body.concurrency,
            domain=body.domain or None,
            mailboxes=claimed_mailboxes,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except qf.QuickFrameError as e:
        for mailbox in claimed_mailboxes:
            MailboxDB.mark_channel_usage(
                mailbox["id"], "quickframe", "failed",
                account_email=mailbox.get("email", ""), error=str(e),
            )
        raise HTTPException(status_code=400, detail=str(e))

    saved = []
    for r in results.get("success", []):
        try:
            account = QfAccountDB.add(
                email=r["email"],
                cs_session=r.get("cs_session", ""),
                bearer=r.get("bearer", ""),
                status="active",
            )
            saved.append(account)
            _mark_mailbox_channel_by_email(r.get("email", ""), "quickframe")
        except Exception:  # noqa: BLE001 — 单条入库失败不影响整体
            pass
    for failed in results.get("failed", []):
        _mark_mailbox_channel_by_email(
            failed.get("email", ""),
            "quickframe",
            "failed",
            error=failed.get("err", "") or failed.get("error", ""),
        )

    return {"data": {
        "success": saved,
        "failed": results.get("failed", []),
        "success_count": len(saved),
        "failed_count": len(results.get("failed", [])),
    }}


@app.post("/quickframe/tasks/create")
def quickframe_create_task(body: QuickFrameTaskCreate):
    """通过 QuickFrame 提交图生视频任务（后台线程执行，返回内存 task_id）"""
    account = QfAccountDB.get(body.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")
    if not account.get("bearer"):
        raise HTTPException(status_code=400, detail="该账号缺少 Bearer，请先刷新 token")
    try:
        task_id = qf.submit_generation(
            bearer=account["bearer"],
            image_path=body.image_path,
            prompt=body.prompt,
            aspect_ratio=body.aspect_ratio,
            duration=body.duration,
            generate_audio=body.generate_audio,
        )
        TaskDB.add(
            task_id=task_id,
            account_id=body.account_id,
            task_type=TaskType.IMAGE_TO_VIDEO,
            prompt=body.prompt,
            model="quickframe:seedance-2",
        )
        # 渠道三：一个账号只能生成一个视频，提交成功后立即删除该账号
        QfAccountDB.delete(body.account_id)
        return {"data": {"task_id": task_id, "account_deleted": True}}
    except qf.QuickFrameError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/quickframe/tasks/{task_id}/status")
def quickframe_task_status(task_id: str):
    """查询 QuickFrame 任务状态，归一化为前端通用结构"""
    detail = qf.get_job_status(task_id)
    status = detail.get("status", "processing")
    video_url = detail.get("video_url", "") or ""
    if status == "completed" and video_url:
        TaskDB.update_status(task_id, "completed", video_url)
    elif status == "failed":
        TaskDB.update_status(task_id, "failed")
    return {"data": {
        "status": status,
        "video_url": video_url,
        "progress": detail.get("progress"),
        "queue_position": detail.get("queue_position"),
        "fail_reason": detail.get("fail_reason", ""),
    }}


# ==================== ChatGPT2API 生图通道（渠道五）配置与任务 ====================

@app.get("/chatgpt2api/config")
def chatgpt2api_get_config():
    """返回 ChatGPT2API 生图通道配置状态（API Key 脱敏）"""
    api_key = cg.get_api_key()
    env_override = bool(os.environ.get("CHATGPT2API_API_KEY", "").strip())
    masked = api_key[:6] + "..." + api_key[-4:] if len(api_key) > 10 else ("***" if api_key else "")
    return {"data": {
        "configured": bool(api_key),
        "api_key_masked": masked,
        "base_url": cg.get_base_url(),
        "env_override": env_override,
    }}


@app.post("/chatgpt2api/config")
def chatgpt2api_update_config(body: ChatGPT2APIConfigUpdate):
    """保存 ChatGPT2API 配置，可选测试连接"""
    if body.api_key or body.base_url:
        cg.save_config(api_key=body.api_key, base_url=body.base_url)

    api_key = cg.get_api_key()
    env_override = bool(os.environ.get("CHATGPT2API_API_KEY", "").strip())
    masked = api_key[:6] + "..." + api_key[-4:] if len(api_key) > 10 else ("***" if api_key else "")
    result = {
        "configured": bool(api_key),
        "api_key_masked": masked,
        "base_url": cg.get_base_url(),
        "env_override": env_override,
    }

    if body.test:
        try:
            client = cg.ChatGPT2APIClient()
            test_result = client.test_connection()
            result["test"] = {"ok": True, "models": test_result.get("models", [])}
        except cg.ChatGPT2APIError as e:
            result["test"] = {"ok": False, "error": str(e)}
        except Exception as e:
            result["test"] = {"ok": False, "error": str(e)}
    return {"data": result}


@app.post("/chatgpt2api/images/create")
def chatgpt2api_create_image(body: ChatGPT2APIImageCreate):
    """通过 ChatGPT2API 提交图片生成 / 图生图任务。"""
    try:
        client = cg.ChatGPT2APIClient()
        result = client.create_image(
            prompt=body.prompt,
            model=body.model,
            size=body.size,
            resolution=body.resolution,
            image_path=body.image_path,
            image_url=body.image_url,
            reference_images=body.reference_images,
        )
        task_id = result.get("task_id", "")
        image_url = result.get("image_url", "") or result.get("video_url", "") or result.get("cdn_url", "") or result.get("download_url", "") or ""
        status = result.get("status", "completed" if image_url else "pending")
        if task_id:
            TaskDB.add(
                task_id=task_id,
                account_id=0,
                task_type=TaskType.TEXT_TO_VIDEO,
                prompt=body.prompt,
                model=f"chatgpt2api-image:{body.model}",
                status="completed" if image_url else status,
                video_url=image_url,
            )
        return {"data": result}
    except cg.ChatGPT2APIError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/chatgpt2api/tasks/{task_id}/status")
def chatgpt2api_task_status(task_id: str):
    """查询 ChatGPT2API 图片任务状态。同步接口结果会缓存在本地任务缓存中。"""
    detail = cg.ChatGPT2APIClient().get_task_status(task_id)
    status = detail.get("status", "completed")
    image_url = detail.get("image_url", "") or detail.get("video_url", "") or ""
    if status == "completed" and image_url:
        TaskDB.update_status(task_id, "completed", image_url)
    elif status == "failed":
        TaskDB.update_status(task_id, "failed")
    return {"data": {
        "status": status,
        "video_url": image_url,
        "image_url": image_url,
        "media_type": "image",
        "progress": 100 if status == "completed" else None,
        "queue_position": None,
        "fail_reason": detail.get("error", ""),
    }}


# ==================== Dola 通道（渠道六）账号与任务 ====================

def _dola_save_current_account(name: str = "", note: str = "") -> dict:
    status = dl.account_status()
    account_name = name.strip() or "Dola 采集账号"
    return DolaAccountDB.upsert(
        name=account_name,
        env_file=status.get("env_file", ""),
        profile_dir=status.get("profile_dir", ""),
        cookie_masked=status.get("cookie_masked", ""),
        user_agent=status.get("user_agent", ""),
        device_id_masked=status.get("device_id_masked", ""),
        web_id_masked=status.get("web_id_masked", ""),
        fp_masked=status.get("fp_masked", ""),
        status="active" if status.get("configured") else "incomplete",
        note=note,
    )


def _dola_status_for_paths(env_file: str = "", profile_dir: str = "") -> dict:
    return dl.account_status(env_file_override=env_file, profile_dir_override=profile_dir)


def _dola_save_account_from_status(name: str, note: str, status: dict) -> dict:
    account_name = name.strip() or "Dola 采集账号"
    return DolaAccountDB.upsert(
        name=account_name,
        env_file=status.get("env_file", ""),
        profile_dir=status.get("profile_dir", ""),
        cookie_masked=status.get("cookie_masked", ""),
        user_agent=status.get("user_agent", ""),
        device_id_masked=status.get("device_id_masked", ""),
        web_id_masked=status.get("web_id_masked", ""),
        fp_masked=status.get("fp_masked", ""),
        status="active" if status.get("configured") else "incomplete",
        note=note,
    )


def _dola_capture_paths(capture_id: str) -> tuple[str, str]:
    runtime_dir = os.path.join(dl.RUNTIME_DIR, "accounts", capture_id)
    return os.path.join(runtime_dir, ".env.dola"), os.path.join(runtime_dir, "profile")


def _dola_capture_one(body: DolaAccountGrab, index: int, total: int) -> dict:
    capture_id = f"{int(index)}-{uuid.uuid4().hex[:8]}"
    env_file, profile_dir = _dola_capture_paths(capture_id)
    base_name = body.name.strip() or f"Dola 采集账号 {index}"
    account_name = base_name if total <= 1 else f"{base_name} #{index}"
    result = dl.grab_account(
        visible=body.visible,
        keep_open=body.keep_open,
        wait_ms=body.wait_ms,
        proxy=body.proxy,
        send_hi=True,
        hi_text=body.hi_text or "你好",
        close_login=body.close_login,
        env_file=env_file,
        profile_dir=profile_dir,
    )
    account = _dola_save_account_from_status(account_name, body.note, result.get("account") or {})
    return {"index": index, "account": account, "capture": result}


def _dola_normalized_video_duration(duration: int) -> int:
    try:
        requested = int(duration or 5)
    except (TypeError, ValueError):
        requested = 5
    return min(15, max(5, ((requested + 4) // 5) * 5))


def _dola_video_quota_cost(duration: int) -> int:
    normalized = _dola_normalized_video_duration(duration)
    return max(1, normalized // 5)


def _dola_runtime_task_is_active(task: dict) -> bool:
    status = str(task.get("status") or "").strip().lower()
    if status in {"completed", "failed", "cancelled", "canceled"}:
        return False
    if task.get("video_url") or task.get("local_path"):
        return False
    if status in {"pending", "queued", "submitting", "processing", "collecting", "collectable", "running"}:
        return True
    try:
        progress = int(task.get("progress") or 0)
    except (TypeError, ValueError):
        progress = 0
    return bool(status or task.get("task_id")) and progress < 100


def _dola_runtime_active_tasks_for_account(account_id: int) -> list[dict]:
    if not account_id:
        return []
    active_tasks: list[dict] = []
    try:
        tasks = dl.list_tasks(1000)
    except Exception:
        tasks = []
    for task in tasks:
        try:
            task_account_id = int(task.get("account_id") or 0)
        except (TypeError, ValueError):
            task_account_id = 0
        if task_account_id != account_id:
            continue
        if not _dola_runtime_task_is_active(task):
            continue
        active_tasks.append({
            "task_id": task.get("task_id") or "",
            "status": task.get("status") or "",
            "progress": task.get("progress"),
            "conversation_id": task.get("conversation_id") or "",
            "page_url": task.get("page_url") or "",
        })
    return active_tasks


def _dola_account_runtime_status(account: dict | None) -> dict:
    if not account:
        return {"configured": False, "missing": ["account"]}
    try:
        return _dola_status_for_paths(account.get("env_file", ""), account.get("profile_dir", ""))
    except Exception as e:
        return {"configured": False, "missing": [f"status_check_failed: {e}"]}


def _dola_account_is_usable(account: dict | None) -> bool:
    if not account or account.get("status") != "active":
        return False
    return bool(_dola_account_runtime_status(account).get("configured"))


def _dola_active_task_count(account_id: int) -> int:
    db_count = TaskDB.active_count_for_account(account_id, model_prefix="dola:")
    runtime_count = len(_dola_runtime_active_tasks_for_account(account_id))
    return max(db_count, runtime_count)


def _dola_account_busy_detail(account: dict | None) -> str:
    if not account:
        return "渠道六账号正在生成中"
    name = account.get("name") or f"Dola账号 #{account.get('id')}"
    return f"渠道六账号「{name}」正在生成中：Dola 同一账号一次只能跑一个视频任务，请等待当前任务完成后再提交。"


def _dola_accounts_busy_detail(accounts: list[dict]) -> str:
    prefix = "渠道六账号"
    if len(accounts) == 1:
        account = accounts[0]
        name = account.get("name") or f"Dola账号 #{account.get('id')}"
        return f"{prefix}「{name}」有额度但正在生成中：Dola 同一账号一次只能跑一个视频任务，请等待当前任务完成后再提交。"
    names = "、".join(
        (account.get("name") or f"Dola账号 #{account.get('id')}")
        for account in accounts[:3]
    )
    suffix = "等" if len(accounts) > 3 else ""
    return f"{prefix}有额度但正在生成中：{names}{suffix}。Dola 同一账号一次只能跑一个视频任务，请等待当前任务完成后再提交。"



def _dola_pick_account(
    account_id: int = 0,
    quota_cost: int = 0,
    exclude_account_ids: set[int] | list[int] | tuple[int, ...] | None = None,
) -> dict | None:
    excluded_ids: set[int] = set()
    for raw_id in exclude_account_ids or []:
        try:
            parsed_id = int(raw_id or 0)
        except (TypeError, ValueError):
            continue
        if parsed_id:
            excluded_ids.add(parsed_id)

    if account_id:
        if account_id in excluded_ids:
            raise HTTPException(status_code=400, detail="渠道六账号已尝试失败，不能作为本次自动重试账号")
        account = DolaAccountDB.get(account_id)
        if not account:
            raise HTTPException(status_code=404, detail="dola account not found")
        runtime_status = _dola_account_runtime_status(account)
        if account.get("status") != "active" or not runtime_status.get("configured"):
            missing = ", ".join(runtime_status.get("missing") or [])
            raise HTTPException(status_code=400, detail=f"渠道六账号不完整或未激活，请重新采集账号参数。缺少: {missing or 'unknown'}")
        if _dola_active_task_count(account_id) > 0:
            raise HTTPException(status_code=409, detail=_dola_account_busy_detail(account))
        if quota_cost > 0:
            try:
                account = DolaAccountDB.reserve_daily_video_quota(account_id, quota_cost)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
        return account

    accounts = DolaAccountDB.list_all()
    if not accounts:
        raise HTTPException(status_code=400, detail="请先在账号库采集渠道六账号")

    available_accounts = [
        a for a in accounts
        if int(a.get("id") or 0) not in excluded_ids
    ]
    if not available_accounts:
        raise HTTPException(
            status_code=409 if excluded_ids else 400,
            detail="没有其它渠道六账号可重试" if excluded_ids else "请先在账号库采集渠道六账号",
        )

    active_accounts = [a for a in available_accounts if _dola_account_is_usable(a)]
    if not active_accounts:
        raise HTTPException(
            status_code=409 if excluded_ids else 400,
            detail="没有其它参数完整且 active 的渠道六账号可重试" if excluded_ids else "渠道六账号参数不完整，请重新采集账号参数后再提交",
        )
    candidate_accounts = active_accounts

    busy_by_account_id: dict[int, bool] = {}

    def is_busy(account: dict) -> bool:
        account_key = int(account.get("id") or 0)
        if account_key not in busy_by_account_id:
            busy_by_account_id[account_key] = _dola_active_task_count(account_key) > 0
        return busy_by_account_id[account_key]

    def has_quota(account: dict) -> bool:
        if quota_cost <= 0:
            return True
        return int(account.get("daily_video_remaining") or 0) >= quota_cost

    quota_ready_accounts = [a for a in candidate_accounts if has_quota(a)]
    if quota_cost > 0 and not quota_ready_accounts:
        remaining_info = "、".join(
            f"{a.get('name') or 'Dola账号 #' + str(a.get('id') or 0)}剩余{int(a.get('daily_video_remaining') or 0)}"
            for a in candidate_accounts[:5]
        )
        raise HTTPException(
            status_code=400,
            detail=f"渠道六账号今日额度不足：本次需要 {quota_cost} 个额度，当前账号剩余：{remaining_info}",
        )

    idle_accounts = [a for a in quota_ready_accounts if not is_busy(a)]
    if not idle_accounts:
        raise HTTPException(
            status_code=409,
            detail=_dola_accounts_busy_detail(quota_ready_accounts),
        )

    idle_accounts.sort(key=lambda a: (
        -int(a.get("daily_video_remaining") or 0),
        float(a.get("updated_at") or 0),
        int(a.get("id") or 0),
    ))
    if quota_cost > 0:
        for account in idle_accounts:
            try:
                reserved = DolaAccountDB.reserve_daily_video_quota(int(account.get("id") or 0), quota_cost)
                _dola_touch_account(int(account.get("id") or 0))
                return reserved
            except ValueError:
                continue
        remaining_info = "、".join(
            f"{a.get('name') or 'Dola账号 #' + str(a.get('id') or 0)}剩余{int(a.get('daily_video_remaining') or 0)}"
            for a in idle_accounts[:5]
        )
        raise HTTPException(
            status_code=400,
            detail=f"渠道六账号今日额度不足：本次需要 {quota_cost} 个额度，当前账号剩余：{remaining_info}",
        )

    picked = idle_accounts[0]
    _dola_touch_account(int(picked.get("id") or 0))
    return picked


def _dola_touch_account(account_id: int) -> None:
    """Refresh an account's updated_at so the picker rotates to the next account next time (round-robin)."""
    if not account_id:
        return
    try:
        from .database import get_connection
        conn = get_connection()
        conn.execute(
            "UPDATE dola_accounts SET updated_at = strftime('%s','now') WHERE id = ?",
            (account_id,),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass


# ==================== OreateAI 渠道八账号池 ====================

def _oreateai_public_account(account: dict) -> dict:
    cookies = account.get("cookies") if isinstance(account.get("cookies"), list) else []
    public = {key: value for key, value in account.items() if key not in {"password", "cookies"}}
    public["cookie_count"] = len(cookies)
    public["configured"] = bool(cookies)
    return public


_OREATEAI_BASE_URL = "https://www.oreateai.com"
_OREATEAI_REFERER = f"{_OREATEAI_BASE_URL}/home/vertical/aiVideo/zh"


def _oreateai_http_session(account: dict) -> requests.Session:
    cookies = account.get("cookies") if isinstance(account.get("cookies"), list) else []
    if not cookies:
        raise ValueError("渠道八账号缺少 Cookie")
    session = requests.Session()
    for cookie in cookies:
        name = str(cookie.get("name") or "").strip()
        value = cookie.get("value")
        if not name or not isinstance(value, str):
            continue
        domain = str(cookie.get("domain") or "www.oreateai.com").strip().lstrip(".")
        path = str(cookie.get("path") or "/").strip() or "/"
        session.cookies.set(name, value, domain=domain, path=path)
    return session


def _oreateai_get_json(session: requests.Session, account: dict, path: str) -> dict:
    response = session.get(
        f"{_OREATEAI_BASE_URL}{path}",
        headers={
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Client-Type": "pc",
            "Locale": "zh-CN",
            "Referer": _OREATEAI_REFERER,
            "User-Agent": account.get("user_agent") or "Mozilla/5.0",
        },
        timeout=25,
    )
    response.raise_for_status()
    payload = response.json()
    status = payload.get("status") if isinstance(payload, dict) else None
    site_code = status.get("code") if isinstance(status, dict) else None
    if site_code not in (None, 0):
        message = status.get("errMsg") or status.get("msg") or "OreateAI 请求失败"
        raise ValueError(f"{message}（code={site_code}）")
    data = payload.get("data") if isinstance(payload, dict) else None
    return data if isinstance(data, dict) else {}


def _oreateai_credit_snapshot(account: dict, session: requests.Session | None = None) -> dict:
    own_session = session is None
    session = session or _oreateai_http_session(account)
    try:
        rest = _oreateai_get_json(session, account, "/bizapi/point/getrestpoints")
        detail = _oreateai_get_json(session, account, "/oreate/account/getpointdetail")
    finally:
        if own_session:
            session.close()
    if "restPoint" not in rest:
        raise ValueError("未读取到渠道八积分，账号登录态可能已失效")
    return {
        "rest_points": rest.get("restPoint", 0),
        "detail": {
            key: {
                "amount": value.get("amount", 0),
                "end_time": value.get("endTime"),
            } if isinstance(value, dict) else None
            for key, value in {
                "daily": detail.get("daily"),
                "pro": detail.get("pro"),
                "bonus": detail.get("bonus"),
            }.items()
        },
    }


def _oreateai_pending_grant(session: requests.Session, account: dict) -> dict | None:
    user_info = _oreateai_get_json(session, account, "/oreate/user/getuserinfo")
    basic_info = user_info.get("basicInfo")
    if not isinstance(basic_info, dict) or basic_info.get("isLogin") is not True:
        raise ValueError("渠道八账号登录态已失效")
    grant = user_info.get("pointGrantInfo")
    if not isinstance(grant, dict) or not grant.get("pointGrant"):
        return None
    return {
        "type": grant.get("pointGrantType"),
        "points": grant.get("pointGrant"),
        "message": str(grant.get("pointGrantMsg") or ""),
    }


@app.get("/oreateai/accounts")
def oreateai_list_accounts():
    return {"data": [_oreateai_public_account(account) for account in OreateAIAccountDB.list_all()]}


@app.get("/oreateai/accounts/{account_id}/credits")
def oreateai_get_credits(account_id: int):
    account = OreateAIAccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="OreateAI account not found")
    try:
        return {"data": _oreateai_credit_snapshot(account)}
    except (requests.RequestException, ValueError) as error:
        raise HTTPException(status_code=502, detail=f"查询渠道八积分失败：{error}") from error


@app.post("/oreateai/accounts/{account_id}/credits/claim")
def oreateai_claim_credits(account_id: int):
    account = OreateAIAccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="OreateAI account not found")
    session = None
    try:
        session = _oreateai_http_session(account)
        before = _oreateai_credit_snapshot(account, session)
        pending_grant = _oreateai_pending_grant(session, account)
        _oreateai_get_json(session, account, "/oreate/account/getfirstusepoint")
        # OreateAI 异步入账；短暂等待只处理快速到账，较慢的情况由前端继续轮询。
        time.sleep(1)
        after = _oreateai_credit_snapshot(account, session)
        amount = max(
            0,
            int(after.get("rest_points") or 0) - int(before.get("rest_points") or 0),
        )
        claim_requested = pending_grant is not None
        return {
            "data": {
                **after,
                "claimed": amount > 0,
                "claimed_points": amount,
                "before_points": before.get("rest_points", 0),
                "claim_requested": claim_requested,
                "pending": claim_requested and amount == 0,
                "already_claimed": not claim_requested and amount == 0,
                "pending_grant": pending_grant,
            }
        }
    except (requests.RequestException, ValueError, TypeError) as error:
        raise HTTPException(status_code=502, detail=f"领取渠道八积分失败：{error}") from error
    finally:
        if session is not None:
            session.close()


@app.get("/internal/oreateai/accounts/{account_id}/session")
def oreateai_get_account_session(account_id: int, request: Request):
    _require_internal_session_access(request)
    account = OreateAIAccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="OreateAI account not found")
    return {"data": account}


@app.post("/oreateai/accounts")
def oreateai_import_account(body: OreateAIAccountImport):
    try:
        account = OreateAIAccountDB.upsert(
            email=body.email,
            password=body.password,
            cookies=body.cookies,
            user_agent=body.user_agent,
            location=body.location,
            status=body.status,
            note=body.note,
        )
        _mark_mailbox_channel_by_email(body.email, "oreateai")
        return {"data": _oreateai_public_account(account)}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))


@app.delete("/oreateai/accounts/{account_id}")
def oreateai_delete_account(account_id: int):
    account = OreateAIAccountDB.get(account_id)
    OreateAIAccountDB.delete(account_id)
    if account:
        _release_mailbox_channel_by_email(account.get("email", ""), "oreateai")
    return {"message": "deleted"}


# ==================== Lovart 渠道七账号池与任务 ====================

def _lovart_public_account(account: dict) -> dict:
    cookies = account.get("cookies") if isinstance(account.get("cookies"), list) else []
    local_storage = account.get("local_storage") if isinstance(account.get("local_storage"), dict) else {}
    session_storage = account.get("session_storage") if isinstance(account.get("session_storage"), dict) else {}
    indexed_db = account.get("indexed_db") if isinstance(account.get("indexed_db"), list) else []
    public = {k: v for k, v in account.items() if k not in {"cookies", "local_storage", "session_storage", "indexed_db"}}
    public["cookie_count"] = len(cookies)
    public["local_storage_count"] = len(local_storage)
    public["session_storage_count"] = len(session_storage)
    public["indexed_db_count"] = len(indexed_db)
    public["configured"] = bool(lv.has_auth_token(account))
    public["has_auth_token"] = public["configured"]
    return public


@app.get("/lovart/accounts")
def lovart_list_accounts():
    """Lovart 渠道七账号库。"""
    return {"data": [_lovart_public_account(account) for account in LovartAccountDB.list_all()]}


@app.post("/lovart/accounts")
def lovart_import_account(body: LovartAccountImport):
    """保存 Lovart Google OAuth 登录态。"""
    try:
        account = LovartAccountDB.upsert(
            email=body.email,
            cookie=body.cookie,
            cookies=body.cookies,
            user_agent=body.user_agent,
            location=body.location,
            local_storage=body.local_storage,
            session_storage=body.session_storage,
            indexed_db=body.indexed_db,
            status=body.status,
            note=body.note,
        )
        _mark_mailbox_channel_by_email(body.email, "lovart")
        return {"data": _lovart_public_account(account)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/lovart/accounts")
def lovart_delete_all_accounts():
    accounts = LovartAccountDB.list_all()
    deleted = LovartAccountDB.delete_all()
    for account in accounts:
        _release_mailbox_channel_by_email(account.get("email", ""), "lovart")
    return {"data": {"deleted": deleted}}


@app.delete("/lovart/accounts/{account_id}")
def lovart_delete_account(account_id: int):
    account = LovartAccountDB.get(account_id)
    LovartAccountDB.delete(account_id)
    if account:
        _release_mailbox_channel_by_email(account.get("email", ""), "lovart")
    return {"message": "deleted"}


@app.get("/lovart/models")
def lovart_models(account_id: int = 0):
    """返回 Lovart 可选模型。"""
    try:
        account = lv.pick_account(account_id) if account_id else None
        return {"data": lv.models(account)}
    except lv.LovartError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/lovart/tasks/create")
def lovart_create_task(body: LovartImageCreate):
    """通过 Lovart 提交图片生成任务。"""
    try:
        account = lv.pick_account(body.account_id)
        reference_images = [item for item in [*body.reference_images, *body.images, body.data_url] if str(item or "").strip()]
        result = lv.create_image(
            account,
            prompt=body.prompt,
            project_id=body.project_id or body.projectId,
            cid=body.cid,
            model=body.model,
            aspect_ratio=body.aspectRatio or body.aspect_ratio,
            size=body.size,
            quality=body.quality,
            image_path=body.image_path,
            image_url=body.image_url or body.image,
            reference_images=reference_images,
            with_pricing=body.with_pricing,
        )
        task_id = result.get("task_id", "")
        image_url = result.get("image_url", "") or ""
        if task_id:
            TaskDB.add(
                task_id=task_id,
                account_id=int(account.get("id") or 0),
                task_type=TaskType.TEXT_TO_VIDEO,
                prompt=body.prompt,
                model=f"lovart:{result.get('model') or body.model}",
                status=result.get("status") or "processing",
                video_url=image_url,
            )
        result["account_id"] = int(account.get("id") or 0)
        result["account_name"] = account.get("email", "") or f"Lovart账号 #{account.get('id') or 0}"
        return {"data": result}
    except lv.LovartError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/lovart/tasks/{task_id}/status")
def lovart_task_status(task_id: str):
    """查询 Lovart 图片生成状态。"""
    try:
        task = TaskDB.get(task_id) or {}
        account_id = int(task.get("account_id") or 0)
        account = lv.pick_account(account_id) if account_id else lv.pick_account(0)
        result = lv.get_task_status(account, task_id)
        status = result.get("status", "pending")
        image_url = result.get("image_url", "") or ""
        if status == "completed" and image_url:
            TaskDB.update_status(task_id, "completed", image_url)
        elif status == "failed":
            TaskDB.update_status(task_id, "failed")
        elif task:
            TaskDB.update_status(task_id, status if status in {"pending", "processing"} else "processing")
        result["account_id"] = int(account.get("id") or 0)
        result["account_name"] = account.get("email", "") or f"Lovart账号 #{account.get('id') or 0}"
        return {"data": result}
    except lv.LovartError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/dola/config")
def dola_get_config():
    """返回 Dola 通道配置、登录态和模型选项。"""
    try:
        return {"data": dl.account_status()}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/dola/config")
def dola_update_config(body: DolaConfigUpdate):
    """保存 Dola 通道配置。"""
    try:
        dl.save_config(
            proxy=body.proxy,
            env_file=body.env_file,
            profile_dir=body.profile_dir,
            send_mode=body.send_mode,
            browser_headless=body.browser_headless,
        )
        return {"data": dl.account_status()}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/dola/models")
def dola_models():
    """返回渠道六可选模型和比例。"""
    return {"data": {"models": dl.DEFAULT_MODELS, "ratios": dl.DEFAULT_RATIOS}}


@app.get("/dola/accounts")
def dola_list_accounts():
    """Dola 采集账号库。"""
    accounts = DolaAccountDB.list_all()
    for account in accounts:
        account_id = int(account.get("id") or 0)
        runtime_status = _dola_account_runtime_status(account)
        runtime_active_tasks = _dola_runtime_active_tasks_for_account(account_id) if account_id else []
        db_active_count = TaskDB.active_count_for_account(account_id, model_prefix="dola:") if account_id else 0
        active_count = max(db_active_count, len(runtime_active_tasks))
        account["configured"] = bool(runtime_status.get("configured"))
        account["missing"] = runtime_status.get("missing") or []
        account["effective_status"] = "active" if account.get("status") == "active" and account["configured"] else "incomplete"
        account["active_task_count"] = active_count
        account["runtime_active_tasks"] = runtime_active_tasks
        account["busy"] = active_count > 0
    return {"data": accounts}


@app.post("/dola/accounts")
def dola_import_account(body: DolaAccountImport):
    """把已有 Dola API 凭证加入账号库。"""
    try:
        if body.cookie.strip():
            token = (body.ms_token or body.msToken or "").strip()
            status = dl.write_env_from_cookie(body.cookie, env_file=body.env_file, profile_dir=body.profile_dir, ms_token=token)
        else:
            status = _dola_status_for_paths(body.env_file, body.profile_dir)
        account = _dola_save_account_from_status(body.name, body.note, status)
        _mark_mailbox_channel_by_email(body.name, "dola")
        return {"data": account}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/dola/accounts")
def dola_delete_all_accounts():
    accounts = DolaAccountDB.list_all()
    deleted = DolaAccountDB.delete_all()
    for account in accounts:
        _release_mailbox_channel_by_email(account.get("name", ""), "dola")
    return {"data": {"deleted": deleted}}


@app.delete("/dola/accounts/{account_id}")
def dola_delete_account(account_id: int):
    account = DolaAccountDB.get(account_id)
    DolaAccountDB.delete(account_id)
    if account:
        _release_mailbox_channel_by_email(account.get("name", ""), "dola")
    return {"message": "deleted"}


@app.post("/dola/open-browser")
def dola_open_browser(body: DolaAccountOpenBrowser | None = None):
    """打开 Dola 浏览器会话，可选直达指定任务会话。"""
    try:
        payload = body or DolaAccountOpenBrowser()
        conversation_id = (payload.conversation_id or "").strip()
        page_url = ""
        if payload.task_id:
            try:
                task_detail = dl.get_task_status(payload.task_id)
                if not conversation_id:
                    conversation_id = str(task_detail.get("conversation_id") or "").strip()
                page_url = str(task_detail.get("page_url") or "").strip()
            except dl.DolaError:
                conversation_id = ""
        target_url = f"https://www.dola.com/chat/{conversation_id}" if conversation_id else page_url
        result = None
        if payload.task_id:
            try:
                result = dl.open_task_browser(payload.task_id, url=target_url, fallback_account=False)
            except dl.DolaError as e:
                if e.status_code == 404:
                    raise
                result = None
            except Exception:
                result = None
        if not result or not result.get("ok"):
            result = dl.open_account_browser(url=target_url)
            result["task_session"] = False
            result["task_session_missing_reason"] = (
                result.get("task_session_missing_reason") or "任务浏览器会话不可用，已回退打开账号浏览器。"
            )
        if conversation_id:
            result["conversation_id"] = conversation_id
            dl.remember_browser_session_for_conversation(conversation_id, result)
        return {"data": result}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/dola/accounts/{account_id}/open-browser")
def dola_open_account_browser(account_id: int, body: DolaAccountOpenBrowser | None = None):
    """打开 Dola 登录浏览器窗口，可选直达指定任务会话。"""
    try:
        account = DolaAccountDB.get(account_id)
        if not account:
            raise HTTPException(status_code=404, detail="dola account not found")
        payload = body or DolaAccountOpenBrowser()
        conversation_id = (payload.conversation_id or "").strip()
        page_url = ""
        if payload.task_id:
            try:
                task_detail = dl.get_task_status(payload.task_id)
                if not conversation_id:
                    conversation_id = str(task_detail.get("conversation_id") or "").strip()
                page_url = str(task_detail.get("page_url") or "").strip()
            except dl.DolaError:
                conversation_id = ""
        target_url = f"https://www.dola.com/chat/{conversation_id}" if conversation_id else page_url
        result = dl.open_account_browser(
            profile_dir=account.get("profile_dir", ""),
            env_file=account.get("env_file", ""),
            url=target_url,
        )
        result["task_session"] = False
        if payload.task_id:
            result["task_session_missing_reason"] = "已使用该账号登录态打开任务页面。"
        result["conversation_id"] = conversation_id
        if conversation_id:
            dl.remember_browser_session_for_conversation(conversation_id, result, account)
        return {"data": result}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/dola/accounts/grab")
def dola_grab_account(body: DolaAccountGrab):
    """打开浏览器采集 Dola 登录态，并自动加入账号库。"""
    try:
        count = max(1, min(int(body.count or 1), 100))
        concurrency = max(1, min(int(body.concurrency or 1), 20, count))
        if count == 1:
            item = _dola_capture_one(body, 1, 1)
            return {"data": {"account": item["account"], "capture": item["capture"], "success_count": 1, "failed_count": 0, "success": [item], "failed": []}}

        success: list[dict] = []
        failed: list[dict] = []
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = {executor.submit(_dola_capture_one, body, index, count): index for index in range(1, count + 1)}
            for future in as_completed(futures):
                index = futures[future]
                try:
                    success.append(future.result())
                except Exception as e:  # noqa: BLE001
                    failed.append({"index": index, "error": str(e)})

        success.sort(key=lambda item: item.get("index", 0))
        failed.sort(key=lambda item: item.get("index", 0))
        return {"data": {
            "success_count": len(success),
            "failed_count": len(failed),
            "success": success,
            "failed": failed,
            "account": success[0]["account"] if success else None,
        }}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/dola/tasks/create")
def dola_create_task(body: DolaTaskCreate):
    """通过 Dola API 提交视频生成任务。"""
    try:
        normalized_duration = _dola_normalized_video_duration(body.duration)
        quota_cost = _dola_video_quota_cost(normalized_duration)
        task_id = f"dola-{uuid.uuid4().hex[:12]}"
        with _dola_task_create_lock:
            account = _dola_pick_account(body.account_id, quota_cost=quota_cost, exclude_account_ids=body.exclude_account_ids)
            TaskDB.add(
                task_id=task_id,
                account_id=int(account.get("id") or 0) if account else 0,
                task_type=TaskType.IMAGE_TO_VIDEO if (body.image_path or body.image_url or body.reference_images) else TaskType.TEXT_TO_VIDEO,
                prompt=body.prompt,
                model=f"dola-api:{body.model}:{normalized_duration}s",
                status="pending",
                video_url="",
            )
            try:
                result = dl.create_video(
                    prompt=body.prompt,
                    image_path=body.image_path,
                    image_url=body.image_url,
                    reference_images=body.reference_images,
                    model=body.model,
                    ratio=body.ratio,
                    duration=normalized_duration,
                    account=account,
                    task_id=task_id,
                    quota_cost=quota_cost,
                    retry_account_picker=None,
                    max_empty_sse_retries=0,
                    headless=body.headless,
                )
            except Exception:
                TaskDB.update_status(task_id, "failed")
                raise
        result["account_id"] = int(account.get("id") or 0) if account else 0
        result["account_name"] = account.get("name", "") if account else "API 凭证"
        result["quota_cost"] = quota_cost
        result["send_mode"] = dl.get_send_mode()
        result["send_mode_label"] = next((item["label"] for item in dl.SEND_MODE_OPTIONS if item["id"] == result["send_mode"]), result["send_mode"])
        result["browser_session"] = result["send_mode"] == dl.SEND_MODE_BROWSER
        result["browser_headless"] = bool(result.get("browser_headless")) if result["browser_session"] else False
        return {"data": result}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/dola/tasks")
def dola_list_tasks(limit: int = 100):
    return {"data": dl.list_tasks(limit)}


@app.get("/dola/tasks/{task_id}/status")
def dola_task_status(task_id: str):
    """查询 Dola 任务状态。"""
    try:
        detail = dl.get_task_status(task_id, normalize_failure=False)
        status = detail.get("status", "pending")
        fail_reason = detail.get("fail_reason", "") or detail.get("error", "")
        if status != "failed" and not detail.get("video_url") and not detail.get("local_path"):
            output_text = str(detail.get("output") or "")
            browser_summary = detail.get("browser_summary") if isinstance(detail.get("browser_summary"), dict) else {}
            summary_text = str(browser_summary) if browser_summary else ""
            compact_text = f"{output_text}\n{summary_text}"
            if "以下是为你生成的图片" in compact_text or "返回的是图片，不是视频" in compact_text:
                fail_reason = "返回的是图片，不是视频：Dola 本次会话返回了图片结果，没有进入视频生成。"
                status = "failed"
        video_url = detail.get("video_url", "") or detail.get("local_path", "") or ""
        account_meta = TaskDB.get_dola_task_account(task_id) or {}
        account_id = int(account_meta.get("account_id") or 0)
        account_name = account_meta.get("account_name") or (f"Dola账号 #{account_id}" if account_id else "")
        return {"data": {
            "status": status,
            "video_url": video_url,
            "local_path": detail.get("local_path", ""),
            "conversation_id": detail.get("conversation_id", ""),
            "local_conversation_id": detail.get("local_conversation_id", ""),
            "page_url": detail.get("page_url", ""),
            "reference_images": detail.get("reference_images", []),
            "media_type": detail.get("media_type", "video"),
            "model": detail.get("model", ""),
            "ratio": detail.get("ratio", ""),
            "progress": detail.get("progress"),
            "queue_position": None,
            "send_mode": detail.get("send_mode", "") or dl.get_send_mode(),
            "send_mode_label": detail.get("send_mode_label", "") or next((item["label"] for item in dl.SEND_MODE_OPTIONS if item["id"] == dl.get_send_mode()), dl.get_send_mode()),
            "browser_headless": bool(detail.get("browser_headless")),
            "fail_reason": fail_reason,
            "collectable": bool(detail.get("conversation_id")) and status not in ("completed", "failed", "collecting"),
            "account_id": account_id,
            "account_name": account_name,
        }}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/dola/tasks/collect")
def dola_collect_task(body: DolaTaskCollect):
    """手动采集 Dola 任务结果，避免自动轮询漏掉视频。"""
    try:
        account = DolaAccountDB.get(body.account_id) if body.account_id else None
        result = dl.collect_task(task_id=body.task_id, conversation_id=body.conversation_id, account=account)
        return {"data": result}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/dola/tasks/{task_id}/collect")
def dola_collect_task_by_id(task_id: str, body: DolaTaskCollect | None = None):
    """按任务 ID 手动采集 Dola 任务结果。"""
    try:
        payload = body or DolaTaskCollect()
        account = DolaAccountDB.get(payload.account_id) if payload.account_id else None
        result = dl.collect_task(task_id=task_id, conversation_id=payload.conversation_id, account=account)
        return {"data": result}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== OiiOii 通道（渠道四）配置 ====================

@app.get("/oiioii/config")
def oiioii_get_config():
    """返回 OiiOii 通道配置状态（SDK 可用性 / 代理 / 账号数）"""
    return {"data": oi.config_status()}


@app.post("/oiioii/config")
def oiioii_update_config(body: OiiOiiConfigUpdate):
    """保存 OiiOii 通道配置，可选测试连接"""
    if body.use_proxy is not None or body.proxy_host is not None or body.proxy_port is not None or body.mail_provider is not None:
        oi.save_config(
            use_proxy=body.use_proxy,
            proxy_host=body.proxy_host,
            proxy_port=body.proxy_port,
            mail_provider=body.mail_provider,
        )

    result = oi.config_status()

    if body.test:
        test_result = oi.test_connection()
        result["test"] = test_result

    return {"data": result}


@app.post("/oiioii/register")
def oiioii_register(body: OiiOiiBatchRegister | None = None):
    """全自动注册 OiiOii 账号（支持 count/concurrency 批量并发）"""
    claimed_mailboxes: list[dict] = []
    try:
        count = max(1, min(int(body.count if body else 1) if body else 1, 50))
        concurrency = int(body.concurrency if body else 1) if body else 1
        mail_provider = body.mail_provider if body else None
        resolved_mail_provider = oi._normalize_mail_provider(mail_provider)
        if resolved_mail_provider == "applemail":
            claimed_mailboxes = MailboxDB.claim_for_channel(
                "oiioii",
                count=count,
                mailbox_ids=body.mailbox_ids if body else [],
                credential_type="oauth",
                provider="microsoft",
                lease_seconds=21600,
            )
        if count <= 1:
            result = oi.register_account(
                mail_provider=resolved_mail_provider,
                mailbox=claimed_mailboxes[0] if claimed_mailboxes else None,
            )
            if result.get("email"):
                _mark_mailbox_channel_by_email(result["email"], "oiioii")
            return {"data": result}
        result = oi.register_batch(
            count=count,
            concurrency=concurrency,
            mail_provider=resolved_mail_provider,
            mailboxes=claimed_mailboxes,
        )
        for item in result.get("success", []):
            _mark_mailbox_channel_by_email(item.get("email", ""), "oiioii")
        for item in result.get("failed", []):
            _mark_mailbox_channel_by_email(
                item.get("email", ""),
                "oiioii",
                "failed",
                error=item.get("error", ""),
            )
        return {"data": result}
    except oi.OiiOiiError as e:
        for mailbox in claimed_mailboxes:
            MailboxDB.mark_channel_usage(
                mailbox["id"], "oiioii", "failed",
                account_email=mailbox.get("email", ""), error=str(e),
            )
        raise HTTPException(status_code=500, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except Exception as e:
        for mailbox in claimed_mailboxes:
            MailboxDB.mark_channel_usage(
                mailbox["id"], "oiioii", "failed",
                account_email=mailbox.get("email", ""), error=str(e),
            )
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/oiioii/login")
def oiioii_login(body: OiiOiiAccountImport):
    """用已有账号登录 OiiOii"""
    try:
        result = oi.login_account(body.email, body.password)
        return {"data": result}
    except oi.OiiOiiError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/oiioii/import")
def oiioii_import_account(body: OiiOiiAccountImport):
    """手动导入 OiiOii 账号"""
    try:
        result = oi.import_account(body.email, body.password, body.token)
        return {"data": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/oiioii/accounts/{email}")
def oiioii_delete_account(email: str):
    """删除本地 OiiOii 账号"""
    result = oi.delete_account(email)
    if not result.get("success"):
        raise HTTPException(status_code=404, detail=result.get("error", "删除失败"))
    _release_mailbox_channel_by_email(email, "oiioii")
    return {"message": "deleted"}


@app.post("/oiioii/accounts/cleanup-zero")
def oiioii_cleanup_zero_accounts():
    """删除所有积分为 0 的渠道四账号"""
    try:
        result = oi.cleanup_zero_point_accounts()
        for account in result.get("deleted", []):
            _release_mailbox_channel_by_email(account.get("email", ""), "oiioii")
        return {"data": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/oiioii/accounts/{email}/points")
def oiioii_get_account_points(email: str):
    """查询单个 OiiOii 账号积分并写回账号文件。"""
    try:
        result = oi.get_points(email=email, claim_daily=False)
        return {"data": result}
    except oi.OiiOiiError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/oiioii/points")
def oiioii_get_points():
    """查询所有 OiiOii 账号积分并写回账号文件。"""
    try:
        result = oi.get_all_points(claim_daily=False)
        return {"data": result}
    except oi.OiiOiiError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/oiioii/daily-points")
def oiioii_claim_daily_points():
    """领取所有 OiiOii 账号每日积分并返回最新积分。"""
    try:
        result = oi.get_all_points(claim_daily=True)
        return {"data": result}
    except oi.OiiOiiError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== OiiOii 通道（渠道四）任务提交与查询 ====================

@app.post("/oiioii/tasks/create")
def oiioii_create_task(body: OiiOiiTaskCreate):
    """通过 OiiOii 提交视频生成任务（后台线程执行）"""
    try:
        result = oi.generate_video(
            prompt=body.prompt,
            image_path=body.image_path,
            image_url=body.image_url,
            reference_images=body.reference_images,
            model=body.model,
            duration=body.duration,
            aspect_ratio=body.aspect_ratio,
            resolution=body.resolution,
            generate_mode=body.generateMode or body.generate_mode,
        )
        task_id = result.get("task_id", "")
        if task_id:
            TaskDB.add(
                task_id=task_id,
                account_id=0,
                task_type=TaskType.IMAGE_TO_VIDEO,
                prompt=body.prompt,
                model=f"oiioii:{body.model}",
            )
        return {"data": result}
    except oi.OiiOiiError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/oiioii/images/create")
def oiioii_create_image(body: OiiOiiImageCreate):
    """通过 OiiOii 提交图片生成任务（后台线程执行）"""
    try:
        result = oi.generate_image(
            prompt=body.prompt,
            image_path=body.image_path,
            image_url=body.image_url,
            reference_images=body.reference_images,
            image_to_image=body.image_to_image,
            model=body.model,
            aspect_ratio=body.aspect_ratio,
            resolution=body.resolution,
        )
        task_id = result.get("task_id", "")
        if task_id:
            TaskDB.add(
                task_id=task_id,
                account_id=0,
                task_type=TaskType.TEXT_TO_VIDEO,
                prompt=body.prompt,
                model=f"oiioii-image:{body.model}",
            )
        return {"data": result}
    except oi.OiiOiiError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/oiioii/tasks/{task_id}/status")
def oiioii_task_status(task_id: str):
    """查询 OiiOii 任务状态，归一化为前端通用结构"""
    detail = oi.get_task_status(task_id)
    status = detail.get("status", "pending")
    video_url = detail.get("video_url", "") or ""
    local_path = detail.get("local_path", "") or ""

    mapped_status = status
    if status == "completed" and video_url:
        TaskDB.update_status(task_id, "completed", video_url)
    elif status == "failed":
        TaskDB.update_status(task_id, "failed")

    return {"data": {
        "status": mapped_status,
        "video_url": video_url,
        "image_url": video_url if detail.get("media_type") == "image" else "",
        "local_path": local_path,
        "cdn_url": detail.get("cdn_url", ""),
        "download_url": detail.get("download_url", ""),
        "output_uri": detail.get("output_uri", ""),
        "submitted_model": detail.get("submitted_model", ""),
        "submitted_mcp_method_name": detail.get("submitted_mcp_method_name", ""),
        "submitted_model_param": detail.get("submitted_model_param", ""),
        "submitted_generate_mode": detail.get("submitted_generate_mode", ""),
        "media_type": detail.get("media_type", "video"),
        "file_size": detail.get("file_size"),
        "progress": detail.get("progress"),
        "queue_position": detail.get("queue_position"),
        "elapsed_seconds": detail.get("elapsed_seconds"),
        "remaining_seconds": detail.get("remaining_seconds"),
        "timeout_seconds": detail.get("timeout_seconds"),
        "estimated_wait_seconds": detail.get("estimated_wait_seconds"),
        "started_at": detail.get("started_at"),
        "fail_reason": detail.get("error", ""),
    }}


# ==================== 能力查询 ====================

@app.get("/capabilities")
def get_capabilities():
    return {
        "data": {
            "matrix": CAPABILITY_MATRIX,
            "point_table": POINT_TABLE,
            "models": [
                {"id": Model.SEEDANCE_2_0, "name": "Seedance 2.0", "cost_per_sec": 18},
                {"id": Model.SEEDANCE_1_5, "name": "Seedance 1.5", "cost_per_sec": 13},
                {"id": Model.KLING, "name": "Kling", "cost_per_sec": 8},
            ],
            "ratios": [
                {"id": Ratio.PORTRAIT, "name": "竖版 9:16"},
                {"id": Ratio.LANDSCAPE, "name": "横版 16:9"},
            ],
            "resolutions": [
                {"id": Resolution.P720, "name": "720P"},
                {"id": Resolution.P1080, "name": "1080P"},
            ],
            "task_types": [
                {"id": TaskType.TEXT_TO_VIDEO, "name": "文生视频"},
                {"id": TaskType.IMAGE_TO_VIDEO, "name": "图生视频"},
                {"id": TaskType.VIDEO_REFERENCE, "name": "视频参考"},
                {"id": TaskType.PRODUCT_VIDEO, "name": "商品视频"},
                {"id": TaskType.TRANSLATION, "name": "视频翻译"},
                {"id": TaskType.LIPSYNC, "name": "唇形同步"},
                {"id": TaskType.DIGITAL_HUMAN, "name": "数字人"},
                {"id": TaskType.AVATAR_VIDEO, "name": "Avatar视频"},
            ],
        }
    }


# ==================== 视频代理 / 下载 ====================

# 允许代理的远程视频域名后缀（防 SSRF：仅放行已知视频源）
_ALLOWED_VIDEO_HOSTS = (
    "aliyuncs.com",
    "cloudfront.net",
    "pixmax-ai-prod.oss-accelerate.aliyuncs.com",
    "hogiai.cn",
    "oiioii.ai",
    "douyinvod.com",
    "bytecdn.cn",
    "bytedance.com",
    "byteimg.com",
    "pstatp.com",
    "snssdk.com",
    "ibytedtos.com",
    "volcvideo.com",
    "dola.com",
    "framia.pro",
    "converge.ai",
    "tensor.art",
    "tensorartassets.com",
    "cloudflarestorage.com",
)


def _is_allowed_video_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in _ALLOWED_VIDEO_HOSTS)


def _proxy_remote_video(url: str, range_header: str | None, as_download: bool, filename: str):
    """转发远程视频，强制 Content-Type=video/mp4，透传 Range，支持边播边下/下载。"""
    if not _is_allowed_video_url(url):
        raise HTTPException(status_code=400, detail="不允许代理该地址")

    fwd_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8",
    }
    if range_header:
        fwd_headers["Range"] = range_header

    proxies = None
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    is_oi_host = host == "hogiai.cn" or host.endswith(".hogiai.cn") or host == "oiioii.ai" or host.endswith(".oiioii.ai")
    if is_oi_host:
        if "/res/read_file" in parsed.path:
            try:
                oi_account = oi._pick_account()
                token = oi_account.get("token")
                if token:
                    fwd_headers["Authorization"] = f"Bearer {token}"
            except Exception:
                pass
        oi_config = oi._load_config()
        if oi_config.get("use_proxy", True):
            proxy_host = oi_config.get("proxy_host", "127.0.0.1")
            proxy_port = int(oi_config.get("proxy_port", 7890) or 7890)
            proxy_url = f"http://{proxy_host}:{proxy_port}"
            proxies = {"http": proxy_url, "https": proxy_url}

    try:
        upstream = requests.get(url, headers=fwd_headers, stream=True, timeout=60, proxies=proxies)
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"拉取远程视频失败: {e}")

    if upstream.status_code >= 400:
        upstream.close()
        raise HTTPException(status_code=upstream.status_code, detail="远程视频不可用")

    # 强制改成 video/mp4，解决 binary/octet-stream 导致的黑屏
    resp_headers = {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
    }
    for h in ("Content-Length", "Content-Range"):
        if h in upstream.headers:
            resp_headers[h] = upstream.headers[h]
    if as_download:
        safe_name = filename or "video.mp4"
        if not safe_name.lower().endswith(".mp4"):
            safe_name += ".mp4"
        resp_headers["Content-Disposition"] = f'attachment; filename="{safe_name}"'

    def _iter():
        try:
            for chunk in upstream.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return StreamingResponse(
        _iter(),
        status_code=upstream.status_code,  # 206 透传，保证拖动进度
        headers=resp_headers,
    )


@app.get("/local/video")
def local_video(request: Request, path: str, download: int = 0, filename: str = ""):
    """流式播放本机已下载视频，支持 Range，避免前端直接 file:// 播放失败。
    当 download=1 时以附件形式返回（下载）。"""
    file_path = os.path.abspath(urllib.parse.unquote(path or ""))
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="本地视频不存在")
    if not file_path.lower().endswith((".mp4", ".webm", ".mov", ".m4v")):
        raise HTTPException(status_code=400, detail="不支持的视频格式")

    file_size = os.path.getsize(file_path)
    range_header = request.headers.get("range") or ""
    start = 0
    end = file_size - 1
    status_code = 200

    if range_header.startswith("bytes="):
        raw_range = range_header.replace("bytes=", "", 1).split(",", 1)[0]
        raw_start, _, raw_end = raw_range.partition("-")
        try:
            if raw_start:
                start = max(0, int(raw_start))
            if raw_end:
                end = min(file_size - 1, int(raw_end))
            if start > end:
                raise ValueError
            status_code = 206
        except ValueError:
            raise HTTPException(status_code=416, detail="Range 不合法")

    chunk_size = 1024 * 1024
    content_length = end - start + 1
    content_type = mimetypes.guess_type(file_path)[0] or "video/mp4"
    headers = {
        "Content-Type": content_type,
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Cache-Control": "public, max-age=3600",
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    if download:
        safe_name = filename or os.path.basename(file_path) or "video.mp4"
        if not safe_name.lower().endswith((".mp4", ".webm", ".mov", ".m4v")):
            safe_name += ".mp4"
        headers["Content-Disposition"] = f'attachment; filename="{safe_name}"'

    def _iter():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                data = f.read(min(chunk_size, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(_iter(), status_code=status_code, headers=headers)


@app.get("/local/image")
def local_image(path: str, download: int = 0, filename: str = ""):
    """返回本机图片文件，避免前端 file:// 加载失败。
    当 download=1 时以附件形式返回（下载）。"""
    file_path = os.path.abspath(urllib.parse.unquote(path or ""))
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="本地图片不存在")
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg", ".heic", ".heif", ".tiff", ".ico"):
        raise HTTPException(status_code=400, detail="不支持的图片格式")
    content_type = mimetypes.guess_type(file_path)[0] or "image/jpeg"
    extra_headers = {"Cache-Control": "public, max-age=3600"}
    if download:
        safe_name = filename or os.path.basename(file_path) or "image.png"
        extra_headers["Content-Disposition"] = f'attachment; filename="{safe_name}"'
    return FileResponse(file_path, media_type=content_type, headers=extra_headers)


@app.get("/proxy/video")
def proxy_video(request: Request, url: str):
    """流式代理远程视频用于内联播放（强制 video/mp4 + 透传 Range）"""
    return _proxy_remote_video(url, request.headers.get("range"), as_download=False, filename="")


@app.get("/download/video")
def download_video(url: str, filename: str = "video.mp4"):
    """以附件形式下载远程视频（强制 video/mp4 + Content-Disposition）"""
    return _proxy_remote_video(url, None, as_download=True, filename=filename)


# ==================== Framia 渠道九账号池与任务 ====================

def _framia_public_account(account: dict) -> dict:
    return FramiaAccountDB._public(account)


@app.get("/framia/accounts")
def framia_list_accounts():
    """Framia 渠道九账号库。"""
    return {"data": [_framia_public_account(account) for account in FramiaAccountDB.list_all()]}


@app.get("/internal/framia/accounts/{account_id}/session")
def framia_get_account_session(account_id: int, request: Request):
    _require_internal_session_access(request)
    account = FramiaAccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Framia account not found")
    return {"data": account}


@app.post("/framia/accounts")
def framia_import_account(body: FramiaAccountImport):
    """手动导入 Framia 登录态（accessToken + cookie）。"""
    try:
        account = FramiaAccountDB.upsert(
            email=body.email,
            password=body.password,
            access_token=body.access_token,
            expires_at=body.expires_at,
            cookie=body.cookie,
            user_agent=body.user_agent,
            user_id=body.user_id,
            location=body.location,
            status=body.status,
            note=body.note,
        )
        _mark_mailbox_channel_by_email(body.email, "framia")
        return {"data": _framia_public_account(account)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/framia/accounts/login")
def framia_login_account(body: FramiaAccountLogin):
    """通过 Google OAuth 自动登录 Framia 并采集账号。"""
    try:
        account = _framia_login_and_save(
            body.email,
            body.password,
            visible=body.visible,
            proxy=body.proxy,
            keep_open=body.keep_open,
        )
        return {"data": _framia_public_account(account)}
    except fm.FramiaError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _framia_login_and_save(
    email: str,
    password: str,
    *,
    visible: bool = True,
    proxy: str = "",
    keep_open: bool = False,
) -> dict:
    login_result = fm.login_with_google(
        email=email,
        password=password,
        visible=visible,
        proxy=proxy,
        keep_open=keep_open,
    )
    access_token = login_result.get("access_token", "")
    if not access_token:
        raise RuntimeError("登录成功但未获取到 accessToken")
    account = FramiaAccountDB.upsert(
        email=email,
        password=password,
        access_token=access_token,
        expires_at=int(login_result.get("expires_at") or 0),
        cookie=login_result.get("cookie", ""),
        user_agent=login_result.get("user_agent", ""),
        user_id=login_result.get("user_id", ""),
        location=login_result.get("location", ""),
        status="active",
        note="Google OAuth 自动登录",
    )
    _mark_mailbox_channel_by_email(email, "framia")
    return account


@app.post("/framia/accounts/login-pool")
def framia_login_from_mailbox_pool(body: FramiaMailboxBatchLogin):
    """从全局邮箱库原子领取账号并批量完成渠道九登录。"""
    import concurrent.futures

    try:
        mailboxes = MailboxDB.claim_for_channel(
            "framia",
            count=body.count,
            mailbox_ids=body.mailbox_ids,
            credential_type="password",
            provider="google",
            lease_seconds=21600,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    def worker(mailbox: dict) -> dict:
        email = str(mailbox.get("email") or "")
        password = str(mailbox.get("password") or mailbox.get("google_password") or "")
        try:
            account = _framia_login_and_save(
                email,
                password,
                visible=body.visible,
                proxy=body.proxy,
                keep_open=body.keep_open,
            )
            return {"ok": True, "email": email, "account": _framia_public_account(account)}
        except Exception as error:  # noqa: BLE001
            MailboxDB.mark_channel_usage(
                mailbox["id"],
                "framia",
                "failed",
                account_email=email,
                error=str(error),
            )
            return {"ok": False, "email": email, "error": str(error)}

    concurrency = max(1, min(int(body.concurrency or 1), 5, len(mailboxes)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        results = list(executor.map(worker, mailboxes))
    succeeded = sum(1 for result in results if result.get("ok"))
    return {
        "data": {
            "results": results,
            "succeeded": succeeded,
            "failed": len(results) - succeeded,
            "total": len(results),
        }
    }


@app.delete("/framia/accounts")
def framia_delete_all_accounts():
    accounts = FramiaAccountDB.list_all()
    deleted = FramiaAccountDB.delete_all()
    for account in accounts:
        _release_mailbox_channel_by_email(account.get("email", ""), "framia")
    return {"data": {"deleted": deleted}}


@app.delete("/framia/accounts/{account_id}")
def framia_delete_account(account_id: int):
    account = FramiaAccountDB.get(account_id)
    FramiaAccountDB.delete(account_id)
    if account:
        _release_mailbox_channel_by_email(account.get("email", ""), "framia")
    return {"message": "deleted"}


@app.get("/framia/accounts/{account_id}/test")
def framia_test_account(account_id: int):
    """测试 Framia 账号 accessToken 是否有效。"""
    try:
        account = FramiaAccountDB.get(account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Framia account not found")
        client = fm.FramiaClient(
            access_token=account.get("access_token", ""),
            cookie=account.get("cookie", ""),
            user_agent=account.get("user_agent", ""),
        )
        result = client.test_connection()
        return {"data": result}
    except fm.FramiaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/framia/models")
def framia_models():
    """返回渠道九可选模型和比例。"""
    return {"data": {"models": fm.DEFAULT_MODELS, "ratios": fm.DEFAULT_RATIOS}}


@app.post("/framia/tasks/create")
def framia_create_task(body: FramiaTaskCreate):
    """通过 Framia 提交视频生成任务。

    完整流程：
      1. 选择账号、创建项目
      2. 上传垫图（如有）→ 获取 resource_id 列表
      3. 发布工作流版本（canvas_snapshot 含 Video 节点）
      4. 执行工作流 → 返回 workflow_run_id
      5. 记录 task_id = workflow_run_id 到 TaskDB
    """
    try:
        account = fm.pick_account(body.account_id)
        client = fm.FramiaClient(
            access_token=account.get("access_token", ""),
            cookie=account.get("cookie", ""),
            user_agent=account.get("user_agent", ""),
        )

        # 1. 创建项目
        project = client.create_project()
        project_id = project.get("project_id", "")
        canvas_id = project.get("canvas_id", "")
        main_thread_id = project.get("main_thread_id", "")
        if not project_id:
            raise HTTPException(status_code=500, detail="Framia 创建项目失败：未返回 project_id")

        # 2. 上传垫图（支持 image_path 和 image_paths）
        resource_ids: list[str] = []
        all_image_paths = list(body.image_paths or [])
        if body.image_path:
            all_image_paths.insert(0, body.image_path)

        for img_path in all_image_paths:
            if not img_path or not os.path.isfile(img_path):
                continue
            import mimetypes as _mt
            filename = os.path.basename(img_path)
            upload_info = client.get_upload_url(project_id, filename)
            upload_url = upload_info.get("url", "")
            oss_key = upload_info.get("key", "")
            if not upload_url or not oss_key:
                continue
            mime = _mt.guess_type(img_path)[0] or "image/png"
            client.upload_to_oss(upload_url, img_path, mime)
            upload_result = client.upload_done(project_id, main_thread_id, filename, oss_key)
            rid = upload_result.get("resource_id", "")
            if rid:
                resource_ids.append(rid)

        # 3. 发布工作流版本
        node_id = f"video-{uuid.uuid4().hex[:12]}"
        wf_version = client.publish_workflow_version(
            project_id=project_id,
            canvas_id=canvas_id,
            node_id=node_id,
            prompt=body.prompt,
            model=body.model,
            aspect_ratio=body.aspect_ratio,
            resolution=body.resolution,
            duration=body.duration,
            resource_ids=resource_ids,
        )
        workflow_id = wf_version.get("workflow_id", "")
        workflow_version = wf_version.get("version", 0)

        # 4. 执行工作流
        run_result = client.run_workflow(
            workflow_id=workflow_id,
            workflow_version=workflow_version,
            project_id=project_id,
            canvas_id=canvas_id,
            node_id=node_id,
        )
        workflow_run_id = run_result.get("workflow_run_id", "")
        if not workflow_run_id:
            raise HTTPException(status_code=500, detail="Framia 执行工作流失败：未返回 workflow_run_id")

        task_id = workflow_run_id
        TaskDB.add(
            task_id=task_id,
            account_id=int(account.get("id") or 0),
            task_type=TaskType.IMAGE_TO_VIDEO if resource_ids else TaskType.TEXT_TO_VIDEO,
            prompt=body.prompt,
            model=f"framia:{body.model}",
        )

        return {"data": {
            "task_id": task_id,
            "workflow_run_id": workflow_run_id,
            "status": run_result.get("status", "queued"),
            "account_id": int(account.get("id") or 0),
            "account_name": account.get("email", ""),
            "resource_ids": resource_ids,
        }}
    except fm.FramiaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/framia/tasks/{task_id}/status")
def framia_task_status(task_id: str):
    """查询 Framia 任务状态。

    task_id 即 workflow_run_id。
    通过 GET /video/api/workflows/runs/{run_id}/nodes 查询节点状态，
    若节点已完成，再通过 GET /video/api/v1/resources/{resource_id}/info 获取视频 URL。
    """
    try:
        task = TaskDB.get(task_id) or {}
        account_id = int(task.get("account_id") or 0)
        if account_id:
            account = FramiaAccountDB.get(account_id)
        else:
            account = fm.pick_account(0)

        if not account:
            raise HTTPException(status_code=404, detail="Framia account not found for this task")

        client = fm.FramiaClient(
            access_token=account.get("access_token", ""),
            cookie=account.get("cookie", ""),
            user_agent=account.get("user_agent", ""),
        )

        workflow_run_id = task_id

        # 查询工作流运行状态
        run_status = client.get_workflow_run_status(workflow_run_id)
        wf_status = run_status.get("status", "")

        # 查询节点结果
        node_result = client.get_workflow_run_nodes(workflow_run_id)
        node_status = node_result.get("status", "")
        resource_id = node_result.get("resource_id", "")

        # 映射状态
        status_map = {
            "queued": "processing",
            "running": "processing",
            "pending": "processing",
            "completed": "completed",
            "failed": "failed",
            "cancelled": "failed",
        }
        mapped_status = status_map.get(node_status or wf_status, "processing")

        video_url = ""
        thumbnail_url = ""
        if mapped_status == "completed" and resource_id:
            resource_info = client.get_resource_info(resource_id)
            video_url = resource_info.get("download_url", "")
            thumbnail_url = resource_info.get("thumbnail_url", "")
            # 更新 TaskDB
            TaskDB.update_status(task_id, "completed", video_url=video_url)
        elif mapped_status == "failed":
            TaskDB.update_status(task_id, "failed")

        return {"data": {
            "status": mapped_status,
            "video_url": video_url,
            "thumbnail_url": thumbnail_url,
            "task_id": task_id,
            "workflow_run_id": workflow_run_id,
            "node_status": node_status,
            "wf_status": wf_status,
            "resource_id": resource_id,
            "account_id": int(account.get("id") or 0),
            "account_name": account.get("email", ""),
        }}
    except fm.FramiaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/framia/credits")
def framia_get_credits(account_id: int = 0):
    """查询 Framia 账号积分余额。"""
    try:
        account = fm.pick_account(account_id) if account_id else fm.pick_account(0)
        client = fm.FramiaClient(
            access_token=account.get("access_token", ""),
            cookie=account.get("cookie", ""),
            user_agent=account.get("user_agent", ""),
        )
        credits = client.get_credits()
        return {"data": {
            "credits_balance": credits.get("credits_balance", 0),
            "credit_cent_balance": credits.get("credit_cent_balance", 0),
            "account_id": int(account.get("id") or 0),
            "account_name": account.get("email", ""),
        }}
    except fm.FramiaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== Tensor.Art 渠道十账号池与任务 ====================

def _tensorart_public_account(account: dict) -> dict:
    return TensorArtAccountDB._public(account)


@app.get("/tensorart/config")
def tensorart_config():
    key = qf.get_yescap_key()
    return {
        "data": {
            "yescap_configured": bool(key),
            "account_count": len(TensorArtAccountDB.list_all()),
            "models": ta.DEFAULT_MODELS,
        }
    }


@app.get("/tensorart/accounts")
def tensorart_list_accounts():
    return {"data": TensorArtAccountDB.list_all()}


@app.post("/tensorart/accounts")
def tensorart_import_account(body: TensorArtAccountImport):
    try:
        token_payload = ta.decode_jwt_payload(body.access_token)
        account = TensorArtAccountDB.upsert(
            email=body.email,
            access_token=body.access_token,
            expires_at=body.expires_at or int(token_payload.get("exp") or 0) * 1000,
            device_id=body.device_id or str(token_payload.get("deviceId") or ""),
            user_agent=body.user_agent,
            user_id=body.user_id or str(token_payload.get("userId") or ""),
            status=body.status,
            note=body.note or "手动导入",
        )
        _mark_mailbox_channel_by_email(body.email, "tensorart")
        return {"data": _tensorart_public_account(account)}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/tensorart/accounts/register")
@app.post("/tensorart/accounts/register-pool")
def tensorart_register_from_mailbox_pool(body: TensorArtMailboxRegister):
    yescap_key = qf.get_yescap_key()
    if not yescap_key:
        raise HTTPException(
            status_code=400,
            detail="未配置 YesCaptcha Key，请先在设置 → 渠道三中填写",
        )
    count = max(1, min(int(body.count or 1), 100))
    mailbox_ids = list(
        dict.fromkeys(
            int(value)
            for value in (body.mailbox_ids or [])
            if int(value) > 0
        )
    )[:100]
    effective_count = len(mailbox_ids) if mailbox_ids else count
    max_wait = max(90, min(int(body.max_wait or 210), 600))
    requested_concurrency = max(
        1, min(int(body.concurrency or 1), 3, effective_count)
    )
    queue_rounds = (
        effective_count + requested_concurrency - 1
    ) // requested_concurrency
    lease_seconds = min(
        7 * 24 * 60 * 60,
        max(1800, queue_rounds * (max_wait + 900) + 300),
    )
    try:
        mailboxes = MailboxDB.claim_for_channel(
            "tensorart",
            count=count,
            mailbox_ids=mailbox_ids,
            credential_type="oauth",
            provider="microsoft",
            lease_seconds=lease_seconds,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error

    def worker(mailbox: dict) -> dict:
        email = str(mailbox.get("email") or "")
        try:
            login_result = ta.register_with_mailbox(
                email,
                str(mailbox.get("client_id") or ""),
                str(mailbox.get("refresh_token") or ""),
                yescap_key,
                max_wait=max_wait,
            )
            account = TensorArtAccountDB.upsert(
                email=email,
                access_token=login_result.get("access_token", ""),
                expires_at=int(login_result.get("expires_at") or 0),
                device_id=login_result.get("device_id", ""),
                user_agent=login_result.get("user_agent", ""),
                user_id=login_result.get("user_id", ""),
                status="active",
                note="邮箱 magic-link 纯 API 注册",
            )
            MailboxDB.mark_channel_usage(
                mailbox["id"],
                "tensorart",
                "registered",
                account_email=email,
            )
            return {
                "ok": True,
                "email": email,
                "account": _tensorart_public_account(account),
            }
        except Exception as error:  # noqa: BLE001
            MailboxDB.mark_channel_usage(
                mailbox["id"],
                "tensorart",
                "failed",
                account_email=email,
                error=str(error),
            )
            return {"ok": False, "email": email, "error": str(error)}

    concurrency = min(requested_concurrency, len(mailboxes))
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        results = list(executor.map(worker, mailboxes))
    succeeded = sum(1 for result in results if result.get("ok"))
    return {
        "data": {
            "results": results,
            "succeeded": succeeded,
            "failed": len(results) - succeeded,
            "total": len(results),
        }
    }


@app.delete("/tensorart/accounts")
def tensorart_delete_all_accounts():
    accounts = TensorArtAccountDB.list_all()
    deleted = TensorArtAccountDB.delete_all()
    for account in accounts:
        _release_mailbox_channel_by_email(account.get("email", ""), "tensorart")
    return {"data": {"deleted": deleted}}


@app.delete("/tensorart/accounts/{account_id}")
def tensorart_delete_account(account_id: int):
    account = TensorArtAccountDB.get(account_id)
    TensorArtAccountDB.delete(account_id)
    if account:
        _release_mailbox_channel_by_email(account.get("email", ""), "tensorart")
    return {"message": "deleted"}


@app.get("/tensorart/accounts/{account_id}/test")
def tensorart_test_account(account_id: int):
    try:
        account = TensorArtAccountDB.get(account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Tensor.Art account not found")
        client = ta.TensorArtClient(
            account.get("access_token", ""),
            device_id=account.get("device_id", ""),
            user_agent=account.get("user_agent", ""),
        )
        return {"data": client.test_connection()}
    except ta.TensorArtError as error:
        raise HTTPException(
            status_code=error.status_code or 500,
            detail=str(error),
        ) from error
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.get("/tensorart/models")
def tensorart_models():
    return {"data": {"models": ta.DEFAULT_MODELS, "ratios": ta.DEFAULT_RATIOS}}


@app.get("/tensorart/energy")
def tensorart_get_energy(account_id: int = 0):
    try:
        account = ta.pick_account(account_id)
        client = ta.TensorArtClient(
            account.get("access_token", ""),
            device_id=account.get("device_id", ""),
            user_agent=account.get("user_agent", ""),
        )
        energy = client.get_energy()
        total = energy.get("totalBalance")
        if total is None:
            total = energy.get("balance", energy.get("energy", 0))
        return {
            "data": {
                "total_balance": total,
                "sources": energy.get("sources", []),
                "account_id": int(account.get("id") or 0),
                "account_name": account.get("email", ""),
            }
        }
    except ta.TensorArtError as error:
        raise HTTPException(
            status_code=error.status_code or 500,
            detail=str(error),
        ) from error
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/tensorart/tasks/create")
def tensorart_create_task(body: TensorArtTaskCreate):
    # 账号选择到 TaskDB 落库之间串行化，避免并发请求同时挑中同一最低负载账号。
    with _tensorart_task_create_lock:
        return _tensorart_create_task_locked(body)


def _tensorart_create_task_locked(body: TensorArtTaskCreate):
    try:
        duration = ta.normalize_video_duration(body.duration)
        credits = ta.video_credits_for_duration(duration)
        account = ta.pick_account(body.account_id, min_credits=credits)
        client = ta.TensorArtClient(
            account.get("access_token", ""),
            device_id=account.get("device_id", ""),
            user_agent=account.get("user_agent", ""),
        )
        image_sources = list(body.image_paths or [])
        if body.image_path:
            image_sources.insert(0, body.image_path)
        if body.image_url:
            image_sources.append(body.image_url)
        image_sources = list(
            dict.fromkeys(str(value).strip() for value in image_sources if str(value).strip())
        )
        if not image_sources:
            raise HTTPException(
                status_code=400,
                detail="渠道十当前仅支持图生视频，请先为分镜添加垫图",
            )

        result = client.start_video_generation(
            body.prompt,
            image_sources,
            aspect_ratio=body.aspect_ratio,
            resolution=body.resolution or "480p",
            duration=duration,
        )
        task_id = ta.encode_task_id(
            result["run_id"],
            result["canvas_id"],
            result["node_id"],
            account_id=int(account.get("id") or 0),
        )
        persistence_warning = ""
        try:
            TaskDB.add(
                task_id=task_id,
                account_id=int(account.get("id") or 0),
                task_type=TaskType.IMAGE_TO_VIDEO,
                prompt=body.prompt,
                model=f"tensorart:{body.model}",
                status="processing",
                video_duration=duration,
            )
        except Exception as database_error:  # noqa: BLE001
            # 远端已经扣费启动；task_id 自带账号/Canvas/节点上下文，仍返回给前端继续轮询。
            persistence_warning = f"远端任务已启动，但本地任务记录保存失败：{database_error}"
            traceback.print_exc()
        return {
            "data": {
                "task_id": task_id,
                "workflow_run_id": result["run_id"],
                "canvas_id": result["canvas_id"],
                "node_id": result["node_id"],
                "status": "processing",
                "account_id": int(account.get("id") or 0),
                "account_name": account.get("email", ""),
                "asset_ids": [
                    asset.get("asset_id", "") for asset in result.get("assets", [])
                ],
                "duration": duration,
                "credits": credits,
                "persistence_warning": persistence_warning,
            }
        }
    except ta.TensorArtError as error:
        raise HTTPException(
            status_code=error.status_code or 500,
            detail=str(error),
        ) from error
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.get("/tensorart/tasks/{task_id}/status")
def tensorart_task_status(task_id: str):
    try:
        context = ta.decode_task_id(task_id)
        task = TaskDB.get(task_id) or {}
        account_id = int(task.get("account_id") or context.get("account_id") or 0)
        account = (
            TensorArtAccountDB.get(account_id)
            if account_id
            else ta.pick_account(0)
        )
        if not account:
            raise HTTPException(
                status_code=404,
                detail="Tensor.Art account not found for this task",
            )
        client = ta.TensorArtClient(
            account.get("access_token", ""),
            device_id=account.get("device_id", ""),
            user_agent=account.get("user_agent", ""),
        )
        payload = client.query_run(
            context["canvas_id"],
            context["node_id"],
            context["run_id"],
        )
        result = ta.parse_run_result(payload, context["run_id"])
        video_url = result.get("video_url", "")
        if result["status"] == "completed" and not video_url:
            detail = client.canvas_detail(context["canvas_id"])
            video_url = ta.extract_video_url(detail, context["node_id"])
            result["video_url"] = video_url
            result["download_url"] = video_url
        if result["status"] == "completed" and not video_url:
            # SUCCESS 与产物 URL 的持久化可能存在短暂时间差，继续轮询而不是提前终止。
            result["status"] = "processing"
            result["finalizing"] = True

        if result["status"] == "completed":
            TaskDB.update_status(task_id, "completed", video_url=video_url)
        elif result["status"] == "failed":
            TaskDB.update_status(task_id, "failed")
        else:
            TaskDB.update_status(task_id, "processing")

        return {
            "data": {
                **result,
                "task_id": task_id,
                "workflow_run_id": context["run_id"],
                "canvas_id": context["canvas_id"],
                "node_id": context["node_id"],
                "account_id": int(account.get("id") or 0),
                "account_name": account.get("email", ""),
            }
        }
    except ta.TensorArtError as error:
        raise HTTPException(
            status_code=error.status_code or 500,
            detail=str(error),
        ) from error
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


# ==================== 健康检查 ====================

@app.get("/internal/health")
def internal_health(request: Request):
    _require_internal_session_access(request)
    return {"status": "ok", "version": "1.0.0"}


@app.get("/health")
def health():
    return {"status": "ok", "version": "1.0.0"}


# ==================== 启动入口 ====================

def start_server(host: str = "127.0.0.1", port: int = 8765):
    uvicorn.run(app, host=host, port=port, log_level="info", http="h11")


if __name__ == "__main__":
    start_server()
