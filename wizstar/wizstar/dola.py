"""Dola 渠道六桥接模块。

把 `dola-video-standalone` 作为本地 Node 执行器接入主后端：
- 采集账号：打开/复用 Chrome 登录态，写入 .env.dola
- 账号状态：读取 .env.dola，返回脱敏字段
- 视频生成：后台执行 Dola 生成脚本，写入本地任务缓存
- 手动采集：用已有 conversation_id 再次轮询取回视频，避免前一次轮询没扫到
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .app_paths import get_wizstar_data_dir


DEFAULT_MODELS = [
    {"id": "seedance-2.0", "name": "Seedance 2.0"},
    {"id": "seedance-1.5", "name": "Seedance 1.5"},
    {"id": "seedance-lite", "name": "Seedance Lite"},
]

DEFAULT_RATIOS = [
    {"id": "16:9", "name": "横版 16:9"},
    {"id": "9:16", "name": "竖版 9:16"},
    {"id": "1:1", "name": "方形 1:1"},
]

CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "dola_config.json")
RUNTIME_DIR = os.path.join(get_wizstar_data_dir(), "dola")
DOWNLOAD_DIR = os.path.join(RUNTIME_DIR, "downloads")
_task_cache: dict[str, dict] = {}
_task_lock = threading.Lock()


class DolaError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _clean_str(value, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def _extract_first(pattern: str, text: str, default: str = "") -> str:
    match = re.search(pattern, text or "", re.MULTILINE)
    if not match:
        return default
    return _clean_str(match.group(1), default)


def _module_root() -> Path:
    return Path(__file__).resolve().parent


def _candidate_dirs() -> list[Path]:
    env_dir = os.environ.get("DOLA_STANDALONE_DIR", "").strip()
    candidates: list[Path] = []
    if env_dir:
        candidates.append(Path(env_dir))
    root = _module_root()
    candidates.extend([
        root.parent.parent / "dola-video-standalone",
        root.parent.parent.parent / "dola-video-standalone",
        Path(os.getcwd()) / "dola-video-standalone",
    ])
    return candidates


def get_runner_dir() -> str:
    for candidate in _candidate_dirs():
        if candidate.is_dir() and (candidate / "dola-video-gen.mjs").exists():
            return str(candidate)
    raise DolaError("找不到 dola-video-standalone 目录，请设置 DOLA_STANDALONE_DIR")


def _node_bin() -> str:
    return os.environ.get("DOLA_NODE_BIN") or os.environ.get("OIIOII_NODE_BIN") or "node"


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_config(proxy: str | None = None, env_file: str | None = None, profile_dir: str | None = None) -> dict:
    config = _load_config()
    if proxy is not None:
        config["proxy"] = _clean_str(proxy)
    if env_file is not None:
        config["env_file"] = _clean_str(env_file)
    if profile_dir is not None:
        config["profile_dir"] = _clean_str(profile_dir)
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


def use_account(account: dict | None) -> dict:
    """把账号库里的运行路径切到当前 Dola 执行配置。"""
    if not account:
        return _load_config()
    env_file = _clean_str(account.get("env_file"))
    profile_dir = _clean_str(account.get("profile_dir"))
    return save_config(env_file=env_file, profile_dir=profile_dir)


def _default_env_file() -> str:
    return os.path.join(get_runner_dir(), ".env.dola")


def _default_profile_dir() -> str:
    return os.path.join(RUNTIME_DIR, "profile")


def _find_chrome_debug_port_for_profile(profile_dir: str) -> int:
    profile = _clean_str(profile_dir)
    if not profile:
        return 0
    try:
        result = subprocess.run(
            ["ps", "-axo", "command"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
        )
    except Exception:
        return 0
    for line in (result.stdout or "").splitlines():
        if profile not in line or "--remote-debugging-port=" not in line:
            continue
        match = re.search(r"--remote-debugging-port=(\d+)", line)
        if match:
            return int(match.group(1))
    return 0


def _open_url_in_existing_chrome(profile_dir: str, url: str) -> bool:
    target_url = _clean_str(url)
    if not target_url:
        return False
    port = _find_chrome_debug_port_for_profile(profile_dir)
    if not port:
        return False
    encoded_url = urllib.parse.quote(target_url, safe="")
    endpoint = f"http://127.0.0.1:{port}/json/new?{encoded_url}"
    try:
        req = urllib.request.Request(endpoint, method="PUT")
        with urllib.request.urlopen(req, timeout=3) as response:
            return 200 <= int(response.status) < 300
    except Exception:
        return False


def env_file_path() -> str:
    return _load_config().get("env_file") or os.environ.get("DOLA_ENV_FILE") or _default_env_file()


def profile_dir_path() -> str:
    return _load_config().get("profile_dir") or os.environ.get("DOLA_PROFILE_DIR") or _default_profile_dir()


def _read_env_file(path: str) -> dict:
    values: dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                value = value.strip().strip('"').strip("'")
                values[key.strip()] = value
    except OSError:
        return {}
    return values


def _mask(value: str, head: int = 8, tail: int = 4) -> str:
    value = _clean_str(value)
    if not value:
        return ""
    if len(value) <= head + tail:
        return "***"
    return f"{value[:head]}...{value[-tail:]}"


def account_status(env_file_override: str = "", profile_dir_override: str = "") -> dict:
    env_file = _clean_str(env_file_override) or env_file_path()
    profile_dir = _clean_str(profile_dir_override) or profile_dir_path()
    values = _read_env_file(env_file)
    cookie = values.get("DOLA_COOKIE", "")
    required = ["DOLA_COOKIE", "DOLA_USER_AGENT", "DOLA_DEVICE_ID", "DOLA_WEB_ID", "DOLA_TEA_UUID", "DOLA_FP"]
    missing = [key for key in required if not values.get(key)]
    return {
        "configured": bool(values) and not missing,
        "env_file": env_file,
        "profile_dir": profile_dir,
        "runner_dir": get_runner_dir(),
        "has_cookie": bool(cookie),
        "cookie_masked": _mask(cookie, 18, 10),
        "user_agent": values.get("DOLA_USER_AGENT", ""),
        "device_id_masked": _mask(values.get("DOLA_DEVICE_ID", "")),
        "web_id_masked": _mask(values.get("DOLA_WEB_ID", "")),
        "fp_masked": _mask(values.get("DOLA_FP", "")),
        "missing": missing,
        "models": DEFAULT_MODELS,
        "ratios": DEFAULT_RATIOS,
    }


def _base_env(overrides: dict | None = None) -> dict:
    config = _load_config()
    env = {**os.environ}
    proxy = _clean_str(config.get("proxy") or os.environ.get("DOLA_PROXY"))
    if proxy:
        env["DOLA_PROXY"] = proxy
    if overrides:
        for key, value in overrides.items():
            if value is not None:
                env[key] = str(value)
    if getattr(sys, "frozen", False):
        env["ELECTRON_RUN_AS_NODE"] = "1"
    return env


def _account_env_overrides(env_file: str = "", profile_dir: str = "") -> dict:
    overrides: dict[str, str] = {}
    clean_env_file = _clean_str(env_file)
    clean_profile_dir = _clean_str(profile_dir)
    if clean_env_file:
        overrides["DOLA_ENV_FILE"] = clean_env_file
    if clean_profile_dir:
        overrides["DOLA_PROFILE_DIR"] = clean_profile_dir
    return overrides


def _sync_env_file_for_runner(env_file: str = "") -> None:
    source = Path(_clean_str(env_file) or env_file_path())
    target = Path(_default_env_file())
    if not source.exists():
        return
    try:
        if source.resolve() == target.resolve():
            return
    except OSError:
        pass
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")


def _run_node(args: list[str], timeout: int = 600, env_overrides: dict | None = None) -> subprocess.CompletedProcess[str]:
    runner_dir = get_runner_dir()
    _sync_env_file_for_runner((env_overrides or {}).get("DOLA_ENV_FILE", ""))
    try:
        return subprocess.run(
            [_node_bin(), *args],
            cwd=runner_dir,
            env=_base_env(env_overrides),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise DolaError(f"Dola 执行超时: {e}") from e
    except OSError as e:
        raise DolaError(f"无法启动 Dola 执行器: {e}") from e


def _run_node_streaming(
    args: list[str],
    timeout: int = 600,
    on_output=None,
    env_overrides: dict | None = None,
) -> subprocess.CompletedProcess[str]:
    import queue

    runner_dir = get_runner_dir()
    _sync_env_file_for_runner((env_overrides or {}).get("DOLA_ENV_FILE", ""))
    started_at = time.time()
    output_parts: list[str] = []
    try:
        process = subprocess.Popen(
            [_node_bin(), *args],
            cwd=runner_dir,
            env=_base_env(env_overrides),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as e:
        raise DolaError(f"无法启动 Dola 执行器: {e}") from e

    line_queue: queue.Queue[str | None] = queue.Queue()

    def _reader() -> None:
        try:
            assert process.stdout is not None
            for line in process.stdout:
                line_queue.put(line)
        finally:
            line_queue.put(None)

    threading.Thread(target=_reader, daemon=True).start()

    stream_closed = False
    while True:
        if timeout and time.time() - started_at > timeout:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            raise DolaError(f"Dola 执行超时: timeout={timeout}s")

        try:
            line = line_queue.get(timeout=0.2)
        except queue.Empty:
            line = None

        if line:
            output_parts.append(line)
            if on_output:
                on_output("".join(output_parts))
            continue

        if line is None and process.poll() is not None:
            stream_closed = True
            break

        if stream_closed and process.poll() is not None:
            break

    return subprocess.CompletedProcess(
        args=[_node_bin(), *args],
        returncode=int(process.returncode or 0),
        stdout="".join(output_parts),
        stderr="",
    )


def grab_account(
    visible: bool = True,
    keep_open: bool = False,
    wait_ms: int = 8000,
    proxy: str = "",
    send_hi: bool = False,
    hi_text: str = "你好",
    close_login: bool = False,
    env_file: str = "",
    profile_dir: str = "",
) -> dict:
    if proxy:
        save_config(proxy=proxy)
    explicit_env_file = _clean_str(env_file)
    explicit_profile_dir = _clean_str(profile_dir)
    if not explicit_env_file and not explicit_profile_dir:
        env_file = env_file_path()
        profile_dir = profile_dir_path()
    else:
        env_file = explicit_env_file or env_file_path()
        profile_dir = explicit_profile_dir or profile_dir_path()
    args = ["grab-account.mjs", "--out", env_file, "--profile", profile_dir, "--wait-ms", str(int(wait_ms or 8000))]
    args.append("--visible" if visible else "--headless")
    if keep_open:
        args.append("--keep-open")
    if send_hi:
        args.append("--send-hi")
    if hi_text and hi_text != "你好":
        args.extend(["--hi-text", hi_text])
    if close_login:
        args.append("--close-login")
    if proxy:
        args.extend(["--proxy", proxy])
    result = _run_node(args, timeout=180)
    output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    if result.returncode != 0:
        raise DolaError(output.strip() or "Dola 账号采集失败")
    return {"ok": True, "output": output.strip(), "account": account_status(env_file, profile_dir)}


def open_account_browser(
    profile_dir: str = "",
    env_file: str = "",
    wait_ms: int = 8000,
    proxy: str = "",
    url: str = "",
) -> dict:
    if env_file or profile_dir:
        save_config(env_file=env_file or None, profile_dir=profile_dir or None)
    if proxy:
        save_config(proxy=proxy)

    runner_dir = get_runner_dir()
    current_env_file = env_file_path()
    current_profile_dir = profile_dir_path()
    _sync_env_file_for_runner(current_env_file)
    target_url = _clean_str(url)
    if target_url and _open_url_in_existing_chrome(current_profile_dir, target_url):
        return {
            "ok": True,
            "pid": 0,
            "env_file": current_env_file,
            "profile_dir": current_profile_dir,
            "url": target_url,
            "reused": True,
        }
    args = [
        "grab-account.mjs",
        "--out", current_env_file,
        "--profile", current_profile_dir,
        "--wait-ms", str(int(wait_ms or 8000)),
        "--visible",
        "--keep-open",
    ]
    if proxy:
        args.extend(["--proxy", proxy])
    if target_url:
        args.extend(["--url", target_url])
    try:
        process = subprocess.Popen(
            [_node_bin(), *args],
            cwd=runner_dir,
            env=_base_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as e:
        raise DolaError(f"无法打开 Dola 浏览器: {e}") from e
    return {
        "ok": True,
        "pid": process.pid,
        "env_file": current_env_file,
        "profile_dir": current_profile_dir,
        "url": target_url,
    }


def _parse_generation_output(output: str) -> dict:
    conversation_id = (
        _extract_first(r"ACK:\s*conv=([A-Za-z0-9_\-]+)", output)
        or _extract_first(r"conversationId:\s*([A-Za-z0-9_\-]+)", output)
        or _extract_first(r"conversation_id[:=]\s*([A-Za-z0-9_\-]+)", output)
        or _extract_first(r"conversation_id=([A-Za-z0-9_\-]+)", output)
    )
    video_url = (
        _extract_first(r"videoUrl:\s*(https?://\S+)", output)
        or _extract_first(r"downloadUrl:\s*(https?://\S+)", output)
        or _extract_first(r"视频URL[^:：]*[:：]\s*(https?://\S+)", output)
    )
    saved_path = _extract_first(r"保存到:\s*(.+?)(?:\s*\(|\n|$)", output)
    if not saved_path:
        saved_path = _extract_first(r"保存到:\s*(.+)$", output)
    return {
        "conversation_id": conversation_id,
        "video_url": video_url,
        "local_path": saved_path,
    }


def _set_task(cache_key: str, **updates) -> dict:
    with _task_lock:
        current = _task_cache.get(cache_key, {})
        current.update(updates)
        current["updated_at"] = time.time()
        _task_cache[cache_key] = current
        return dict(current)


def _get_task(cache_key: str) -> dict:
    with _task_lock:
        return dict(_task_cache.get(cache_key, {}))


def create_video(
    prompt: str = "",
    image_path: str = "",
    image_url: str = "",
    reference_images: list[str] | None = None,
    model: str = "seedance-2.0",
    ratio: str = "16:9",
    duration: int = 5,
    account: dict | None = None,
) -> dict:
    account_env_file = _clean_str(account.get("env_file") if account else "")
    account_profile_dir = _clean_str(account.get("profile_dir") if account else "")
    status = account_status(account_env_file, account_profile_dir)
    if not status.get("configured"):
        raise DolaError("Dola 采集账号未配置完整，请先点击采集账号")
    prompt = _clean_str(prompt, "生成一段视频")
    model = _clean_str(model, "seedance-2.0")
    ratio = _clean_str(ratio, "16:9")
    try:
        requested_duration = int(duration or 5)
    except (TypeError, ValueError):
        requested_duration = 5
    duration = min(15, max(5, ((requested_duration + 4) // 5) * 5))
    refs = [x for x in (reference_images or []) if _clean_str(x)]
    if image_path:
        refs.insert(0, image_path)
    elif image_url:
        refs.insert(0, image_url)

    task_id = f"dola-{uuid.uuid4().hex[:12]}"
    Path(DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)
    _set_task(
        task_id,
        task_id=task_id,
        status="pending",
        progress=0,
        prompt=prompt,
        model=model,
        ratio=ratio,
        duration=duration,
        media_type="video",
        video_url="",
        local_path="",
        conversation_id="",
        error="",
        output="",
        created_at=time.time(),
    )

    env_overrides = _account_env_overrides(account_env_file, account_profile_dir)

    def _run() -> None:
        try:
            _set_task(task_id, status="processing", progress=5)
            args = ["dola-video-gen.mjs"]
            if refs:
                args.extend(["image", ",".join(refs), prompt, ratio, str(duration), model])
            else:
                args.extend(["text", prompt, ratio, str(duration), model])

            def _on_output(output: str) -> None:
                parsed = _parse_generation_output(output)
                progress = 8
                if "[1/3] 上传图片" in output:
                    progress = 15
                if "预热账号会话" in output:
                    progress = 40
                if "发送视频生成请求" in output:
                    progress = 45
                if "HTTP status:" in output:
                    progress = 55
                if "ACK: conv=" in output or parsed.get("conversation_id"):
                    progress = 65
                if "轮询 /im/chain/single" in output or "polling" in output:
                    progress = 75
                if parsed.get("video_url"):
                    progress = 95
                _set_task(
                    task_id,
                    output=output[-8000:],
                    conversation_id=parsed.get("conversation_id", ""),
                    video_url=parsed.get("video_url", ""),
                    local_path=parsed.get("local_path", ""),
                    progress=progress,
                )

            result = _run_node_streaming(args, timeout=900, on_output=_on_output, env_overrides=env_overrides)
            output = result.stdout or ""
            parsed = _parse_generation_output(output)
            updates = {
                "output": output[-8000:],
                "conversation_id": parsed.get("conversation_id", ""),
                "video_url": parsed.get("video_url", ""),
                "local_path": parsed.get("local_path", ""),
                "progress": 100 if result.returncode == 0 else 50,
            }
            if result.returncode == 0:
                _set_task(task_id, status="completed", **updates)
            else:
                # 如果已经拿到 conversation_id，保留为可手动采集状态。
                next_status = "collectable" if parsed.get("conversation_id") else "failed"
                _set_task(task_id, status=next_status, error=(output.strip() or "Dola 生成失败")[-1200:], **updates)
        except Exception as e:  # noqa: BLE001
            _set_task(task_id, status="failed", error=str(e), progress=0)

    threading.Thread(target=_run, daemon=True).start()
    return _get_task(task_id)


def collect_task(task_id: str = "", conversation_id: str = "", account: dict | None = None) -> dict:
    task = _get_task(task_id) if task_id else {}
    conv = _clean_str(conversation_id) or _clean_str(task.get("conversation_id"))
    if not conv:
        raise DolaError("缺少 conversation_id，无法采集")
    account_env_file = _clean_str(account.get("env_file") if account else "")
    account_profile_dir = _clean_str(account.get("profile_dir") if account else "")
    env_overrides = _account_env_overrides(account_env_file, account_profile_dir)
    task_id = task_id or f"dola-collect-{uuid.uuid4().hex[:12]}"
    task = _get_task(task_id)
    if not task:
        _set_task(
            task_id,
            task_id=task_id,
            status="pending",
            progress=0,
            conversation_id=conv,
            model="dola-collect",
            prompt="",
            video_url="",
            local_path="",
            error="",
            output="",
            created_at=time.time(),
        )

    def _run() -> None:
        try:
            _set_task(task_id, status="collecting", progress=20)
            result = _run_node(["dola-video-gen.mjs", "poll", conv], timeout=420, env_overrides=env_overrides)
            output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
            parsed = _parse_generation_output(output)
            updates = {
                "output": output[-8000:],
                "conversation_id": conv,
                "video_url": parsed.get("video_url", ""),
                "local_path": parsed.get("local_path", ""),
                "progress": 100 if result.returncode == 0 else 50,
            }
            if result.returncode == 0:
                _set_task(task_id, status="completed", **updates)
            else:
                _set_task(task_id, status="collectable", error=(output.strip() or "本次采集未拿到视频")[-1200:], **updates)
        except Exception as e:  # noqa: BLE001
            _set_task(task_id, status="collectable", error=str(e))

    threading.Thread(target=_run, daemon=True).start()
    return _get_task(task_id)


def get_task_status(task_id: str) -> dict:
    task = _get_task(task_id)
    if not task:
        raise DolaError("task not found", status_code=404)
    return task


def list_tasks(limit: int = 100) -> list[dict]:
    with _task_lock:
        rows = list(_task_cache.values())
    rows.sort(key=lambda x: float(x.get("created_at") or 0), reverse=True)
    return [dict(row) for row in rows[:limit]]