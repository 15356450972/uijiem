"""Wizstar 本地 HTTP 服务 — 包装 SDK 为 REST API，供 Electron 前端调用"""

from __future__ import annotations

import os
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
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

from .database import init_db, MailboxDB, AccountDB, TaskDB, ProjectDB, QfAccountDB, DolaAccountDB
from .client import WizstarClient, WizstarCredentials
from .mailbox import OutlookMailbox
from .enums import TaskType, Model, Ratio, Resolution
from .capabilities import CAPABILITY_MATRIX, POINT_TABLE
from . import quickframe_bridge as qf
from . import pixmax as px
from . import oiioii as oi
from . import dola as dl
from . import chatgpt2api as cg


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Wizstar Local API", version="1.0.0", lifespan=lifespan)
_dola_task_create_lock = threading.Lock()
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
    client_id: str
    refresh_token: str


class MailboxBatchImport(BaseModel):
    """批量导入格式：每行 email----password----client_id----refresh_token"""
    raw_text: str


class AccountRegister(BaseModel):
    mailbox_id: int
    password: str = "Wz@2024secure"


class AccountBatchRegister(BaseModel):
    mailbox_ids: list[int]
    password: str = "Wz@2024secure"
    concurrency: int = 2


class AccountConcurrencyUpdate(BaseModel):
    max_concurrency: int = 1


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
    """注册 QuickFrame 账号：自动生成临时邮箱并注册"""
    count: int = 1
    concurrency: int = 3
    domain: str = ""          # 留空表示从可用域名随机选


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
    """保存 OiiOii 通道配置（代理设置）"""
    use_proxy: bool | None = None
    proxy_host: str | None = None
    proxy_port: int | None = None
    test: bool = False


class OiiOiiBatchRegister(BaseModel):
    """OiiOii 批量注册参数"""
    count: int = 1
    concurrency: int = 2


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
    """把已有 Dola 登录态加入账号库。"""
    name: str = ""
    cookie: str = ""
    env_file: str = ""
    profile_dir: str = ""
    note: str = ""


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
    segments: list = []
    character_assets: list = []
    scene_assets: list = []
    item_assets: list = []
    generation_tasks: list = []


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
        project_id,
        body.segments,
        body.character_assets,
        body.scene_assets,
        body.item_assets,
        body.generation_tasks,
    )
    return {"message": "saved"}


# ==================== 邮箱库 ====================

@app.get("/mailboxes")
def list_mailboxes():
    return {"data": MailboxDB.list_all()}


@app.post("/mailboxes")
def add_mailbox(body: MailboxCreate):
    try:
        mailbox = MailboxDB.add(body.email, body.client_id, body.refresh_token)
        return {"data": mailbox}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/mailboxes/{mailbox_id}")
def delete_mailbox(mailbox_id: int):
    MailboxDB.delete(mailbox_id)
    return {"message": "deleted"}


@app.post("/mailboxes/batch")
def batch_import_mailboxes(body: MailboxBatchImport):
    """批量导入邮箱，格式：每行 email----password----client_id----refresh_token"""
    lines = [l.strip() for l in body.raw_text.strip().splitlines() if l.strip()]
    imported = []
    errors = []
    for line in lines:
        parts = line.split("----")
        if len(parts) < 4:
            errors.append({"line": line[:50], "error": "格式错误，需要4段用----分隔"})
            continue
        email = parts[0].strip()
        # parts[1] is password (not needed for mailbox, but we store it for registration)
        client_id = parts[2].strip()
        refresh_token = parts[3].strip()
        try:
            mailbox = MailboxDB.add(email, client_id, refresh_token)
            imported.append(mailbox)
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


# ==================== 账号库 ====================

@app.get("/accounts")
def list_accounts():
    accounts = AccountDB.list_all()
    for account in accounts:
        account["active_task_count"] = TaskDB.active_count_for_account(account["id"])
    return {"data": accounts}


@app.get("/accounts/{account_id}")
def get_account(account_id: int):
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
    return {"data": updated}


@app.post("/accounts/register")
def register_account(body: AccountRegister):
    """用指定邮箱自动注册 wizstar 账号（同步阻塞，耗时约 30-120 秒）"""
    mailbox = MailboxDB.get(body.mailbox_id)
    if not mailbox:
        raise HTTPException(status_code=404, detail="mailbox not found")

    try:
        mb = OutlookMailbox(mailbox["email"], mailbox["client_id"], mailbox["refresh_token"])
        client = WizstarClient()
        creds = client.register_auto(mb, body.password)

        # 获取积分
        points = 0
        try:
            balance = client.points_balance()
            if balance.get("errno") == 0:
                points = balance.get("data", {}).get("total_points", 0)
        except Exception:
            pass

        account = AccountDB.add(
            email=creds.email,
            password=creds.password,
            uid=creds.uid,
            display_name=creds.display_name,
            osduss=creds.osduss,
            refresh_token=creds.refresh_token,
            pass_os_refresh_tk=creds.pass_os_refresh_tk,
            points_balance=points,
        )
        MailboxDB.update_status(body.mailbox_id, "registered")
        return {"data": account}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"registration failed: {str(e)}")


