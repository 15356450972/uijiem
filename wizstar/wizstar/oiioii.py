"""OiiOii.ai 渠道四桥接模块 — 通过 subprocess 调用 Node.js SDK

与 Pixmax（渠道二）类似，OiiOii 在本地通过 oiioii-sdk 提供：
  - 账号注册/登录（自动破解验证码）
  - 图片/视频生成（提交 + 轮询）
  - 积分查询/签到

本模块负责：
  1. 管理本地配置（代理、账号文件路径）
  2. 调用 Node.js CLI 执行操作
  3. 解析输出并返回结构化结果
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
import base64
import re
import tempfile
import threading
from pathlib import Path

from .app_paths import get_wizstar_data_dir

def _clean_str(value, default: str = "") -> str:
    """Return a stripped string while treating None as an empty value."""
    if value is None:
        return default
    return str(value).strip()


def _data_url_to_temp_file(data_url: str) -> str:
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", _clean_str(data_url), re.S)
    if not match:
        return ""
    mime = match.group(1).lower()
    ext_map = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    ext = ext_map.get(mime, ".png")
    raw = base64.b64decode(match.group(2), validate=True)
    fd, temp_path = tempfile.mkstemp(prefix="oiioii_ref_", suffix=ext)
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    return temp_path


def _normalize_reference_image(ref: str) -> tuple[str, str]:
    ref = _clean_str(ref)
    if not ref:
        return "", ""
    if ref.startswith("data:image/"):
        return _data_url_to_temp_file(ref), "temp"
    return ref, ""


def _cleanup_temp_files(paths: list[str]) -> None:
    for path in paths:
        try:
            if path and os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass


def _friendly_image_error(message: str, model: str = "") -> str:
    text = _clean_str(message)
    if not text:
        return "图片生成失败，请稍后重试。"
    if re.search(r"GPT Image 2|generate_image_gpt_image2|Failed to generate image", text, re.I):
        if model == "gpt-image2":
            return "渠道四 GPT-Image2 当前上游生成失败，已尝试自动切换 GPT-4o 重试；仍失败时请更换模型或稍后重试。"
        return "渠道四图片生成失败，请更换模型、降低并发或稍后重试。"
    return text


CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "oiioii_config.json")
ACCOUNT_DIR = os.path.join(get_wizstar_data_dir(), "oiioii_accounts")
DOWNLOAD_DIR = os.path.join(get_wizstar_data_dir(), "oiioii_downloads")
_account_pick_lock = threading.Lock()
_account_pick_cursor = 0

# oiioii-sdk 目录：相对于本模块向上找到项目根目录下的 oiioii-sdk
_MODULE_DIR = Path(__file__).resolve().parent
_SDK_DIR_CANDIDATES = [
    _MODULE_DIR.parent.parent / "oiioii-sdk",           # 开发环境
    _MODULE_DIR.parent.parent.parent / "oiioii-sdk",    # py-dist 打包
    Path(os.environ.get("OIIOII_SDK_DIR", "")) if os.environ.get("OIIOII_SDK_DIR") else None,
]

# 内存中的任务状态缓存（task_id → {status, video_url, progress, ...}）
_task_cache: dict[str, dict] = {}


class OiiOiiError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _get_sdk_dir() -> str:
    for candidate in _SDK_DIR_CANDIDATES:
        if candidate and candidate.is_dir() and (candidate / "oiioii_sdk.js").exists():
            return str(candidate)
    raise OiiOiiError(
        "找不到 oiioii-sdk 目录，请确保项目根目录下存在 oiioii-sdk/ 文件夹，"
        "或设置环境变量 OIIOII_SDK_DIR 指向该目录"
    )


def _get_node_bin() -> str:
    node = os.environ.get("OIIOII_NODE_BIN", "node")
    return node


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_config(
    use_proxy: bool | None = None,
    proxy_host: str | None = None,
    proxy_port: int | None = None,
) -> dict:
    config = _load_config()
    if use_proxy is not None:
        config["use_proxy"] = use_proxy
    if proxy_host is not None:
        config["proxy_host"] = _clean_str(proxy_host, "127.0.0.1")
    if proxy_port is not None:
        config["proxy_port"] = int(proxy_port)
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


def config_status() -> dict:
    config = _load_config()
    Path(ACCOUNT_DIR).mkdir(parents=True, exist_ok=True)
    account_files = [f for f in os.listdir(ACCOUNT_DIR) if f.endswith(".json")]
    accounts = []
    for af in account_files:
        try:
            with open(os.path.join(ACCOUNT_DIR, af), "r", encoding="utf-8") as f:
                acc = json.load(f)
                accounts.append({
                    "file": af,
                    "email": acc.get("email", ""),
                    "has_token": bool(acc.get("token")),
                    "saved_at": acc.get("savedAt", ""),
                    "points": acc.get("points"),
                    "availableLimited": acc.get("availableLimited"),
                    "availablePerm": acc.get("availablePerm"),
                    "hasSignedInToday": acc.get("hasSignedInToday"),
                    "points_updated_at": acc.get("pointsUpdatedAt", ""),
                })
        except (json.JSONDecodeError, OSError):
            pass

    try:
        sdk_dir = _get_sdk_dir()
        sdk_available = True
    except OiiOiiError:
        sdk_dir = ""
        sdk_available = False

    return {
        "configured": sdk_available and len(accounts) > 0,
        "sdk_available": sdk_available,
        "sdk_dir": sdk_dir,
        "use_proxy": config.get("use_proxy", True),
        "proxy_host": config.get("proxy_host", "127.0.0.1"),
        "proxy_port": config.get("proxy_port", 7890),
        "account_count": len(accounts),
        "accounts": accounts,
    }


def _run_sdk_script(script: str, timeout: int = 300) -> dict:
    """在 Node.js 中执行一段 JS 脚本，返回 JSON 结果。"""
    sdk_dir = _get_sdk_dir()
    node = _get_node_bin()

    wrapper = f"""
