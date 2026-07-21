"""YesCaptcha 任务客户端：reCAPTCHA v2 / Turnstile 统一解码。

设计原则：
- 纯函数式 DSL：create_task -> poll -> get_solution，调用方只关心 token。
- 不耦合任何业务（不知道 Wizstar / OreateAI / QuickFrame）。
- clientKey 由调用方注入；本模块不读环境变量，不做 IO 副作用之外的事情。
- 失败抛 RuntimeError，错误信息只暴露 errorId / status / 简短描述，不打印 token。
"""

from __future__ import annotations

import time
import urllib.request
import json
from typing import Literal, TypedDict, Optional


_API_BASE = "https://api.yescaptcha.com"


class YesCaptchaError(RuntimeError):
    """YesCaptcha 调用失败（创建 / 轮询 / 解析）。"""


class _TaskSpec(TypedDict, total=False):
    """createTask.task 子集；按 YesCaptcha 官方约定透传。"""
    type: str
    websiteURL: str
    websiteKey: str
    # 可选高级字段（部分任务类型支持代理 / userAgent）
    proxyType: str
    proxyUri: str
    userAgent: str


class _CreateResp(TypedDict, total=False):
    errorId: int
    errorCode: Optional[str]
    errorDescription: Optional[str]
    taskId: str


class _PollResp(TypedDict, total=False):
    errorId: int
    errorCode: Optional[str]
    errorDescription: Optional[str]
    status: Literal["processing", "ready"]
    solution: dict


# ---- 内部 HTTP ----

def _post_json(url: str, payload: dict, *, timeout: int = 30) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        # YesCaptcha 错误响应也是 JSON，尽量解析
        try:
            err_body = e.read().decode("utf-8")
            return json.loads(err_body) if err_body else {"errorId": 1, "errorDescription": f"HTTP {e.code}"}
        except Exception:
            raise YesCaptchaError(f"{url} HTTP {e.code}")


# ---- 对外 API ----

def solve_recaptcha_v2(
    client_key: str,
    website_url: str,
    website_key: str,
    *,
    is_invisible: bool = True,
    proxy_uri: Optional[str] = None,
    user_agent: Optional[str] = None,
    task_type: Optional[str] = None,
    max_wait_seconds: int = 180,
    poll_interval_seconds: int = 3,
) -> str:
    """解 reCAPTCHA v2（含 invisible），返回 grecaptcha.execute 风格的 token。

    YesCaptcha 官方文档（NoCaptchaTaskProxyless 页）支持的任务类型：
    - NoCaptchaTaskProxyless（15 点，首推）
    - RecaptchaV2TaskProxyless（20 点，备用）
    invisible 通过 task.isInvisible=true 区分，不换类型名。

    带代理时选用 NoCaptchaTask（同结构、加 proxyType/proxyUri）；
    调用方可通过 task_type 参数显式覆盖默认类型（应对服务端策略变化）。

    返回的 token 对应后端 `recaptcha_response` 字段，可直接 POST 到站点 verify 接口。
    """
    if not client_key:
        raise YesCaptchaError("缺少 YesCaptcha clientKey")
    if not website_url or not website_key:
        raise YesCaptchaError("reCAPTCHA 解码需要 websiteURL 与 websiteKey")

    resolved_type = task_type or (
        "NoCaptchaTaskProxyless" if not proxy_uri else "NoCaptchaTask"
    )
    task: _TaskSpec = {
        "type": resolved_type,
        "websiteURL": website_url,
        "websiteKey": website_key,
    }
    # Invisible reCAPTCHA：在同类型任务上加 isInvisible=true，yescap 服务端据此走 v2 invisible 流程。
    if is_invisible:
        task["isInvisible"] = True  # type: ignore[typeddict-unknown-key]
    if proxy_uri:
        task["proxyType"] = "http"
        task["proxyUri"] = proxy_uri
    if user_agent:
        task["userAgent"] = user_agent

    create_payload = {
        "clientKey": client_key,
        "task": task,
    }

    created = _post_json(f"{_API_BASE}/createTask", create_payload)
    if created.get("errorId"):
        raise YesCaptchaError(
            f"createTask 失败: errorId={created.get('errorId')} "
            f"code={created.get('errorCode')} desc={created.get('errorDescription')}"
        )
    task_id = created.get("taskId")
    if not task_id:
        raise YesCaptchaError(f"createTask 未返回 taskId: {created}")

    deadline = time.time() + max_wait_seconds
    last_status = ""
    while time.time() < deadline:
        time.sleep(poll_interval_seconds)
        res = _post_json(
            f"{_API_BASE}/getTaskResult",
            {"clientKey": client_key, "taskId": task_id},
        )
        if res.get("errorId"):
            raise YesCaptchaError(
                f"getTaskResult 失败: errorId={res.get('errorId')} "
                f"code={res.get('errorCode')} desc={res.get('errorDescription')}"
            )
        last_status = res.get("status", "")
        if res.get("status") == "ready":
            solution = res.get("solution") or {}
            token = solution.get("gRecaptchaResponse") or solution.get("token") or ""
            if not token:
                raise YesCaptchaError(f"getTaskResult ready 但无 token: solution_keys={list(solution.keys())}")
            return token

    raise YesCaptchaError(f"getTaskResult 超时未解出: taskId={task_id} last_status={last_status}")


def solve_turnstile(
    client_key: str,
    website_url: str,
    website_key: str,
    *,
    max_wait_seconds: int = 180,
    poll_interval_seconds: int = 3,
) -> str:
    """解 Cloudflare Turnstile，返回 cf-turnstile-response token。"""
    if not client_key:
        raise YesCaptchaError("缺少 YesCaptcha clientKey")
    if not website_url or not website_key:
        raise YesCaptchaError("Turnstile 解码需要 websiteURL 与 websiteKey")

    created = _post_json(
        f"{_API_BASE}/createTask",
        {
            "clientKey": client_key,
            "task": {
                "type": "TurnstileTaskProxyless",
                "websiteURL": website_url,
                "websiteKey": website_key,
            },
        },
    )
    if created.get("errorId"):
        raise YesCaptchaError(
            f"createTask 失败: errorId={created.get('errorId')} "
            f"code={created.get('errorCode')} desc={created.get('errorDescription')}"
        )
    task_id = created.get("taskId")
    if not task_id:
        raise YesCaptchaError(f"createTask 未返回 taskId: {created}")

    deadline = time.time() + max_wait_seconds
    while time.time() < deadline:
        time.sleep(poll_interval_seconds)
        res = _post_json(
            f"{_API_BASE}/getTaskResult",
            {"clientKey": client_key, "taskId": task_id},
        )
        if res.get("errorId"):
            raise YesCaptchaError(
                f"getTaskResult 失败: errorId={res.get('errorId')} "
                f"code={res.get('errorCode')} desc={res.get('errorDescription')}"
            )
        if res.get("status") == "ready":
            solution = res.get("solution") or {}
            token = solution.get("token") or solution.get("cf-turnstile-response") or ""
            if not token:
                raise YesCaptchaError(f"getTaskResult ready 但无 token: solution_keys={list(solution.keys())}")
            return token

    raise YesCaptchaError(f"getTaskResult 超时未解出: taskId={task_id}")