@app.post("/accounts/batch-register")
def batch_register_accounts(body: AccountBatchRegister):
    """批量并发注册 wizstar 账号"""
    import concurrent.futures

    mailbox_ids = body.mailbox_ids
    password = body.password
    concurrency = min(body.concurrency, 10)

    results = {"success": [], "failed": []}

    def register_one(mailbox_id: int) -> dict:
        mailbox = MailboxDB.get(mailbox_id)
        if not mailbox:
            return {"mailbox_id": mailbox_id, "error": "mailbox not found"}
        try:
            mb = OutlookMailbox(mailbox["email"], mailbox["client_id"], mailbox["refresh_token"])
            client = WizstarClient()
            creds = client.register_auto(mb, password)
            points = 0
            try:
                balance = client.points_balance()
                if balance.get("errno") == 0:
                    points = balance.get("data", {}).get("total_points", 0)
            except Exception:
                pass
            account = AccountDB.add(
                email=creds.email,
                password=creds.password,
                uid=creds.uid,
                display_name=creds.display_name,
                osduss=creds.osduss,
                refresh_token=creds.refresh_token,
                pass_os_refresh_tk=creds.pass_os_refresh_tk,
                points_balance=points,
            )
            MailboxDB.update_status(mailbox_id, "registered")
            return {"mailbox_id": mailbox_id, "email": creds.email, "success": True, "account": account}
        except Exception as e:
            err_msg = str(e)
            if "has been bound" in err_msg or "200503" in err_msg:
                MailboxDB.update_status(mailbox_id, "registered")
            return {"mailbox_id": mailbox_id, "error": err_msg}

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {executor.submit(register_one, mid): mid for mid in mailbox_ids}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result.get("success"):
                results["success"].append(result)
            else:
                results["failed"].append(result)

    return {"data": results}


@app.post("/accounts/batch-refresh")
def batch_refresh_accounts():
    """批量刷新所有账号积分"""
    import concurrent.futures

    accounts = AccountDB.list_all()
    results = {"success": [], "failed": []}

    def refresh_one(account: dict) -> dict:
        try:
            creds = WizstarCredentials(
                email=account["email"],
                password=account["password"],
                uid=account["uid"],
                osduss=account["osduss"],
                refresh_token=account["refresh_token"],
                pass_os_refresh_tk=account["pass_os_refresh_tk"],
            )
            client = WizstarClient(credentials=creds)
            info = client.user_info()
            if info.get("errno") == 0:
                points = info.get("data", {}).get("point_number", 0)
                AccountDB.update_points(account["id"], points)
                return {"id": account["id"], "email": account["email"], "points": points}
            err_text = str(info)
            if "user forbidden" in err_text.lower():
                AccountDB.update_status(account["id"], "forbidden")
            return {"id": account["id"], "email": account["email"], "error": f"API error: {info}"}
        except Exception as e:
            return {"id": account["id"], "email": account["email"], "error": str(e)}

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
    AccountDB.delete(account_id)
    return {"message": "deleted"}