const path = require('path');
process.chdir({json.dumps(sdk_dir)});
(async () => {{
  try {{
    {script}
  }} catch (e) {{
    process.stdout.write(JSON.stringify({{ error: e.message || String(e) }}));
    process.exit(1);
  }}
}})();
"""
    try:
        result = subprocess.run(
            [node, "-e", wrapper],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=sdk_dir,
            env={**os.environ, "NODE_PATH": sdk_dir},
        )
    except subprocess.TimeoutExpired:
        raise OiiOiiError(f"Node.js 脚本执行超时（{timeout}s）")
    except FileNotFoundError:
        raise OiiOiiError(f"找不到 Node.js 可执行文件: {node}，请确保已安装 Node.js")

    output = result.stdout.strip()
    if not output:
        stderr = result.stderr.strip()
        if stderr:
            raise OiiOiiError(f"SDK 执行失败: {stderr[:500]}")
        raise OiiOiiError("SDK 无输出")

    # 提取最后一行 JSON（SDK 可能有 console.log 调试输出）
    lines = output.split("\n")
    for line in reversed(lines):
        line = line.strip()
        if line.startswith("{") or line.startswith("["):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue

    if result.returncode != 0:
        raise OiiOiiError(f"SDK 执行失败 (exit {result.returncode}): {output[:300]}")

    raise OiiOiiError(f"SDK 输出无法解析为 JSON: {output[:300]}")


def _run_sdk_script_stream(script: str, timeout: int = 300, on_event=None) -> dict:
    """流式执行 Node.js 脚本，逐行接收 JSON 进度事件，并返回最终 JSON。"""
    sdk_dir = _get_sdk_dir()
    node = _get_node_bin()

    wrapper = f"""
