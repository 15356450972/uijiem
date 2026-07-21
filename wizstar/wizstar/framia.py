"""Framia 视频生成 API 客户端 — 渠道九

通过 Google OAuth 登录 Framia (https://framia.converge.ai) 后，
使用 accessToken 调用 api.framia.pro 的视频生成接口。

完整流程：
  1. 使用 framia-google-login 模块获取 accessToken + cookie
  2. 创建项目 (POST /video/api/v2/projects)
  3. 获取 OSS 预签名 URL (POST /video/api/v2/get_upload_presigned_url)
  4. 上传图片到阿里云 OSS (PUT <oss_url>)
  5. 通知上传完成 (POST /video/api/v2/projects/{pid}/upload_done) → 返回 resource_id
  6. 发布工作流版本 (POST /video/api/workflows/versions) → 提交 canvas_snapshot
  7. 执行工作流 (POST /video/api/workflows/runs) → 返回 workflow_run_id
  8. 轮询状态 (GET /video/api/workflows/runs/{run_id})
  9. 获取节点结果 (GET /video/api/workflows/runs/{run_id}/nodes) → output resource_id
  10. 获取视频 URL (GET /video/api/v1/resources/{resource_id}/info) → download_url
"""

from __future__ import annotations

import json
import os
import time
import uuid
import subprocess
from pathlib import Path
from .app_paths import get_wizstar_data_dir

import requests

# Framia API 基础地址
API_BASE = "https://api.framia.pro"
FRAMIA_ORIGIN = "https://framia.converge.ai"

# 登录模块路径
_DEFAULT_LOGIN_MODULE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "framia-google-login",
)
LOGIN_MODULE_DIR = os.environ.get("FRAMIA_LOGIN_MODULE_DIR", "").strip() or _DEFAULT_LOGIN_MODULE_DIR
NODE_BIN = os.environ.get("FRAMIA_NODE_BIN", "").strip() or os.environ.get("DOLA_NODE_BIN", "").strip() or "node"
LOGIN_TIMEOUT_SECONDS = int(os.environ.get("FRAMIA_LOGIN_TIMEOUT_SECONDS", "360") or "360")

# 本地配置文件
CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "framia_config.json")

# 默认模型
DEFAULT_MODELS = [
    {"id": "seedance-2-mini", "name": "Seedance 2.0 Mini", "cost_per_sec": 5},
    {"id": "kling-3", "name": "Kling 3.0", "cost_per_sec": 10},
]

DEFAULT_RATIOS = ["16:9", "9:16", "1:1"]


class FramiaError(RuntimeError):
    """Framia 接口调用失败"""

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


def save_config(**kwargs) -> dict:
    config = _load_config()
    for key, value in kwargs.items():
        if value is not None:
            config[key] = value
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