@app.post("/accounts/{account_id}/refresh")
def refresh_account(account_id: int):
    """刷新账号积分余额"""
    account = AccountDB.get(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")

    try:
        creds = WizstarCredentials(
            email=account["email"],
            password=account["password"],
            uid=account["uid"],
            osduss=account["osduss"],
            refresh_token=account["refresh_token"],
            pass_os_refresh_tk=account["pass_os_refresh_tk"],
        )
        client = WizstarClient(credentials=creds)
        info = client.user_info()
        if info.get("errno") == 0:
            points = info.get("data", {}).get("point_number", 0)
            AccountDB.update_points(account_id, points)
            return {"data": {"points_balance": points}}
        err_text = str(info)
        if "user forbidden" in err_text.lower():
            AccountDB.update_status(account_id, "forbidden")
        raise RuntimeError(f"API error: {info}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
        creds = WizstarCredentials(
            email=account["email"],
            password=account["password"],
            uid=account["uid"],
            osduss=account["osduss"],
            refresh_token=account["refresh_token"],
            pass_os_refresh_tk=account["pass_os_refresh_tk"],
        )
        client = WizstarClient(credentials=creds)
        url = client.upload_image(upload_path)
        return {"data": {"url": url}}
    except Exception as e:
        err_msg = str(e)
        if "user forbidden" in err_msg.lower():
            AccountDB.update_status(body.account_id, "forbidden")
        raise HTTPException(status_code=500, detail=err_msg)
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


@app.post("/tasks/create")
def create_task(body: TaskCreate):
    """创建视频生成任务"""
    account = AccountDB.get(body.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="account not found")
    active_count = TaskDB.active_count_for_account(body.account_id)
    max_concurrency = max(1, int(account.get("max_concurrency") or 1))
    if active_count >= max_concurrency:
        raise HTTPException(status_code=429, detail=f"该账号已达到并发上限：{active_count}/{max_concurrency}")

    try:
        creds = WizstarCredentials(
            email=account["email"],
            password=account["password"],
            uid=account["uid"],
            osduss=account["osduss"],
            refresh_token=account["refresh_token"],
            pass_os_refresh_tk=account["pass_os_refresh_tk"],
        )
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
        TaskDB.add(
            task_id=task_id,
            account_id=body.account_id,
            task_type=body.task_type,
            prompt=body.prompt,
            model=body.model,
        )
        return {"data": task}
    except Exception as e:
        err_msg = str(e)
        if "user forbidden" in err_msg.lower():
            AccountDB.update_status(body.account_id, "forbidden")
        raise HTTPException(status_code=500, detail=err_msg)


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
        creds = WizstarCredentials(
            email=account["email"],
            password=account["password"],
            uid=account["uid"],
            osduss=account["osduss"],
            refresh_token=account["refresh_token"],
            pass_os_refresh_tk=account["pass_os_refresh_tk"],
        )
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

        return {"data": {
            "status": status,
            "video_url": video_url,
            "queue_position": vr.get("queue_position"),
            "fail_reason": vr.get("fail_reason", ""),
        }}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    QfAccountDB.delete(account_id)
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
    """自动生成临时邮箱并批量注册 QuickFrame 账号，成功的写入 qf_accounts。"""
    try:
        results = qf.register_batch(
            count=body.count,
            concurrency=body.concurrency,
            domain=body.domain or None,
        )
    except qf.QuickFrameError as e:
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
        except Exception:  # noqa: BLE001 — 单条入库失败不影响整体
            pass

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
        raise HTTPException(status_code=400, detail=f"渠道六账号今日额度不足：本次需要 {quota_cost}")

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
                return DolaAccountDB.reserve_daily_video_quota(int(account.get("id") or 0), quota_cost)
            except ValueError:
                continue
        raise HTTPException(status_code=400, detail=f"渠道六账号今日额度不足：本次需要 {quota_cost}")

    return idle_accounts[0]


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
        dl.save_config(proxy=body.proxy, env_file=body.env_file, profile_dir=body.profile_dir, send_mode=body.send_mode)
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
    """把已有 Dola 登录态加入账号库。"""
    try:
        if body.cookie.strip():
            status = dl.write_env_from_cookie(body.cookie, env_file=body.env_file, profile_dir=body.profile_dir)
        else:
            status = _dola_status_for_paths(body.env_file, body.profile_dir)
        account = _dola_save_account_from_status(body.name, body.note, status)
        return {"data": account}
    except dl.DolaError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/dola/accounts")
def dola_delete_all_accounts():
    deleted = DolaAccountDB.delete_all()
    return {"data": {"deleted": deleted}}


@app.delete("/dola/accounts/{account_id}")
def dola_delete_account(account_id: int):
    DolaAccountDB.delete(account_id)
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
        if payload.task_id:
            result = dl.open_task_browser(payload.task_id, url=target_url, fallback_account=False)
            if not result.get("ok"):
                raise HTTPException(status_code=409, detail=result.get("task_session_missing_reason") or "任务浏览器会话不可用")
        else:
            result = dl.open_account_browser(url=target_url)
        result["conversation_id"] = conversation_id
        if conversation_id:
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
    """通过浏览器会话提交 Dola 视频生成任务。"""
    try:
        normalized_duration = _dola_normalized_video_duration(body.duration)
        task_id = f"dola-{uuid.uuid4().hex[:12]}"
        with _dola_task_create_lock:
            account = _dola_pick_account(body.account_id, quota_cost=0)
            TaskDB.add(
                task_id=task_id,
                account_id=int(account.get("id") or 0) if account else 0,
                task_type=TaskType.IMAGE_TO_VIDEO if (body.image_path or body.image_url or body.reference_images) else TaskType.TEXT_TO_VIDEO,
                prompt=body.prompt,
                model=f"dola-browser:{body.model}:{normalized_duration}s",
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
                    quota_cost=0,
                    retry_account_picker=None,
                    max_empty_sse_retries=0,
                )
            except Exception:
                TaskDB.update_status(task_id, "failed")
                raise
        result["account_id"] = int(account.get("id") or 0) if account else 0
        result["account_name"] = account.get("name", "") if account else "浏览器会话"
        result["quota_cost"] = 0
        result["send_mode"] = dl.get_send_mode()
        result["send_mode_label"] = next((item["label"] for item in dl.SEND_MODE_OPTIONS if item["id"] == result["send_mode"]), result["send_mode"])
        result["browser_session"] = result["send_mode"] == dl.SEND_MODE_BROWSER
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
        detail = dl.get_task_status(task_id)
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
        if status == "collectable" and detail.get("conversation_id") and not detail.get("video_url") and not detail.get("local_path"):
            try:
                last_collect_at = float(detail.get("collect_started_at") or 0)
            except (TypeError, ValueError):
                last_collect_at = 0
            if not last_collect_at or time.time() - last_collect_at > 60:
                detail = dl.collect_task(task_id=task_id, conversation_id=str(detail.get("conversation_id") or ""))
                status = detail.get("status", "collecting")
                fail_reason = detail.get("fail_reason", "") or detail.get("error", "")
        video_url = detail.get("video_url", "") or detail.get("local_path", "") or ""
        if status == "completed" and video_url:
            TaskDB.update_status(task_id, "completed", video_url)
        elif status == "failed":
            TaskDB.update_status(task_id, "failed")
        elif status in ("pending", "processing", "collecting"):
            TaskDB.update_status(task_id, "processing")
        elif status == "collectable":
            TaskDB.update_status(task_id, "collectable")
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
            "fail_reason": fail_reason,
            "collectable": bool(detail.get("conversation_id")) and status not in ("completed", "failed"),
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
    if body.use_proxy is not None or body.proxy_host is not None or body.proxy_port is not None:
        oi.save_config(
            use_proxy=body.use_proxy,
            proxy_host=body.proxy_host,
            proxy_port=body.proxy_port,
        )

    result = oi.config_status()

    if body.test:
        test_result = oi.test_connection()
        result["test"] = test_result

    return {"data": result}


@app.post("/oiioii/register")
def oiioii_register(body: OiiOiiBatchRegister | None = None):
    """全自动注册 OiiOii 账号（支持 count/concurrency 批量并发）"""
    try:
        count = int(body.count if body else 1) if body else 1
        concurrency = int(body.concurrency if body else 1) if body else 1
        if count <= 1:
            result = oi.register_account()
            return {"data": result}
        result = oi.register_batch(count=count, concurrency=concurrency)
        return {"data": result}
    except oi.OiiOiiError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
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
    return {"message": "deleted"}


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
        "media_type": detail.get("media_type", "video"),
        "file_size": detail.get("file_size"),
        "progress": detail.get("progress"),
        "queue_position": None,
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
)


def _is_allowed_video_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return any(host == h or host.endswith("." + h) or host.endswith(h) for h in _ALLOWED_VIDEO_HOSTS)


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
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
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
def local_video(request: Request, path: str):
    """流式播放本机已下载视频，支持 Range，避免前端直接 file:// 播放失败。"""
    file_path = os.path.abspath(urllib.parse.unquote(path or ""))
    playable_candidate = ""
    if os.path.isfile(file_path):
        root, ext = os.path.splitext(file_path)
        candidate = f"{root}.playable{ext or '.mp4'}"
        if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
            try:
                if os.path.getmtime(candidate) >= os.path.getmtime(file_path):
                    playable_candidate = candidate
            except OSError:
                playable_candidate = ""
    if playable_candidate:
        file_path = playable_candidate
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

    chunk_size = 64 * 1024
    content_length = end - start + 1
    headers = {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

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


@app.get("/proxy/video")
def proxy_video(request: Request, url: str):
    """流式代理远程视频用于内联播放（强制 video/mp4 + 透传 Range）"""
    return _proxy_remote_video(url, request.headers.get("range"), as_download=False, filename="")


@app.get("/download/video")
def download_video(url: str, filename: str = "video.mp4"):
    """以附件形式下载远程视频（强制 video/mp4 + Content-Disposition）"""
    return _proxy_remote_video(url, None, as_download=True, filename=filename)


# ==================== 健康检查 ====================

@app.get("/health")
def health():
    return {"status": "ok", "version": "1.0.0"}


# ==================== 启动入口 ====================

def start_server(host: str = "127.0.0.1", port: int = 8765):
    uvicorn.run(app, host=host, port=port, log_level="info", http="h11")


if __name__ == "__main__":
    start_server()