const path = require('path');
process.chdir({json.dumps(sdk_dir)});
(async () => {{
  try {{
    {script}
  }} catch (e) {{
    process.stdout.write(JSON.stringify({{ error: e.message || String(e) }}) + '\\n');
    process.exit(1);
  }}
}})();
"""
    try:
        proc = subprocess.Popen(
            [node, "-e", wrapper],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=sdk_dir,
            env={**os.environ, "NODE_PATH": sdk_dir},
        )
    except FileNotFoundError:
        raise OiiOiiError(f"找不到 Node.js 可执行文件: {node}，请确保已安装 Node.js")

    final_result = None
    output_lines: list[str] = []
    start = time.time()
    try:
        while True:
            if proc.poll() is not None:
                break
            if time.time() - start > timeout:
                proc.kill()
                raise OiiOiiError(f"Node.js 脚本执行超时（{timeout}s）")
            line = proc.stdout.readline() if proc.stdout else ""
            if not line:
                time.sleep(0.1)
                continue
            line = line.strip()
            if not line:
                continue
            output_lines.append(line)
            if not (line.startswith("{") or line.startswith("[")):
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict) and item.get("__type") == "progress":
                if on_event:
                    on_event(item)
            else:
                final_result = item

        remaining_out = proc.stdout.read() if proc.stdout else ""
        for line in remaining_out.splitlines():
            line = line.strip()
            if not line:
                continue
            output_lines.append(line)
            if not (line.startswith("{") or line.startswith("[")):
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict) and item.get("__type") == "progress":
                if on_event:
                    on_event(item)
            else:
                final_result = item

        stderr = proc.stderr.read().strip() if proc.stderr else ""
        if proc.returncode != 0 and final_result is None:
            output = "\n".join(output_lines).strip()
            raise OiiOiiError(f"SDK 执行失败 (exit {proc.returncode}): {(output or stderr)[:500]}")
        if final_result is not None:
            return final_result
        if stderr:
            raise OiiOiiError(f"SDK 执行失败: {stderr[:500]}")
        raise OiiOiiError("SDK 输出无法解析为 JSON")
    finally:
        if proc.poll() is None:
            proc.kill()


def _account_file_path(email: str | None = None) -> str:
    Path(ACCOUNT_DIR).mkdir(parents=True, exist_ok=True)
    if email:
        email = _clean_str(email)
        for file_path in Path(ACCOUNT_DIR).glob("*.json"):
            try:
                acc = json.loads(file_path.read_text(encoding="utf-8"))
                if _clean_str(acc.get("email")).lower() == email.lower():
                    return str(file_path)
            except (json.JSONDecodeError, OSError):
                continue
        safe = email.replace("@", "_at_").replace(".", "_")
        return os.path.join(ACCOUNT_DIR, f"{safe}.json")
    files = sorted(Path(ACCOUNT_DIR).glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if files:
        return str(files[0])
    return os.path.join(ACCOUNT_DIR, "default.json")


def _pick_account() -> dict:
    """轮询选择一个可用账号，避免所有任务始终打到同一个账号。"""
    global _account_pick_cursor
    Path(ACCOUNT_DIR).mkdir(parents=True, exist_ok=True)
    candidates = []
    for f in sorted(Path(ACCOUNT_DIR).glob("*.json"), key=lambda p: p.name.lower()):
        try:
            acc = json.loads(f.read_text(encoding="utf-8"))
            if acc.get("token"):
                acc["_file"] = str(f)
                candidates.append(acc)
        except (json.JSONDecodeError, OSError):
            continue

    if not candidates:
        raise OiiOiiError("没有可用的渠道四账号，请先注册或导入账号")

    with _account_pick_lock:
        index = _account_pick_cursor % len(candidates)
        _account_pick_cursor = (index + 1) % len(candidates)
        return candidates[index]


def _proxy_args() -> str:
    """生成 JS 代码中的 proxy 配置片段"""
    config = _load_config()
    use_proxy = config.get("use_proxy", True)
    if not use_proxy:
        return "useProxy: false"
    host = config.get("proxy_host", "127.0.0.1")
    port = config.get("proxy_port", 7890)
    return f"useProxy: true, proxy: {{ host: '{host}', port: {port} }}"


# ==================== 公开 API ====================

def register_account() -> dict:
    """全自动注册一个 OiiOii 账号（临时邮箱 + 验证码破解 + 邮箱验证）"""
    account_file = os.path.join(ACCOUNT_DIR, f"acc_{uuid.uuid4().hex[:8]}.json")
    Path(ACCOUNT_DIR).mkdir(parents=True, exist_ok=True)

    script = f"""