class FramiaClient:
    """Framia API 客户端"""

    def __init__(self, access_token: str, cookie: str = "", user_agent: str = "", timeout: int = 60):
        self.access_token = access_token.strip()
        if not self.access_token:
            raise FramiaError("缺少 Framia accessToken")
        self.cookie = cookie.strip()
        self.user_agent = user_agent.strip() or (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
        )
        self.timeout = timeout

    def _headers(self) -> dict:
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
            "User-Agent": self.user_agent,
            "Origin": FRAMIA_ORIGIN,
            "Referer": f"{FRAMIA_ORIGIN}/",
        }
        if self.cookie:
            headers["Cookie"] = self.cookie
        return headers

    def get_user_info(self) -> dict:
        """获取用户信息"""
        try:
            resp = requests.get(
                f"{API_BASE}/video/api/v2/user/info",
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"请求用户信息失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"获取用户信息失败: HTTP {resp.status_code}", status_code=resp.status_code)
        return data.get("data", data)

    def get_credits(self) -> dict:
        """获取积分余额"""
        try:
            resp = requests.get(
                f"{API_BASE}/video/api/v1/user/credits",
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"请求积分失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"获取积分失败: HTTP {resp.status_code}", status_code=resp.status_code)
        inner = data.get("data", data)
        # credits 响应结构: {code:0, data:{credits:{credits_balance, credit_cent_balance, ...}}}
        credits_obj = inner.get("credits", inner)
        return credits_obj

    def get_model_configs(self) -> dict:
        """获取模型配置列表"""
        try:
            resp = requests.get(
                f"{API_BASE}/video/api/v2/common/get_model_configs",
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"请求模型配置失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"获取模型配置失败: HTTP {resp.status_code}", status_code=resp.status_code)
        return data

    def create_project(self) -> dict:
        """创建新项目，返回 project_id / canvas_id / main_thread_id"""
        try:
            resp = requests.post(
                f"{API_BASE}/video/api/v2/projects",
                headers=self._headers(),
                json={
                    "execution_mode": "auto",
                    "source": "user",
                    "category": "workflow_canvas",
                },
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"创建项目失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"创建项目失败: HTTP {resp.status_code}", status_code=resp.status_code)
        # 响应结构: {code:0, data:{canvas:{canvas_id:...}, project:{project_id:..., main_thread_id:...}}}
        inner = data.get("data", data)
        canvas_id = inner.get("canvas", {}).get("canvas_id", "")
        project = inner.get("project", inner)
        return {
            "project_id": project.get("project_id", ""),
            "canvas_id": canvas_id,
            "main_thread_id": project.get("main_thread_id", ""),
        }

    def get_upload_url(self, project_id: str, filename: str) -> dict:
        """获取 OSS 预签名上传 URL，返回 {url, key}"""
        try:
            resp = requests.post(
                f"{API_BASE}/video/api/v2/get_upload_presigned_url",
                headers=self._headers(),
                json={
                    "project_id": project_id,
                    "filename": filename,
                    "scene": "canvas_upload",
                },
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"获取上传URL失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"获取上传URL失败: HTTP {resp.status_code}", status_code=resp.status_code)
        inner = data.get("data", data)
        return {
            "url": inner.get("url", ""),
            "key": inner.get("key", ""),
        }

    def upload_to_oss(self, upload_url: str, file_path: str, content_type: str = "image/png") -> None:
        """上传文件到阿里云 OSS"""
        with open(file_path, "rb") as f:
            try:
                resp = requests.put(
                    upload_url,
                    data=f,
                    headers={"Content-Type": content_type},
                    timeout=120,
                )
            except requests.RequestException as e:
                raise FramiaError(f"上传到OSS失败: {e}")
        if resp.status_code >= 400:
            raise FramiaError(f"上传到OSS失败: HTTP {resp.status_code}", status_code=resp.status_code)

    def upload_done(self, project_id: str, thread_id: str, filename: str, key: str) -> dict:
        """通知上传完成，返回 resource_id"""
        try:
            resp = requests.post(
                f"{API_BASE}/video/api/v2/projects/{project_id}/upload_done",
                headers=self._headers(),
                json={
                    "thread_id": thread_id,
                    "filename": filename,
                    "key": key,
                    "scene": "canvas_upload",
                    "params": {},
                },
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"通知上传完成失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"通知上传完成失败: HTTP {resp.status_code}", status_code=resp.status_code)
        inner = data.get("data", data)
        return {
            "resource_id": inner.get("resource_id", ""),
            "download_url": inner.get("download_url", ""),
        }

    def publish_workflow_version(
        self,
        project_id: str,
        canvas_id: str,
        node_id: str,
        prompt: str,
        model: str = "Seedance 2.0 Mini",
        aspect_ratio: str = "16:9",
        resolution: str = "720p",
        duration: float = 4,
        resource_ids: list[str] | None = None,
    ) -> dict:
        """发布工作流版本 (POST /video/api/workflows/versions)

        构造 canvas_snapshot 包含一个 Video 节点，提交给 Framia 工作流引擎。
        返回 {workflow_id, version}
        """
        resources = [
            {"resource_id": rid, "media_type": "image"}
            for rid in (resource_ids or [])
        ]
        input_refs = {
            "gen_type": "video",
            "model": model,
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "duration_float": duration,
        }
        if resources:
            input_refs["generation_mode"] = "Omni reference to video"
            input_refs["resources"] = {
                "kind": "resource_collection",
                "resources": resources,
            }
        else:
            input_refs["generation_mode"] = "text to video"

        workflow_id = f"wf_node_{uuid.uuid4().hex[:14]}"
        version = int(time.time() * 1000)

        canvas_snapshot = {
            "meta": {
                "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                "projectId": project_id,
                "canvasId": canvas_id,
                "version": "1.0.0",
            },
            "nodes": [
                {
                    "id": node_id,
                    "type": "Video",
                    "position": {"x": 258, "y": 202.5},
                    "width": 362,
                    "height": 233,
                    "data": {
                        "label": "Video",
                        "node_type": "task",
                        "node_interface": "media.generate.video",
                        "input_refs": input_refs,
                    },
                }
            ],
            "edges": [],
        }

        try:
            resp = requests.post(
                f"{API_BASE}/video/api/workflows/versions",
                headers=self._headers(),
                json={
                    "workflow_id": workflow_id,
                    "version": version,
                    "owner_type": "ad_hoc",
                    "owner_id": project_id,
                    "status": "published",
                    "canvas_snapshot": canvas_snapshot,
                },
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"发布工作流版本失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"发布工作流版本失败: HTTP {resp.status_code}", status_code=resp.status_code)
        return {
            "workflow_id": workflow_id,
            "version": version,
        }

    def run_workflow(
        self,
        workflow_id: str,
        workflow_version: int,
        project_id: str,
        canvas_id: str,
        node_id: str,
    ) -> dict:
        """执行工作流 (POST /video/api/workflows/runs)

        返回 {workflow_run_id, node_run_id}
        """
        client_run_id = f"workflow-client-run-{uuid.uuid4().hex[:16]}"
        try:
            resp = requests.post(
                f"{API_BASE}/video/api/workflows/runs",
                headers=self._headers(),
                json={
                    "workflow_id": workflow_id,
                    "workflow_version": workflow_version,
                    "source_type": "ad_hoc",
                    "source_id": node_id,
                    "client_run_id": client_run_id,
                    "project_id": project_id,
                    "canvas_id": canvas_id,
                    "context_refs": {"run_kind": "execution_graph"},
                    "execution_backend": "temporal",
                },
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"执行工作流失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"执行工作流失败: HTTP {resp.status_code}", status_code=resp.status_code)
        inner = data.get("data", data)
        wf_run = inner.get("workflow_run", {})
        node_runs = inner.get("node_runs", [])
        return {
            "workflow_run_id": wf_run.get("workflow_run_id", ""),
            "status": wf_run.get("status", "queued"),
            "node_run_id": node_runs[0].get("node_run_id", "") if node_runs else "",
        }

    def get_workflow_run_status(self, workflow_run_id: str) -> dict:
        """查询工作流运行状态 (GET /video/api/workflows/runs/{run_id})"""
        try:
            resp = requests.get(
                f"{API_BASE}/video/api/workflows/runs/{workflow_run_id}",
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"查询工作流状态失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"查询工作流状态失败: HTTP {resp.status_code}", status_code=resp.status_code)
        inner = data.get("data", data)
        wf_run = inner.get("workflow_run", inner)
        return {
            "status": wf_run.get("status", ""),
            "workflow_run_id": wf_run.get("workflow_run_id", workflow_run_id),
        }

    def get_workflow_run_nodes(self, workflow_run_id: str) -> dict:
        """查询工作流节点结果 (GET /video/api/workflows/runs/{run_id}/nodes)

        返回节点状态和输出资源 ID。
        """
        try:
            resp = requests.get(
                f"{API_BASE}/video/api/workflows/runs/{workflow_run_id}/nodes",
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"查询工作流节点失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"查询工作流节点失败: HTTP {resp.status_code}", status_code=resp.status_code)
        inner = data.get("data", data)
        node_runs = inner.get("node_runs", [])
        if not node_runs:
            return {"status": "pending", "resource_id": ""}
        node = node_runs[0]
        status = node.get("status", "")
        output = node.get("output", {}) or {}
        result = output.get("result", {}) or {}
        resources = result.get("resources", []) or []
        resource_id = resources[0].get("resource_id", "") if resources else ""
        return {
            "status": status,
            "resource_id": resource_id,
            "node_run_id": node.get("node_run_id", ""),
        }

    def get_resource_info(self, resource_id: str) -> dict:
        """获取资源信息 (GET /video/api/v1/resources/{resource_id}/info)

        返回 download_url / preview_url / thumbnail_url / media_type 等。
        """
        try:
            resp = requests.get(
                f"{API_BASE}/video/api/v1/resources/{resource_id}/info",
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            raise FramiaError(f"获取资源信息失败: {e}")
        data = _parse_json(resp)
        if resp.status_code >= 400:
            raise FramiaError(f"获取资源信息失败: HTTP {resp.status_code}", status_code=resp.status_code)
        inner = data.get("data", data)
        info = inner.get("resource_info", inner)
        return {
            "resource_id": info.get("resource_id", resource_id),
            "download_url": info.get("download_url", ""),
            "preview_url": info.get("preview_url", ""),
            "thumbnail_url": info.get("thumbnail_url", ""),
            "media_type": info.get("media_type", ""),
            "duration": info.get("duration", 0),
        }

    def test_connection(self) -> dict:
        """验证 accessToken 是否有效"""
        try:
            info = self.get_user_info()
            credits = self.get_credits()
            return {
                "ok": True,
                "user_id": info.get("user_id", ""),
                "email": info.get("email", ""),
                "plan_level": info.get("plan_level", 0),
                "credits_balance": credits.get("credits_balance", 0),
                "credit_cent_balance": credits.get("credit_cent_balance", 0),
            }
        except FramiaError as e:
            return {"ok": False, "error": str(e)}


def _parse_json(resp: requests.Response) -> dict:
    try:
        return resp.json()
    except ValueError:
        return {"_raw": resp.text}


def login_with_google(email: str, password: str, visible: bool = True, proxy: str = "", keep_open: bool = False) -> dict:
    """调用 framia-google-login 模块进行 Google OAuth 登录，返回 accessToken + cookie"""
    node_script = os.path.join(LOGIN_MODULE_DIR, "index.mjs")
    if not os.path.isfile(node_script):
        raise FramiaError(f"framia-google-login 模块未找到: {node_script}")

    args = [NODE_BIN, node_script, "--email", email, "--password", password]
    if not visible:
        args.append("--headless")
    if keep_open:
        args.append("--keep-open")
    if proxy:
        args.extend(["--proxy", proxy])

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=LOGIN_TIMEOUT_SECONDS,
            cwd=LOGIN_MODULE_DIR,
        )
    except subprocess.TimeoutExpired:
        raise FramiaError(f"Framia 登录超时（{LOGIN_TIMEOUT_SECONDS}秒）")
    except FileNotFoundError:
        raise FramiaError(f"Node.js 未安装或不在 PATH 中: {NODE_BIN}")

    if result.returncode != 0:
        output = (result.stderr.strip() or result.stdout.strip()).strip()
        raise FramiaError(f"Framia 登录失败（exit={result.returncode}）: {output[-2000:] or '无输出'}")

    # 解析输出中的 state_json 行
    for line in result.stdout.splitlines():
        if line.startswith("[framia-login] state_json:"):
            json_str = line.split("state_json:", 1)[1].strip()
            try:
                return json.loads(json_str)
            except json.JSONDecodeError:
                raise FramiaError(f"解析登录结果失败: {json_str[:200]}")

    raise FramiaError("登录成功但未找到 state_json 输出")


def has_valid_token(account: dict) -> bool:
    """检查账号是否有有效的 accessToken"""
    token = str(account.get("access_token") or "").strip()
    if not token:
        return False
    expires_at = int(account.get("expires_at") or 0)
    if expires_at and expires_at < int(time.time() * 1000):
        return False
    return True


def pick_account(account_id: int = 0) -> dict:
    """从账号库选择一个可用账号"""
    from .database import FramiaAccountDB

    if account_id:
        account = FramiaAccountDB.get(account_id)
        if not account:
            raise FramiaError("Framia 账号不存在")
        if account.get("status") != "active":
            raise FramiaError(f"该渠道九账号不可用：{account.get('status')}")
        if not has_valid_token(account):
            raise FramiaError("该渠道九账号 accessToken 已过期，请重新登录")
        return account

    accounts = FramiaAccountDB.list_all()
    available = [a for a in accounts if a.get("status") == "active" and has_valid_token(a)]
    if not available:
        raise FramiaError("没有可用的渠道九账号，请先登录采集账号")

    # 选择活跃任务最少的账号
    from .database import TaskDB
    for account in available:
        active_count = TaskDB.active_count_for_account(int(account.get("id") or 0), model_prefix="framia:")
        if active_count == 0:
            return account
    return available[0]