const {{ OiiOiiClient }} = require('./oiioii_sdk');
const client = new OiiOiiClient({{ {_proxy_args()}, debug: false }});
const result = await client.register();
await client.login();
const points = await client.getPoints();
const accountPath = {json.dumps(account_file)};
const fs = require('fs');
fs.writeFileSync(accountPath, JSON.stringify(client.toAccount(), null, 2), 'utf-8');
process.stdout.write(JSON.stringify({{
  success: true,
  email: result.email,
  points: points.points,
  account_file: accountPath
}}));
"""
    return _run_sdk_script(script, timeout=180)


def register_batch(count: int = 1, concurrency: int = 2) -> dict:
    """并发注册多个 OiiOii 账号。"""
    import concurrent.futures

    count = max(1, min(int(count or 1), 50))
    concurrency = max(1, min(int(concurrency or 1), 10, count))
    results = {"success": [], "failed": [], "success_count": 0, "failed_count": 0, "total": count}

    def _worker(index: int) -> dict:
        try:
            data = register_account()
            return {"ok": True, "index": index, **data}
        except Exception as e:
            return {"ok": False, "index": index, "error": str(e)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(_worker, i + 1) for i in range(count)]
        for future in concurrent.futures.as_completed(futures):
            item = future.result()
            if item.get("ok") and item.get("success"):
                results["success"].append(item)
            else:
                results["failed"].append(item)

    results["success"].sort(key=lambda x: x.get("index", 0))
    results["failed"].sort(key=lambda x: x.get("index", 0))
    results["success_count"] = len(results["success"])
    results["failed_count"] = len(results["failed"])
    return results


def login_account(email: str, password: str) -> dict:
    """用已有账号登录"""
    email = _clean_str(email)
    password = _clean_str(password)
    if not email or not password:
        raise OiiOiiError("邮箱和密码不能为空")
    account_file = _account_file_path(email)

    script = f"""
const {{ OiiOiiClient }} = require('./oiioii_sdk');
const client = new OiiOiiClient({{
  email: {json.dumps(email)},
  password: {json.dumps(password)},
  {_proxy_args()},
  debug: false
}});
await client.login();
const points = await client.getPoints();
const accountPath = {json.dumps(account_file)};
const fs = require('fs');
fs.writeFileSync(accountPath, JSON.stringify(client.toAccount(), null, 2), 'utf-8');
process.stdout.write(JSON.stringify({{
  success: true,
  email: {json.dumps(email)},
  token_prefix: client.token ? client.token.substring(0, 20) + '...' : '',
  points: points.points,
  account_file: accountPath
}}));
"""
    return _run_sdk_script(script, timeout=120)


def get_points(email: str | None = None, claim_daily: bool = False) -> dict:
    """查询指定账号积分，可选领取每日积分，并写回账号文件。"""
    email = _clean_str(email) or None
    acc = _pick_account() if not email else None
    if email:
        account_file = _account_file_path(email)
    else:
        account_file = acc["_file"]

    sign_in_line = "const signInResult = await client.signIn().catch((e) => ({ error: e.message || String(e) }));" if claim_daily else "const signInResult = null;"
    script = f"""
const {{ OiiOiiClient }} = require('./oiioii_sdk');
const client = OiiOiiClient.fromAccount({json.dumps(account_file)}, {{ {_proxy_args()} }});
await client.login();
{sign_in_line}
const points = await client.getPoints();
const fs = require('fs');
const accountData = client.toAccount();
accountData.points = points.points;
accountData.availableLimited = points.availableLimited;
accountData.availablePerm = points.availablePerm;
accountData.hasSignedInToday = points.hasSignedInToday;
accountData.pointsUpdatedAt = new Date().toISOString();
fs.writeFileSync({json.dumps(account_file)}, JSON.stringify(accountData, null, 2), 'utf-8');
process.stdout.write(JSON.stringify({{
  success: true,
  email: client.email,
  points: points.points,
  availableLimited: points.availableLimited,
  availablePerm: points.availablePerm,
  hasSignedInToday: points.hasSignedInToday,
  claimedDaily: {str(claim_daily).lower()},
  dailyAdded: Number(signInResult && !signInResult.error ? (signInResult.added || signInResult.data?.added || 0) : 0),
  dailySignedIn: Boolean(signInResult && !signInResult.error && (signInResult.signedIn || signInResult.data?.signedIn)),
  signInResult
}}));
"""
    return _run_sdk_script(script, timeout=60)


def get_all_points(claim_daily: bool = False, concurrency: int = 3) -> dict:
    """查询或领取所有渠道四账号积分。"""
    import concurrent.futures

    Path(ACCOUNT_DIR).mkdir(parents=True, exist_ok=True)
    accounts = []
    for f in sorted(Path(ACCOUNT_DIR).glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            acc = json.loads(f.read_text(encoding="utf-8"))
            email = _clean_str(acc.get("email"))
            if email and acc.get("token"):
                accounts.append(email)
        except (json.JSONDecodeError, OSError):
            continue

    concurrency = max(1, min(int(concurrency or 1), 10, len(accounts) or 1))
    results = {"success": [], "failed": [], "success_count": 0, "failed_count": 0, "total": len(accounts), "claimedDaily": claim_daily}

    def _worker(email_value: str) -> dict:
        try:
            return get_points(email=email_value, claim_daily=claim_daily)
        except Exception as e:
            return {"success": False, "email": email_value, "error": str(e)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(_worker, email_value) for email_value in accounts]
        for future in concurrent.futures.as_completed(futures):
            item = future.result()
            if item.get("success"):
                results["success"].append(item)
            else:
                results["failed"].append(item)

    results["success"].sort(key=lambda x: x.get("email", ""))
    results["failed"].sort(key=lambda x: x.get("email", ""))
    results["success_count"] = len(results["success"])
    results["failed_count"] = len(results["failed"])
    return results


def generate_video(
    prompt: str = "",
    image_path: str = "",
    image_url: str = "",
    reference_images: list[str] | None = None,
    model: str = "gemini",
    duration: int = 10,
    aspect_ratio: str = "16:9",
    resolution: str = "720p",
) -> dict:
    """提交视频生成任务（异步，后台线程轮询）"""
    prompt = _clean_str(prompt)
    image_path = _clean_str(image_path)
    image_url = _clean_str(image_url)
    reference_images = reference_images or []
    model = _clean_str(model, "gemini") or "gemini"
    aspect_ratio = _clean_str(aspect_ratio, "16:9") or "16:9"
    resolution = _clean_str(resolution, "720p") or "720p"
    acc = _pick_account()
    account_file = acc["_file"]
    task_id = f"oiioii-{uuid.uuid4().hex[:12]}"
    Path(DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)
    output_file = os.path.join(DOWNLOAD_DIR, f"{task_id}.mp4")

    _task_cache[task_id] = {
        "status": "pending",
        "progress": 0,
        "video_url": "",
        "error": "",
        "model": model,
    }

    import threading

    def _run():
        temp_refs = []
        try:
            refs = []
            if image_path and os.path.isfile(image_path):
                refs.append(image_path)
            if image_url:
                normalized_ref, ref_kind = _normalize_reference_image(image_url)
                if normalized_ref:
                    refs.append(normalized_ref)
                    if ref_kind == "temp":
                        temp_refs.append(normalized_ref)
            for ref in reference_images:
                normalized_ref, ref_kind = _normalize_reference_image(ref)
                if not normalized_ref:
                    continue
                refs.append(normalized_ref)
                if ref_kind == "temp":
                    temp_refs.append(normalized_ref)
            ref_arg = f"referenceImages: {json.dumps(refs)}," if refs else ""

            script = f"""
const {{ OiiOiiClient }} = require('./oiioii_sdk');
const client = OiiOiiClient.fromAccount({json.dumps(account_file)}, {{ {_proxy_args()} }});
await client.login();
const result = await client.generateVideo({{
  prompt: {json.dumps(prompt)},
  model: {json.dumps(model)},
  duration: {duration},
  aspectRatio: {json.dumps(aspect_ratio)},
  resolution: {json.dumps(resolution)},
  {ref_arg}
  download: true,
  filename: {json.dumps(os.path.basename(output_file))},
  outputDir: {json.dumps(DOWNLOAD_DIR)},
  onProgress: (p, elapsed) => {{
    process.stdout.write(JSON.stringify({{ __type: 'progress', progress: p || 0, elapsed }}) + '\\n');
  }}
}});
const fs = require('fs');
fs.writeFileSync({json.dumps(account_file)}, JSON.stringify(client.toAccount(), null, 2), 'utf-8');
process.stdout.write(JSON.stringify({{
  success: true,
  taskId: result.taskId,
  cdnUrl: result.cdnUrl,
  downloadUrl: result.downloadUrl,
  outputUri: result.outputUri,
  localPath: result.localPath,
  fileSize: result.fileSize,
  submittedModel: result.submittedModel,
  submittedMcpMethodName: result.submittedMcpMethodName,
  submittedModelParam: result.submittedModelParam
}}));
"""
            def _on_progress(event: dict):
                progress = event.get("progress", 0)
                try:
                    progress = int(float(progress or 0))
                except (TypeError, ValueError):
                    progress = 0
                progress = max(0, min(99, progress))
                _task_cache[task_id].update({
                    "status": "running",
                    "progress": progress,
                    "elapsed": event.get("elapsed"),
                })

            result = _run_sdk_script_stream(script, timeout=900, on_event=_on_progress)
            if result.get("error"):
                _task_cache[task_id] = {
                    "status": "failed",
                    "progress": 0,
                    "video_url": "",
                    "error": result["error"],
                    "submitted_model": model,
                }
            else:
                _task_cache[task_id] = {
                    "status": "completed",
                    "progress": 100,
                    "video_url": result.get("localPath") or result.get("downloadUrl") or result.get("cdnUrl") or "",
                    "local_path": result.get("localPath") or "",
                    "file_size": result.get("fileSize"),
                    "cdn_url": result.get("cdnUrl") or "",
                    "download_url": result.get("downloadUrl") or "",
                    "output_uri": result.get("outputUri") or "",
                    "submitted_model": result.get("submittedModel") or model,
                    "submitted_mcp_method_name": result.get("submittedMcpMethodName") or "",
                    "submitted_model_param": result.get("submittedModelParam") or "",
                    "error": "",
                    "sdk_task_id": result.get("taskId", ""),
                }
        except OiiOiiError as e:
            _task_cache[task_id] = {
                "status": "failed",
                "progress": 0,
                "video_url": "",
                "error": str(e),
            }
        except Exception as e:
            _task_cache[task_id] = {
                "status": "failed",
                "progress": 0,
                "video_url": "",
                "error": str(e),
            }
        finally:
            _cleanup_temp_files(temp_refs)

    _task_cache[task_id]["status"] = "running"
    t = threading.Thread(target=_run, daemon=True)
    t.start()

    return {"task_id": task_id, "status": "pending"}


def generate_image(
    prompt: str = "",
    image_path: str = "",
    image_url: str = "",
    reference_images: list[str] | None = None,
    image_to_image: bool = False,
    model: str = "nano-pro",
    aspect_ratio: str = "1:1",
    resolution: str = "1K",
) -> dict:
    """提交图片生成任务（异步，后台线程轮询）"""
    prompt = _clean_str(prompt)
    image_path = _clean_str(image_path)
    image_url = _clean_str(image_url)
    reference_images = reference_images or []
    image_to_image = bool(image_to_image or image_path or image_url or reference_images)
    model = _clean_str(model, "nano-pro") or "nano-pro"
    aspect_ratio = _clean_str(aspect_ratio, "1:1") or "1:1"
    resolution = _clean_str(resolution, "1K") or "1K"
    acc = _pick_account()
    account_file = acc["_file"]
    task_id = f"oiioii-img-{uuid.uuid4().hex[:12]}"

    _task_cache[task_id] = {
        "status": "pending",
        "progress": 0,
        "video_url": "",
        "error": "",
        "model": model,
    }

    import threading

    def _run():
        temp_refs = []
        try:
            refs = []
            if image_path and os.path.isfile(image_path):
                refs.append(image_path)
            if image_url:
                normalized_ref, ref_kind = _normalize_reference_image(image_url)
                if normalized_ref:
                    refs.append(normalized_ref)
                    if ref_kind == "temp":
                        temp_refs.append(normalized_ref)
            for ref in reference_images:
                normalized_ref, ref_kind = _normalize_reference_image(ref)
                if not normalized_ref:
                    continue
                refs.append(normalized_ref)
                if ref_kind == "temp":
                    temp_refs.append(normalized_ref)
            ref_arg = f"referenceImages: {json.dumps(refs)},\n  imageToImage: true," if refs or image_to_image else ""

            output_file = os.path.join(DOWNLOAD_DIR, f"{task_id}.png")
            script = f"""
const {{ OiiOiiClient }} = require('./oiioii_sdk');
const client = OiiOiiClient.fromAccount({json.dumps(account_file)}, {{ {_proxy_args()} }});
await client.login();
const requestOptions = {{
  prompt: {json.dumps(prompt)},
  model: {json.dumps(model)},
  aspectRatio: {json.dumps(aspect_ratio)},
  resolution: {json.dumps(resolution)},
  {ref_arg}
  download: true,
  filename: {json.dumps(os.path.basename(output_file))},
  outputDir: {json.dumps(DOWNLOAD_DIR)},
  fetchMeta: true,
  fetchRecord: true,
  onProgress: (p, elapsed) => {{
    process.stdout.write(JSON.stringify({{ __type: 'progress', progress: p || 0, elapsed }}) + '\\n');
  }}
}};
let result;
let fallbackUsed = false;
try {{
  result = await client.generateImage(requestOptions);
}} catch (err) {{
  const message = err && err.message ? String(err.message) : String(err || '');
  if ({json.dumps(model)} === 'gpt-image2' && /GPT Image 2|generate_image_gpt_image2|Failed to generate image/i.test(message)) {{
    fallbackUsed = true;
    result = await client.generateImage({{ ...requestOptions, model: 'gpt4o' }});
  }} else {{
    throw err;
  }}
}}
const fs = require('fs');
fs.writeFileSync({json.dumps(account_file)}, JSON.stringify(client.toAccount(), null, 2), 'utf-8');
process.stdout.write(JSON.stringify({{
  success: true,
  taskId: result.taskId,
  cdnUrl: result.cdnUrl,
  downloadUrl: result.downloadUrl,
  outputUri: result.outputUri,
  localPath: result.localPath,
  fileSize: result.fileSize,
  submittedModel: fallbackUsed ? 'gpt4o' : result.submittedModel,
  submittedMcpMethodName: result.submittedMcpMethodName,
  submittedModelParam: result.submittedModelParam,
  fallbackUsed
}}));
"""
            def _on_progress(event: dict):
                progress = event.get("progress", 0)
                try:
                    progress = int(float(progress or 0))
                except (TypeError, ValueError):
                    progress = 0
                progress = max(0, min(99, progress))
                _task_cache[task_id].update({
                    "status": "running",
                    "progress": progress,
                    "elapsed": event.get("elapsed"),
                })

            result = _run_sdk_script_stream(script, timeout=900, on_event=_on_progress)
            if result.get("error"):
                error_message = _friendly_image_error(result.get("error"), model)
                _task_cache[task_id] = {
                    "status": "failed",
                    "progress": 0,
                    "video_url": "",
                    "error": error_message,
                    "submitted_model": model,
                    "media_type": "image",
                }
            else:
                _task_cache[task_id] = {
                    "status": "completed",
                    "progress": 100,
                    "video_url": result.get("localPath") or result.get("downloadUrl") or result.get("cdnUrl") or "",
                    "local_path": result.get("localPath") or "",
                    "file_size": result.get("fileSize"),
                    "cdn_url": result.get("cdnUrl") or "",
                    "download_url": result.get("downloadUrl") or "",
                    "output_uri": result.get("outputUri") or "",
                    "submitted_model": result.get("submittedModel") or model,
                    "submitted_mcp_method_name": result.get("submittedMcpMethodName") or "",
                    "submitted_model_param": result.get("submittedModelParam") or "",
                    "fallback_used": bool(result.get("fallbackUsed")),
                    "media_type": "image",
                    "error": "",
                }
        except Exception as e:
            _task_cache[task_id] = {
                "status": "failed",
                "progress": 0,
                "video_url": "",
                "error": _friendly_image_error(str(e), model),
                "media_type": "image",
            }
        finally:
            _cleanup_temp_files(temp_refs)

    _task_cache[task_id]["status"] = "running"
    t = threading.Thread(target=_run, daemon=True)
    t.start()

    return {"task_id": task_id, "status": "pending"}


def get_task_status(task_id: str) -> dict:
    """查询任务状态"""
    if task_id in _task_cache:
        return _task_cache[task_id]
    return {"status": "not_found", "video_url": "", "error": "任务不存在"}


def import_account(email: str, password: str, token: str = "") -> dict:
    """手动导入已有账号"""
    email = _clean_str(email)
    password = _clean_str(password)
    token = _clean_str(token)
    if not email:
        raise OiiOiiError("邮箱不能为空")
    account_file = _account_file_path(email)
    acc_data = {
        "email": email,
        "password": password,
        "token": token,
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    Path(ACCOUNT_DIR).mkdir(parents=True, exist_ok=True)
    with open(account_file, "w", encoding="utf-8") as f:
        json.dump(acc_data, f, ensure_ascii=False, indent=2)
    return {"success": True, "email": email, "account_file": account_file}


def delete_account(email: str) -> dict:
    """删除本地账号文件"""
    account_file = _account_file_path(email)
    if os.path.isfile(account_file):
        os.remove(account_file)
        return {"success": True, "deleted": account_file}
    return {"success": False, "error": "账号文件不存在"}


def test_connection() -> dict:
    """测试 SDK 可用性 + 代理连通性"""
    try:
        sdk_dir = _get_sdk_dir()
    except OiiOiiError as e:
        return {"ok": False, "error": str(e)}

    script = """
const { OiiOiiClient } = require('./oiioii_sdk');
process.stdout.write(JSON.stringify({
  ok: true,
  models: OiiOiiClient.listModels(),
  message: 'SDK 加载成功'
}));
"""
    try:
        result = _run_sdk_script(script, timeout=15)
        return result
    except OiiOiiError as e:
        return {"ok": False, "error": str(e)}
