"""Dola 渠道六桥接模块。

当前主链路：
- 生成：打开浏览器会话，在 Dola 页面完成上传图片、切换视频、点击生成
- 查询：记录本次提交的会话信息，后续按 conversation_id 采集结果
- 账号采集：仅保留为历史兼容，不再作为生成前置条件
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .app_paths import get_wizstar_data_dir
from .database import TaskDB, DolaAccountDB


DEFAULT_MODELS = [
    {"id": "seedance-2.0", "name": "Seedance 2.0"},
    {"id": "seedance-1.5", "name": "Seedance 1.5"},
    {"id": "seedance-lite", "name": "Seedance Lite"},
]

DEFAULT_RATIOS = [
    {"id": "16:9", "name": "横版 16:9"},
    {"id": "9:16", "name": "竖版 9:16"},
    {"id": "1:1", "name": "方形 1:1"},
    {"id": "4:3", "name": "标准 4:3"},
    {"id": "3:4", "name": "竖版 3:4"},
    {"id": "21:9", "name": "超宽 21:9"},
]

DEFAULT_SEND_MODE = "browser"
SEND_MODE_BROWSER = "browser"
SEND_MODE_API = "api"
SEND_MODE_OPTIONS = [
    {"id": SEND_MODE_BROWSER, "label": "浏览器发送"},
    {"id": SEND_MODE_API, "label": "API发送"},
]

CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "dola_config.json")
RUNTIME_DIR = os.path.join(get_wizstar_data_dir(), "dola")
DOWNLOAD_DIR = os.path.join(RUNTIME_DIR, "downloads")
TASK_CACHE_PATH = os.path.join(RUNTIME_DIR, "task_cache.json")
TASK_PROFILE_DIR = os.path.join(RUNTIME_DIR, "task_profiles")
_task_cache: dict[str, dict] = {}
_task_lock = threading.Lock()
_active_collect_tasks: set[str] = set()
_account_collect_locks: dict[int, threading.Lock] = {}
_account_collect_locks_guard = threading.Lock()


def _get_account_collect_lock(account_id: int) -> threading.Lock:
    with _account_collect_locks_guard:
        if account_id not in _account_collect_locks:
            _account_collect_locks[account_id] = threading.Lock()
        return _account_collect_locks[account_id]


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


def _extract_last(pattern: str, text: str, default: str = "") -> str:
    matches = re.findall(pattern, text or "", re.MULTILINE)
    if not matches:
        return default
    value = matches[-1]
    if isinstance(value, tuple):
        value = next((item for item in value if item), "")
    return _clean_str(value, default)


def _format_dola_error_message(message: str, code: str = "") -> str:
    clean_message = _compact_log_text(message)
    clean_code = _compact_log_text(code)
    if clean_message and clean_code:
        return f"{clean_message} (code={clean_code})"
    return clean_message or (f"Dola 生成失败 (code={clean_code})" if clean_code else "")


def _extract_dola_error_message(text: str) -> str:
    source = text or ""
    for item in reversed(_extract_json_objects(source)):
        if not isinstance(item, dict):
            continue
        message = _clean_str(item.get("error_msg") or item.get("message") or item.get("status_msg"))
        code = _clean_str(item.get("error_code") or item.get("code") or item.get("status_code"))
        if message or code:
            return _format_dola_error_message(message, code)
    message = _extract_last(r'"error_msg"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"', source)
    code = _extract_last(r'"error_code"\s*:\s*("?[^,"}\s]+"?)', source).strip('"')
    if message or code:
        try:
            message = json.loads(f'"{message}"') if message else ""
        except Exception:
            pass
        return _format_dola_error_message(message, code)
    return ""


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


def _normalize_send_mode(value: str | None) -> str:
    mode = _clean_str(value).lower()
    if mode in (SEND_MODE_BROWSER, SEND_MODE_API):
        return mode
    return DEFAULT_SEND_MODE


def save_config(proxy: str | None = None, env_file: str | None = None, profile_dir: str | None = None, send_mode: str | None = None) -> dict:
    config = _load_config()
    if proxy is not None:
        config["proxy"] = _clean_str(proxy)
    if env_file is not None:
        config["env_file"] = _clean_str(env_file)
    if profile_dir is not None:
        config["profile_dir"] = _clean_str(profile_dir)
    if send_mode is not None:
        config["send_mode"] = _normalize_send_mode(send_mode)
    elif "send_mode" not in config:
        config["send_mode"] = DEFAULT_SEND_MODE
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


def get_send_mode() -> str:
    config = _load_config()
    env_mode = _normalize_send_mode(os.environ.get("DOLA_SEND_MODE"))
    return _normalize_send_mode(config.get("send_mode") or env_mode)


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


def _open_url_in_chrome_port(port: int, url: str) -> bool:
    target_url = _clean_str(url)
    try:
        debug_port = int(port or 0)
    except (TypeError, ValueError):
        debug_port = 0
    if not target_url or not debug_port:
        return False
    encoded_url = urllib.parse.quote(target_url, safe="")
    endpoint = f"http://127.0.0.1:{debug_port}/json/new?{encoded_url}"
    try:
        req = urllib.request.Request(endpoint, method="PUT")
        with urllib.request.urlopen(req, timeout=3) as response:
            return 200 <= int(response.status) < 300
    except Exception:
        return False


def _is_chrome_debug_port_ready(port: int) -> bool:
    try:
        debug_port = int(port or 0)
    except (TypeError, ValueError):
        debug_port = 0
    if not debug_port:
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/version", timeout=1) as response:
            return 200 <= int(response.status) < 300
    except Exception:
        return False


def _wait_chrome_debug_port(port: int, timeout: float = 12.0) -> bool:
    deadline = time.time() + max(0.5, float(timeout or 0))
    while time.time() < deadline:
        if _is_chrome_debug_port_ready(port):
            return True
        time.sleep(0.4)
    return False


def _open_url_in_existing_chrome(profile_dir: str, url: str) -> bool:
    port = _find_chrome_debug_port_for_profile(profile_dir)
    return _open_url_in_chrome_port(port, url)


def _kill_browser_pid(pid: int) -> bool:
    try:
        target_pid = int(pid or 0)
    except (TypeError, ValueError):
        target_pid = 0
    if target_pid <= 0:
        return False
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(target_pid), "/T", "/F"],
                capture_output=True,
                timeout=8,
            )
            return True
        # Collect child PIDs before killing the parent
        child_pids: list[int] = []
        try:
            ps_out = subprocess.run(
                ["pgrep", "-P", str(target_pid)],
                capture_output=True,
                text=True,
                timeout=5,
            )
            child_pids = [int(x) for x in ps_out.stdout.split() if x.strip().isdigit()]
        except Exception:
            pass
        os.kill(target_pid, signal.SIGTERM)
        for _ in range(20):
            time.sleep(0.2)
            try:
                os.kill(target_pid, 0)
            except OSError:
                break
        else:
            try:
                os.kill(target_pid, signal.SIGKILL)
            except OSError:
                pass
        # Kill any surviving child processes
        for cpid in child_pids:
            try:
                os.kill(cpid, signal.SIGTERM)
            except OSError:
                pass
        return True
    except (OSError, ProcessLookupError):
        return True
    except Exception:
        return False


def _close_task_browser(task_id: str) -> bool:
    """采集成功后关闭该任务对应的浏览器会话。"""
    task = _get_task(_clean_str(task_id))
    if not task:
        return False
    try:
        browser_pid = int(task.get("browser_pid") or 0)
    except (TypeError, ValueError):
        browser_pid = 0
    closed = _kill_browser_pid(browser_pid) if browser_pid else False
    if browser_pid or task.get("browser_port"):
        _set_task(
            _clean_str(task_id),
            browser_port=0,
            browser_pid=0,
        )
    return closed


def env_file_path() -> str:
    return _load_config().get("env_file") or os.environ.get("DOLA_ENV_FILE") or _default_env_file()


def profile_dir_path() -> str:
    return _load_config().get("profile_dir") or os.environ.get("DOLA_PROFILE_DIR") or _default_profile_dir()


def read_env_cookie(env_file: str) -> str:
    """Read DOLA_COOKIE from an existing .env.dola file."""
    values = _read_env_file(env_file)
    return _clean_str(values.get("DOLA_COOKIE", ""))


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


def _cookie_value(cookie: str, name: str) -> str:
    match = re.search(rf"(?:^|;\s*){re.escape(name)}=([^;]+)", cookie or "")
    return match.group(1) if match else ""


def _generate_tea_id() -> str:
    ms = int(time.time() * 1000) & ((1 << 41) - 1)
    rand = int.from_bytes(os.urandom(4), "big") % (1 << 22)
    return str((ms << 22) | rand)


def _generate_ms_token() -> str:
    return base64.b64encode(os.urandom(78)).decode("ascii").replace("+", "-").replace("/", "_") + "=="


def _normalize_env_value(value: str) -> str:
    return _clean_str(value).replace("\r", " ").replace("\n", " ")


def _upsert_env_value(content: str, key: str, value: str) -> str:
    clean_value = _normalize_env_value(value)
    if not clean_value:
        return content
    line = f"{key}={clean_value}"
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(content):
        return pattern.sub(line, content)
    prefix = "\n" if content and not content.endswith("\n") else ""
    return f"{content}{prefix}{line}\n"


def write_env_from_cookie(cookie: str, env_file: str = "", profile_dir: str = "") -> dict:
    cookie = _normalize_env_value(cookie)
    if not cookie:
        raise DolaError("请填写 Dola Cookie", status_code=400)
    if "=" not in cookie:
        raise DolaError("Cookie 格式不正确，请粘贴完整的 name=value; name2=value2 串", status_code=400)

    base_dir = os.path.join(RUNTIME_DIR, "accounts", f"manual-{uuid.uuid4().hex[:10]}")
    env_path = _clean_str(env_file) or os.path.join(base_dir, ".env.dola")
    profile_path = _clean_str(profile_dir) or os.path.join(base_dir, "profile")
    device_id = _generate_tea_id()
    fp = _cookie_value(cookie, "s_v_web_id") or device_id
    values = {
        "DOLA_COOKIE": cookie,
        "DOLA_USER_AGENT": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "DOLA_DEVICE_ID": device_id,
        "DOLA_WEB_ID": device_id,
        "DOLA_TEA_UUID": device_id,
        "DOLA_WEB_TAB_ID": str(uuid.uuid4()),
        "DOLA_AID": "495671",
        "DOLA_VERSION_CODE": "20800",
        "DOLA_PC_VERSION": "3.23.5",
        "DOLA_FP": fp,
        "DOLA_MS_TOKEN": _cookie_value(cookie, "msToken") or _generate_ms_token(),
    }

    env_target = Path(env_path)
    env_target.parent.mkdir(parents=True, exist_ok=True)
    Path(profile_path).mkdir(parents=True, exist_ok=True)
    try:
        content = env_target.read_text(encoding="utf-8") if env_target.exists() else ""
    except OSError:
        content = ""
    for key, value in values.items():
        content = _upsert_env_value(content, key, value)
    env_target.write_text(content, encoding="utf-8")
    return account_status(env_file_override=str(env_target), profile_dir_override=profile_path)


def account_status(env_file_override: str = "", profile_dir_override: str = "") -> dict:
    env_file = _clean_str(env_file_override) or env_file_path()
    profile_dir = _clean_str(profile_dir_override) or profile_dir_path()
    values = _read_env_file(env_file)
    cookie = values.get("DOLA_COOKIE", "")
    required = ["DOLA_COOKIE", "DOLA_USER_AGENT", "DOLA_DEVICE_ID", "DOLA_WEB_ID", "DOLA_TEA_UUID", "DOLA_WEB_TAB_ID", "DOLA_FP", "DOLA_MS_TOKEN"]
    missing = [key for key in required if not values.get(key)]
    send_mode = get_send_mode()
    configured = not missing
    return {
        "configured": configured,
        "browser_session_required": True,
        "account_grab_required": False,
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
        "send_mode": send_mode,
        "send_mode_options": SEND_MODE_OPTIONS,
        "send_mode_label": next((item["label"] for item in SEND_MODE_OPTIONS if item["id"] == send_mode), send_mode),
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
    env_overrides = env_overrides or {}
    _sync_env_file_for_runner(env_overrides.get("DOLA_ENV_FILE", ""))
    import datetime
    log_path = os.path.join(runner_dir, f"run_node_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}_{os.getpid()}.log")
    log_lines: list[str] = []
    log_lines.append(f"[{datetime.datetime.now().isoformat()}] CMD: {_node_bin()} {' '.join(args)}")
    log_lines.append(f"[{datetime.datetime.now().isoformat()}] CWD: {runner_dir}")
    log_lines.append(f"[{datetime.datetime.now().isoformat()}] ENV: task_id={env_overrides.get('DOLA_TASK_ID', 'N/A')}")
    try:
        proc = subprocess.Popen(
            [_node_bin(), *args],
            cwd=runner_dir,
            env=_base_env(env_overrides),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        stdout, stderr = proc.communicate(timeout=timeout)
        log_lines.append(f"[{datetime.datetime.now().isoformat()}] EXIT: {proc.returncode}")
        log_lines.append(f"[{datetime.datetime.now().isoformat()}] STDOUT ({len(stdout)} bytes):")
        log_lines.append(stdout)
        log_lines.append(f"[{datetime.datetime.now().isoformat()}] STDERR ({len(stderr)} bytes):")
        log_lines.append(stderr)
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("\n".join(log_lines))
        result = subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)
        return result
    except subprocess.TimeoutExpired as e:
        proc.kill()
        stdout, stderr = proc.communicate()
        log_lines.append(f"[{datetime.datetime.now().isoformat()}] TIMEOUT after {timeout}s")
        log_lines.append(f"[{datetime.datetime.now().isoformat()}] STDOUT ({len(stdout)} bytes):")
        log_lines.append(stdout)
        log_lines.append(f"[{datetime.datetime.now().isoformat()}] STDERR ({len(stderr)} bytes):")
        log_lines.append(stderr)
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("\n".join(log_lines))
        return subprocess.CompletedProcess(
            args=[_node_bin(), *args],
            returncode=124,
            stdout=stdout,
            stderr=f"Dola 执行超时: {e}\n{stderr}",
        )
    except OSError as e:
        log_lines.append(f"[{datetime.datetime.now().isoformat()}] OSError: {e}")
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("\n".join(log_lines))
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

    line_queue: queue.Queue[str | object] = queue.Queue()
    done_marker = object()

    def _reader() -> None:
        try:
            assert process.stdout is not None
            for line in process.stdout:
                line_queue.put(line)
        finally:
            line_queue.put(done_marker)

    threading.Thread(target=_reader, daemon=True).start()

    while True:
        if timeout and time.time() - started_at > timeout:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            while True:
                try:
                    item = line_queue.get_nowait()
                except queue.Empty:
                    break
                if item is done_marker:
                    continue
                line = str(item)
                if line:
                    output_parts.append(line)
            output = "".join(output_parts)
            if on_output and output:
                on_output(output)
            return subprocess.CompletedProcess(
                args=[_node_bin(), *args],
                returncode=124,
                stdout=output,
                stderr=f"Dola 执行超时: timeout={timeout}s",
            )

        try:
            item = line_queue.get(timeout=0.2)
        except queue.Empty:
            continue

        if item is done_marker:
            break

        line = str(item)
        if line:
            output_parts.append(line)
            if on_output:
                on_output("".join(output_parts))

    process.wait(timeout=5)

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
    send_hi: bool = True,
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
    persistent: bool = False,
) -> dict:
    if proxy:
        save_config(proxy=proxy)

    runner_dir = get_runner_dir()
    current_env_file = _clean_str(env_file) or env_file_path()
    current_profile_dir = _clean_str(profile_dir) or profile_dir_path()
    target_url = _clean_str(url)
    has_env_cookie = bool(read_env_cookie(current_env_file))
    # persistent=True 时强制使用持久化 profile（不 incognito），
    # 避免 temp profile + cookie 注入不稳定导致会话丢失。
    use_temp_profile = has_env_cookie and not persistent
    launch_port = 22000 + (int.from_bytes(os.urandom(2), "big") % 5000)
    if target_url and not use_temp_profile and _open_url_in_existing_chrome(current_profile_dir, target_url):
        return {
            "ok": True,
            "pid": 0,
            "env_file": current_env_file,
            "profile_dir": current_profile_dir,
            "port": _find_chrome_debug_port_for_profile(current_profile_dir),
            "url": target_url,
            "reused": True,
        }
    args = [
        "browser-send-test.mjs",
        "--visible",
        "--keep-open",
        "--open-only",
        "--temp-profile" if use_temp_profile else "--persistent-profile",
        "--profile", current_profile_dir,
        "--port", str(launch_port),
        "--wait-ms", str(int(wait_ms or 8000)),
    ]
    if proxy:
        args.extend(["--proxy", proxy])
    if current_env_file:
        args.extend(["--out", current_env_file])
    if target_url:
        args.extend(["--url", target_url])
    try:
        # start_new_session=True 让 Node 进程脱离父进程会话组，
        # 避免 FastAPI server 收到信号或重启时把 Node 和它启动的 Chrome 一起带走，
        # 这也是"浏览器打开立马关闭"的主要根因。
        popen_kwargs = {
            "cwd": runner_dir,
            "env": _base_env(),
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "stdin": subprocess.DEVNULL,
            "close_fds": True,
            "start_new_session": True,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        process = subprocess.Popen(
            [_node_bin(), *args],
            **popen_kwargs,
        )
    except OSError as e:
        raise DolaError(f"无法打开 Dola 浏览器: {e}") from e
    # 给 Node + Chrome 一点初始化时间，再返回 pid 给前端。
    # 不能在这里 wait Node 进程（Node 会一直挂着等 Chrome），只等端口就绪即可。
    deadline = time.time() + min(20.0, max(2.0, float(wait_ms or 8000) / 1000.0 + 2.0))
    ready_port = 0
    while time.time() < deadline:
        if _is_chrome_debug_port_ready(launch_port):
            ready_port = launch_port
            break
        time.sleep(0.3)
    return {
        "ok": True,
        "pid": process.pid,
        "env_file": current_env_file,
        "profile_dir": current_profile_dir,
        "port": ready_port or launch_port,
        "url": target_url,
        "chrome_ready": bool(ready_port),
    }


def open_task_browser(task_id: str, url: str = "", wait_ms: int = 8000, proxy: str = "", fallback_account: bool = True) -> dict:
    task = _get_task(_clean_str(task_id))
    if not task:
        raise DolaError("task not found", status_code=404)
    target_url = _clean_str(url) or _clean_str(task.get("page_url"))
    conversation_id = _clean_str(task.get("conversation_id"))
    if not target_url and conversation_id:
        target_url = f"https://www.dola.com/chat/{conversation_id}"

    try:
        browser_port = int(task.get("browser_port") or 0)
    except (TypeError, ValueError):
        browser_port = 0
    try:
        browser_pid = int(task.get("browser_pid") or 0)
    except (TypeError, ValueError):
        browser_pid = 0
    if browser_port and _open_url_in_chrome_port(browser_port, target_url or "https://www.dola.com/chat/create-image"):
        _set_task(
            _clean_str(task_id),
            browser_port=browser_port,
            browser_pid=browser_pid,
            browser_profile_dir=_clean_str(task.get("browser_profile_dir")),
            browser_base_profile_dir=_clean_str(task.get("browser_base_profile_dir")),
        )
        return {
            "ok": True,
            "pid": browser_pid,
            "profile_dir": _clean_str(task.get("browser_profile_dir")),
            "base_profile_dir": _clean_str(task.get("browser_base_profile_dir")),
            "port": browser_port,
            "url": target_url,
            "reused": True,
            "task_session": True,
            "temp_profile": bool(task.get("browser_temp_profile")),
        }

    browser_profile_dir = _clean_str(task.get("browser_profile_dir"))
    if browser_profile_dir and _open_url_in_existing_chrome(browser_profile_dir, target_url or "https://www.dola.com/chat/create-image"):
        restored_port = _find_chrome_debug_port_for_profile(browser_profile_dir)
        _set_task(
            _clean_str(task_id),
            browser_profile_dir=browser_profile_dir,
            browser_base_profile_dir=_clean_str(task.get("browser_base_profile_dir")),
            browser_port=restored_port or 0,
            browser_pid=browser_pid,
        )
        return {
            "ok": True,
            "pid": browser_pid,
            "profile_dir": browser_profile_dir,
            "base_profile_dir": _clean_str(task.get("browser_base_profile_dir")),
            "port": restored_port,
            "url": target_url,
            "reused": True,
            "task_session": True,
            "temp_profile": bool(task.get("browser_temp_profile")),
        }

    if not fallback_account:
        if browser_profile_dir and os.path.isdir(browser_profile_dir):
            result = open_account_browser(
                profile_dir=browser_profile_dir,
                wait_ms=wait_ms,
                proxy=proxy,
                url=target_url or "https://www.dola.com/chat/create-image",
                persistent=True,
            )
            result["task_session"] = True
            result["task_session_restored"] = True
            result["temp_profile"] = False
            result["profile_dir"] = browser_profile_dir
            result["base_profile_dir"] = _clean_str(task.get("browser_base_profile_dir")) or browser_profile_dir
            restored_port = _find_chrome_debug_port_for_profile(browser_profile_dir)
            if restored_port:
                result["port"] = restored_port
            _set_task(
                _clean_str(task_id),
                browser_profile_dir=browser_profile_dir,
                browser_base_profile_dir=result["base_profile_dir"],
                browser_temp_profile=False,
                browser_persistent_profile=True,
                browser_port=restored_port or 0,
                browser_pid=result.get("pid") or 0,
            )
            return result
        return {
            "ok": False,
            "url": target_url,
            "task_session": False,
            "task_session_missing_reason": "任务浏览器 profile 不存在，无法恢复该任务会话。",
        }

    result = open_account_browser(wait_ms=wait_ms, proxy=proxy, url=target_url)
    result["task_session"] = False
    result["task_session_missing_reason"] = "任务浏览器 profile 不存在，已回退普通账号窗口。"
    return result


def _task_id_by_conversation_id(conversation_id: str) -> str:
    conv = _clean_str(conversation_id)
    if not conv:
        return ""
    with _task_lock:
        for task_id, task in _task_cache.items():
            if _clean_str(task.get("conversation_id")) == conv:
                return task_id
    return ""


def remember_browser_session_for_conversation(
    conversation_id: str,
    browser_result: dict | None,
    account: dict | None = None,
) -> None:
    task_id = _task_id_by_conversation_id(conversation_id)
    if not task_id or not isinstance(browser_result, dict):
        return
    updates: dict = {}
    try:
        port = int(browser_result.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    try:
        pid = int(browser_result.get("pid") or 0)
    except (TypeError, ValueError):
        pid = 0
    if port:
        updates["browser_port"] = port
    if pid:
        updates["browser_pid"] = pid
    profile_dir = _clean_str(browser_result.get("profile_dir")) or _clean_str(account.get("profile_dir") if account else "")
    if profile_dir:
        updates["browser_profile_dir"] = profile_dir
    base_profile_dir = _clean_str(browser_result.get("base_profile_dir")) or profile_dir
    if base_profile_dir:
        updates["browser_base_profile_dir"] = base_profile_dir
    if browser_result.get("url"):
        updates["page_url"] = _clean_str(browser_result.get("url"))
    if account:
        updates["account_env_file"] = _clean_str(account.get("env_file")) or _clean_str(_get_task(task_id).get("account_env_file"))
        updates["account_profile_dir"] = _clean_str(account.get("profile_dir")) or _clean_str(_get_task(task_id).get("account_profile_dir"))
    if updates:
        _set_task(task_id, **updates)


def _extract_json_objects(output: str) -> list[dict]:
    decoder = json.JSONDecoder()
    items: list[dict] = []
    text = output or ""
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            items.append(value)
    return items


def _playable_video_path(path_value: str) -> str:
    raw = _clean_str(path_value)
    if not raw:
        return raw
    parsed = Path(raw)
    if parsed.stem.endswith(".playable"):
        source = parsed.with_name(f"{parsed.stem[:-9]}{parsed.suffix or '.mp4'}")
        if source.is_file():
            try:
                if not parsed.is_file() or parsed.stat().st_mtime < source.stat().st_mtime:
                    return str(source)
            except OSError:
                return str(source)
    if not os.path.isfile(raw):
        return raw
    playable = parsed.with_name(f"{parsed.stem}.playable{parsed.suffix or '.mp4'}")
    if playable.is_file() and playable.stat().st_size > 0:
        try:
            if playable.stat().st_mtime >= parsed.stat().st_mtime:
                return str(playable)
        except OSError:
            return raw
    return raw


def _parse_browser_submit_output(output: str) -> dict:
    summary: dict = {}
    for item in _extract_json_objects(output):
        if item.get("stage") == "browser-session":
            summary["browserSession"] = item
        if "conversationId" in item or "localConversationId" in item or "result" in item:
            summary = {**summary, **item}
    conversation_id = _clean_str(summary.get("conversationId"))
    local_conversation_id = _clean_str(summary.get("localConversationId"))
    result = summary.get("result") if isinstance(summary.get("result"), dict) else {}
    detail = result.get("detail") if isinstance(result.get("detail"), dict) else {}
    network = result.get("networkEvidence") if isinstance(result.get("networkEvidence"), dict) else {}
    browser_poll = result.get("browserPoll") if isinstance(result.get("browserPoll"), dict) else {}
    page_url = _clean_str(detail.get("location") or summary.get("url") or summary.get("pageUrl"))
    browser_session = summary.get("browserSession") if isinstance(summary.get("browserSession"), dict) else {}
    request_seen = bool(detail.get("requestSeen") or result.get("requestSeen") or network.get("requestSeen"))
    completion_count = int(network.get("completionCount") or 0)
    submit_ok = bool(result.get("ok")) or completion_count > 0 or request_seen
    if not conversation_id:
        conversation_id = _clean_str(_extract_first(r"\"conversationId\"\s*:\s*\"([^\"]+)\"", output))
    if not local_conversation_id:
        local_conversation_id = _clean_str(_extract_first(r"\"localConversationId\"\s*:\s*\"([^\"]+)\"", output))
    if not page_url:
        page_url = _clean_str(_extract_first(r"\"location\"\s*:\s*\"([^\"]+)\"", output))
    unwatermarked_url = (
        _clean_str(browser_poll.get("unwatermarkedUrl"))
        or _extract_first(r"unwatermarkedUrl:\s*(https?://\S+)", output)
    )
    cici_url = (
        _clean_str(browser_poll.get("ciciUrl"))
        or _extract_first(r"ciciUrl:\s*(https?://\S+)", output)
    )
    video_url = (
        unwatermarked_url
        or _clean_str(browser_poll.get("videoUrl"))
        or _extract_first(r"videoUrl:\s*(https?://\S+)", output)
        or cici_url
    )
    local_path = (
        _clean_str(browser_poll.get("localPath"))
        or _extract_first(r"可播放副本:\s*(.+?)(?:\s*\(|\n|$)", output)
        or _extract_first(r"可播放副本:\s*(.+)$", output)
        or _extract_first(r"保存到:\s*(.+?)(?:\s*\(|\n|$)", output)
        or _extract_first(r"保存到:\s*(.+)$", output)
    )
    failure_text = "\n".join([
        _clean_str(browser_poll.get("reason")),
        "；".join(browser_poll.get("failures") or []) if isinstance(browser_poll.get("failures"), list) else "",
    ])
    failure_reason = _extract_failure_reason(failure_text)
    if not failure_reason and not video_url and not local_path and bool(browser_poll.get("failed")):
        browser_failures = browser_poll.get("failures") or []
        browser_failure_text = _clean_str(browser_poll.get("reason"))
        if not browser_failure_text and isinstance(browser_failures, list):
            browser_failure_text = "；".join(str(item) for item in browser_failures if item)
        failure_reason = _compact_log_text(browser_failure_text or "Dola 浏览器同页轮询返回失败")[:1200]
    video_request_failure = _clean_str(network.get("videoRequestFailure"))
    if not failure_reason and video_request_failure and not (conversation_id or local_conversation_id or submit_ok):
        failure_reason = video_request_failure
    return {
        "conversation_id": conversation_id,
        "local_conversation_id": local_conversation_id,
        "page_url": page_url,
        "submit_ok": submit_ok,
        "request_seen": request_seen,
        "completion_count": completion_count,
        "video_url": video_url,
        "unwatermarked_url": unwatermarked_url,
        "cici_url": cici_url,
        "local_path": _playable_video_path(local_path),
        "failure_reason": failure_reason,
        "browser_session": browser_session,
        "browser_port": browser_session.get("port") or summary.get("port") or 0,
        "browser_profile_dir": _clean_str(browser_session.get("profileDir") or summary.get("profileDir")),
        "browser_base_profile_dir": _clean_str(browser_session.get("baseProfileDir") or summary.get("baseProfileDir")),
        "browser_temp_profile": bool(browser_session.get("useTempProfile") or summary.get("useTempProfile")),
        "browser_pid": browser_session.get("chromePid") or summary.get("chromePid") or 0,
        "summary": summary,
    }


def _browser_session_profile_dir() -> str:
    return profile_dir_path()


def _task_profile_dir(task_id: str) -> str:
    safe_task_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", _clean_str(task_id) or f"dola-{uuid.uuid4().hex[:12]}")
    return os.path.join(TASK_PROFILE_DIR, safe_task_id)


def _copy_profile_for_task(source_dir: str, target_dir: str) -> None:
    source = Path(_clean_str(source_dir))
    target = Path(_clean_str(target_dir))
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and any(target.iterdir()):
        return
    if not source.exists():
        target.mkdir(parents=True, exist_ok=True)
        return
    skip_names = {
        "SingletonLock",
        "SingletonSocket",
        "SingletonCookie",
        "lockfile",
        "DevToolsActivePort",
        "RunningChromeVersion",
        "BrowserMetrics",
        "Crashpad",
        "Crash Reports",
        "ShaderCache",
        "GrShaderCache",
        "DawnCache",
        "Code Cache",
        "GPUCache",
        "Cache",
        "Sessions",
        "Session Restore",
        "Session Storage",
        "Current Session",
        "Current Tabs",
        "Last Session",
        "Last Tabs",
        "Tabs",
    }

    def _ignore(_dir: str, names: list[str]) -> set[str]:
        return {name for name in names if name in skip_names or name.endswith(".lock")}

    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(source, target, ignore=_ignore)


def _prepare_task_profile(task_id: str, account: dict | None = None) -> str:
    target_dir = _task_profile_dir(task_id)
    source_dir = _clean_str(account.get("profile_dir") if account else "") or profile_dir_path()
    _copy_profile_for_task(source_dir, target_dir)
    return target_dir


def _write_prompt_to_tempfile(prompt: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".txt", prefix="dola_prompt_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(prompt)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    return path


def _prompt_file_cleanup_flag() -> str:
    return "--cleanup-prompt-file"


def _browser_submit_args(prompt: str, refs: list[str], ratio: str, duration: int, output_path: str = "", task_profile_dir: str = "") -> list[str]:
    args = [
        "browser-send-test.mjs",
        "--visible",
        "--keep-open",
        "--persistent-profile",
        "--profile",
        _clean_str(task_profile_dir) or _browser_session_profile_dir(),
        "--prompt-file",
        _write_prompt_to_tempfile(prompt),
        "--duration",
        str(duration),
        "--ratio",
        ratio,
        "--poll-result",
    ]
    if output_path:
        args.extend(["--poll-output", output_path])
    if refs:
        refs_file = _write_json_list_to_tempfile(refs, "dola-browser-refs-")
        args.extend(["--image-files-file", refs_file, "--cleanup-image-files-file"])
    args.append(_prompt_file_cleanup_flag())
    return args


def _write_prompt_to_tempfile(prompt: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".txt", prefix="dola-prompt-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(prompt)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    return path


_PROMPT_TEMPFILES: list[str] = []


def _prompt_file_cleanup_flag() -> str:
    return "--prompt-tempfiles"


def _is_data_url(value: str) -> bool:
    return _clean_str(value).startswith("data:")


def _is_http_url(value: str) -> bool:
    return bool(re.match(r"^https?://", _clean_str(value), re.IGNORECASE))


def _write_json_list_to_tempfile(values: list[str], prefix: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".json", prefix=prefix)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(values, f, ensure_ascii=False)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    return path


def _download_reference_source(source: str) -> str:
    raw = _clean_str(source)
    if not raw:
        return ""
    if os.path.exists(raw):
        return raw
    if raw.startswith("file://"):
        parsed = urllib.parse.urlparse(raw)
        candidate = urllib.request.url2pathname(parsed.path)
        if parsed.netloc and candidate.startswith("/") and not candidate.startswith("//"):
            candidate = f"//{parsed.netloc}{candidate}"
        return candidate

    temp_dir = Path(tempfile.mkdtemp(prefix="dola-api-ref-", dir=DOWNLOAD_DIR))
    temp_dir.mkdir(parents=True, exist_ok=True)

    if _is_data_url(raw):
        header, payload = raw.split(",", 1)
        meta = header[5:]
        mime = meta.split(";", 1)[0] if meta else "application/octet-stream"
        suffix = mimetypes.guess_extension(mime) or ".bin"
        if ";base64" in meta:
            data = base64.b64decode(payload)
        else:
            data = urllib.parse.unquote_to_bytes(payload)
        target = temp_dir / f"ref{suffix}"
        target.write_bytes(data)
        return str(target)

    if _is_http_url(raw):
        parsed = urllib.parse.urlparse(raw)
        suffix = Path(parsed.path).suffix or ".bin"
        target = temp_dir / f"ref{suffix}"
        headers = {}
        user_agent = _clean_str(os.environ.get("DOLA_USER_AGENT") or _load_config().get("user_agent"))
        if user_agent:
            headers["User-Agent"] = user_agent
        req = urllib.request.Request(raw, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            target.write_bytes(response.read())
        return str(target)

    return raw


def _prepare_api_reference_paths(reference_images: list[str] | None) -> list[str]:
    prepared: list[str] = []
    for item in reference_images or []:
        local_path = _download_reference_source(item)
        if not local_path:
            continue
        if not os.path.exists(local_path):
            raise DolaError(f"参考图不存在: {item}")
        if local_path not in prepared:
            prepared.append(local_path)
    return prepared


def _api_submit_args(prompt: str, refs: list[str], ratio: str, duration: int, model: str) -> list[str]:
    if refs:
        refs_file = _write_json_list_to_tempfile(refs, "dola-api-refs-")
        return [
            "dola-video-gen.mjs",
            "image",
            "--refs-file",
            refs_file,
            prompt,
            ratio,
            str(duration),
            model,
            "--cleanup-refs-file",
        ]
    return [
        "dola-video-gen.mjs",
        "text",
        prompt,
        ratio,
        str(duration),
        model,
    ]


def _download_video_to_local(video_url: str, task_id: str = "", conversation_id: str = "") -> str:
    """Download a remote video URL to DOWNLOAD_DIR as a fallback when JS scripts
    obtained the URL but failed to save the file locally.

    Returns the local file path on success, or "" on failure.
    """
    url = _clean_str(video_url)
    if not url or not url.startswith("http"):
        return ""
    try:
        Path(DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)
        suffix = conversation_id or task_id or uuid.uuid4().hex[:8]
        local_path = os.path.join(DOWNLOAD_DIR, f"dola-fallback-{suffix}.mp4")
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "video/mp4,video/*,*/*;q=0.8",
        })
        with urllib.request.urlopen(req, timeout=120) as resp, open(local_path, "wb") as f:
            shutil.copyfileobj(resp, f)
        if os.path.getsize(local_path) > 0:
            return local_path
        os.remove(local_path)
        return ""
    except Exception:
        try:
            if local_path and os.path.isfile(local_path):
                os.remove(local_path)
        except OSError:
            pass
        return ""


def _parse_generation_output(output: str) -> dict:
    conversation_id = (
        _extract_first(r"ACK:\s*conv=([A-Za-z0-9_\-]+)", output)
        or _extract_first(r"conversationId:\s*([A-Za-z0-9_\-]+)", output)
        or _extract_first(r"conversation_id[:=]\s*([A-Za-z0-9_\-]+)", output)
        or _extract_first(r"conversation_id=([A-Za-z0-9_\-]+)", output)
    )
    unwatermarked_url = _extract_first(r"unwatermarkedUrl:\s*(https?://\S+)", output)
    cici_url = _extract_first(r"ciciUrl:\s*(https?://\S+)", output)
    video_url = (
        unwatermarked_url
        or _extract_first(r"videoUrl:\s*(https?://\S+)", output)
        or _extract_first(r"downloadUrl:\s*(https?://\S+)", output)
        or _extract_first(r"视频URL[^:：]*[:：]\s*(https?://\S+)", output)
        or cici_url
    )
    saved_path = _extract_first(r"保存到:\s*(.+?)(?:\s*\(|\n|$)", output)
    if not saved_path:
        saved_path = _extract_first(r"保存到:\s*(.+)$", output)
    failure_reason = ""
    if not video_url and not saved_path:
        failure_reason = _extract_first(r"\[失败\]\s*([^\n]+)", output)
        if failure_reason:
            failure_reason = _compact_log_text(failure_reason)
            pending_or_noise_markers = (
                "整个轮询期间未成功拉取到任何消息",
                "服务端始终未返回视频块",
                "未在",
                "_opt_tiger_compile_path",
                "node_modules",
                "function",
                "var ",
            )
            if any(marker in failure_reason for marker in pending_or_noise_markers):
                failure_reason = ""
            elif not _extract_failure_reason(f"[失败] {failure_reason}"):
                failure_reason = ""
    elif video_url and not saved_path:
        download_failure = _extract_first(r"\[失败\]\s*([^\n]+)", output)
        if not download_failure:
            download_failure = _extract_first(r"\[错误\]\s*([^\n]+)", output)
        if download_failure:
            failure_reason = _compact_log_text(download_failure)
    return {
        "conversation_id": conversation_id,
        "video_url": video_url,
        "unwatermarked_url": unwatermarked_url,
        "cici_url": cici_url,
        "local_path": saved_path,
        "failure_reason": failure_reason,
    }


def _compact_log_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _extract_failure_reason(output: str) -> str:
    text = output or ""
    if not text:
        return ""
    dola_error = _extract_dola_error_message(text)
    if dola_error:
        return dola_error[:1200]
    reason = _extract_last(r"\[失败\]\s*([^\n]+)", text)
    task_text = (
        _extract_last(r"任务文本:\s*(.+)", text)
        or _extract_last(r"fullText:\s*(.+)", text)
    )
    compact = _compact_log_text(text)
    if reason:
        if task_text:
            return _compact_log_text(f"{reason}：{task_text}")[:1200]
        return _compact_log_text(reason)[:1200]

    failure_patterns = [
        ("内容未通过，无法返回视频", r"生成内容[^。！？\n]{0,60}(?:疑似包含|包含|涉及)[^。！？\n]{0,40}(?:侵权|违规|违法|违禁)[^。！？\n]{0,80}无法返回"),
        ("内容未通过，无法返回视频", r"无法返回该内容[^。！？\n]{0,80}(?:换个主题|重新尝试|再试试)"),
        ("视频时长超过限制，无法生成视频", r"(?:无法|不能|不支持|暂时无法|目前无法|当前无法)生成[^。！？\n]{0,12}超过\s*\d+\s*秒|超过\s*\d+\s*秒[^。！？\n]{0,20}(?:无法|不能|不支持)生成"),
        ("视频时长超过限制，无法生成视频", r"videos?\s+longer\s+than\s+\d+\s+seconds?\s+cannot\s+be\s+generated|cannot\s+(?:currently\s+)?generate\s+(?:a\s+)?videos?\s+longer\s+than"),
        ("Dola 浏览器提交没有进入视频能力", r"Dola\s*浏览器提交没有进入视频能力|ability_type\s*=\s*(?!17\b)\d+"),
        ("返回的是图片，不是视频", r"以下是[^。！？\n]{0,80}(?:图片|图像|照片|海报|封面)"),
        ("返回的是图片，不是视频", r"(?:已|已经|为你|帮你)[^。！？\n]{0,50}(?:生成|创作|制作)[^。！？\n]{0,40}(?:图片|图像|照片|海报|封面)"),
        ("视频生成失败", r"视频[^。！？\n]{0,40}(?:生成|制作|创建|处理)[^。！？\n]{0,20}(?:失败|不成功|无法完成|未能完成)"),
        ("内容未通过，无法生成视频", r"(?:内容|请求|提示词)[^。！？\n]{0,50}(?:不符合|违规|违反|无法通过|未通过|不适合)[^。！？\n]{0,50}(?:视频|生成)"),
        ("任务明确拒绝生成视频", r"(?:unable|cannot|can't)[^.\n]{0,80}(?:generate|create|make)[^.\n]{0,40}video"),
        ("Dola 拒绝生成该内容", r"(?:暂时|目前|当前)?无法生成[^。！？\n]{0,20}(?:该|您要求|您需要|这个)?(?:内容|视频)[^。！？\n]{0,30}(?:请尝试|我会尽力|请输入)"),
        ("Dola 拒绝生成该内容", r"(?:暂时|目前)?无法生成您?要求的内容"),
        ("今日生成次数已达上限", r"今天[^。！？\n]{0,20}(?:生成|使用|创作)[^。！？\n]{0,20}(?:次数|额度)[^。！？\n]{0,20}(?:达到|已达)[^。！？\n]{0,20}上限"),
        ("今日生成次数已达上限", r"(?:生成|使用|创作)[^。！？\n]{0,20}(?:次数|额度)[^。！？\n]{0,20}(?:达到|已达)[^。！？\n]{0,20}上限[^。！？\n]{0,20}明天"),
    ]
    for label, pattern in failure_patterns:
        if re.search(pattern, compact, re.IGNORECASE):
            return f"{label}：{compact[-1000:]}"[:1200]
    return ""


# Dola 服务端"额度不足/拒绝生成"类消息的特征词。
# 这类消息里虽然也含"消耗 N 个视频生成额度"字样，但任务是**被拒绝**的，
# 服务端并没有真正扣额度，本地不能误扣，否则账号剩余额度会被扣成负数。
_QUOTA_REJECTION_MARKERS = (
    "额度不足",
    "无法生成该视频",
    "无法生成视频",
    "无法生成该内容",
    "请尝试降低配置",
    "cookie 过期",
    "内容未通过",
    "明确拒绝",
    "无法返回",
    "cannot be generated",
    "cannot generate",
    "longer than",
    "unable to generate",
    "达到上限",
    "已达上限",
)


def _looks_like_quota_rejection(text: str) -> bool:
    compact = _compact_log_text(text or "")
    if not compact:
        return False
    return any(marker in compact for marker in _QUOTA_REJECTION_MARKERS)


def _extract_observed_quota_cost(output: str) -> int:
    # 先判断这条输出是不是"拒绝/失败"消息。
    # Dola 在额度不足时会回"本次视频生成需要消耗 2 个视频生成额度，今日剩余 1 个
    # 视频生成额度，无法生成该视频"——里面也有"消耗 2 个额度"，但任务被拒绝、
    # 服务端没真扣，本地绝对不能扣，否则账号额度会被扣成负数。
    if _looks_like_quota_rejection(output):
        return 0
    cost_text = _extract_last(r"(?:将)?消耗\s*(\d+)\s*个视频生成额度", output or "")
    if not cost_text:
        return 0
    try:
        return max(0, int(cost_text))
    except (TypeError, ValueError):
        return 0


def _reserve_observed_quota_once(task_id: str, output: str) -> None:
    cost = _extract_observed_quota_cost(output)
    if cost <= 0:
        return
    task = _get_task(task_id)
    account_id = int(task.get("quota_account_id") or task.get("account_id") or 0)
    if not account_id or int(task.get("quota_cost") or 0) > 0:
        return
    try:
        DolaAccountDB.reserve_daily_video_quota(account_id, cost)
        _set_task(
            task_id,
            quota_cost=cost,
            quota_released=True,
            quota_observed=True,
        )
    except Exception as e:
        _set_task(task_id, quota_sync_error=str(e))


def _is_empty_sse_retryable_error(message: str) -> bool:
    text = _compact_log_text(message or "")
    return bool(
        text
        and "SSE" in text
        and ("立即关闭" in text or "未返回会话" in text or "未返回会话 ID" in text)
        and not any(marker in text for marker in _QUOTA_REJECTION_MARKERS)
    )


def _persist_task_cache() -> None:
    try:
        Path(TASK_CACHE_PATH).parent.mkdir(parents=True, exist_ok=True)
        with open(TASK_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(_task_cache, f, ensure_ascii=False)
    except Exception:
        pass


def _load_task_cache() -> None:
    try:
        with open(TASK_CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _task_cache.update({str(k): v for k, v in data.items() if isinstance(v, dict)})
    except Exception:
        pass


_load_task_cache()


def _set_task(cache_key: str, **updates) -> dict:
    with _task_lock:
        current = _task_cache.get(cache_key, {})
        current.update(updates)
        current["updated_at"] = time.time()
        _task_cache[cache_key] = current
        snapshot = dict(current)
        _persist_task_cache()
        return snapshot


def _repair_internal_state_error(task: dict) -> dict:
    if not isinstance(task, dict) or task.get("status") != "failed":
        return task
    evidence = "\n".join([
        _clean_str(task.get("error")),
        _clean_str(task.get("fail_reason")),
        _clean_str(task.get("output")),
    ])
    concise_failure = _extract_failure_reason(evidence)
    if concise_failure and concise_failure not in {task.get("error"), task.get("fail_reason")}:
        repaired = dict(task)
        repaired.update({
            "error": concise_failure,
            "fail_reason": concise_failure,
            "updated_at": time.time(),
        })
        return repaired
    if "got multiple values for keyword argument" not in evidence:
        return task
    if not (_clean_str(task.get("conversation_id")) or _clean_str(task.get("local_conversation_id")) or _clean_str(task.get("page_url"))):
        return task
    repaired = dict(task)
    try:
        current_progress = int(repaired.get("progress") or 0)
    except (TypeError, ValueError):
        current_progress = 0
    repaired.update({
        "status": "collectable",
        "error": "",
        "fail_reason": "",
        "progress": max(85, current_progress),
        "collectable": True,
        "repaired_internal_error": evidence[:500],
        "updated_at": time.time(),
    })
    return repaired


def _repair_stale_collecting_task(cache_key: str, task: dict) -> dict:
    if not isinstance(task, dict) or task.get("status") != "collecting":
        return task
    if cache_key in _active_collect_tasks:
        return task
    try:
        started_at = float(task.get("collect_started_at") or task.get("updated_at") or 0)
    except (TypeError, ValueError):
        started_at = 0
    if started_at and time.time() - started_at < 90:
        return task
    repaired = dict(task)
    repaired.update({
        "status": "collectable",
        "progress": max(90, int(repaired.get("progress") or 0) if str(repaired.get("progress") or "").isdigit() else 90),
        "error": "",
        "fail_reason": "上次采集已结束或中断，已恢复为可重新采集状态。",
        "updated_at": time.time(),
    })
    return repaired


def _get_task(cache_key: str) -> dict:
    with _task_lock:
        current = _task_cache.get(cache_key, {})
        repaired = _repair_internal_state_error(dict(current))
        repaired = _repair_stale_collecting_task(cache_key, repaired)
        local_path = _clean_str(repaired.get("local_path"))
        playable_path = _playable_video_path(local_path)
        if playable_path != local_path:
            repaired["local_path"] = playable_path
        if repaired != current:
            _task_cache[cache_key] = repaired
            _persist_task_cache()
        return dict(repaired)


def _sync_task_db_status(task_id: str, status: str, video_url: str | None = None) -> None:
    try:
        TaskDB.update_status(task_id, status, video_url)
    except Exception:
        pass


def _release_reserved_quota_once(task_id: str, reason: str = "") -> None:
    task = _get_task(task_id)
    account_id = int(task.get("quota_account_id") or 0)
    quota_cost = int(task.get("quota_cost") or 0)
    if not account_id or quota_cost <= 0 or task.get("quota_released"):
        return
    try:
        DolaAccountDB.release_daily_video_quota(account_id, quota_cost)
        _set_task(
            task_id,
            quota_released=True,
            quota_release_reason=_compact_log_text(reason)[:500],
        )
    except Exception as e:
        _set_task(task_id, quota_release_error=str(e))


def _task_update_payload(updates: dict, *reserved_keys: str) -> dict:
    reserved = set(reserved_keys)
    return {key: value for key, value in dict(updates or {}).items() if key not in reserved}


def _fail_task(task_id: str, error: str, progress: int = 100, **updates) -> None:
    message = _compact_log_text(error or "Dola 生成失败")[:1200]
    payload = _task_update_payload(updates, "status", "error", "fail_reason", "progress")
    payload.update({
        "status": "failed",
        "error": message,
        "fail_reason": message,
        "progress": progress,
    })
    _set_task(task_id, **payload)
    _sync_task_db_status(task_id, "failed")
    _release_reserved_quota_once(task_id, message)
    _check_daily_limit_and_disable(task_id, message)


def _check_daily_limit_and_disable(task_id: str, message: str) -> None:
    """When the Dola server says daily limit is reached, disable the account
    for the rest of today by maxing out its daily_video_used."""
    if not message:
        return
    markers = ("今日生成次数已达上限", "达到上限", "已达上限", "明天再来")
    if not any(marker in message for marker in markers):
        return
    task = _get_task(task_id)
    account_id = int(task.get("quota_account_id") or task.get("account_id") or 0)
    if not account_id:
        return
    try:
        DolaAccountDB.mark_daily_limit_reached(account_id)
    except Exception as e:
        _set_task(task_id, daily_limit_disable_error=str(e))


def create_video(
    prompt: str = "",
    image_path: str = "",
    image_url: str = "",
    reference_images: list[str] | None = None,
    model: str = "seedance-2.0",
    ratio: str = "16:9",
    duration: int = 5,
    account: dict | None = None,
    task_id: str = "",
    quota_cost: int = 0,
    retry_account_picker=None,
    max_empty_sse_retries: int = 1,
) -> dict:
    prompt = _clean_str(prompt, "生成一段视频")
    model = _clean_str(model, "seedance-2.0")
    ratio = _clean_str(ratio, "16:9")
    try:
        requested_duration = int(duration or 10)
    except (TypeError, ValueError):
        requested_duration = 10
    # Dola 服务端已支持 5s/10s/15s（实测 2026-06-25：15s 被 ACK 接受，扣 3 个额度）。
    # 只做合法档位归一，与 dola-video-gen.mjs:normalizeApiDuration 保持一致。
    if requested_duration <= 5:
        duration = 5
    elif requested_duration <= 10:
        duration = 10
    else:
        duration = 15

    refs: list[str] = []
    for item in [image_path, image_url, *(reference_images or [])]:
        value = _clean_str(item)
        if value and value not in refs:
            refs.append(value)

    task_id = _clean_str(task_id) or f"dola-{uuid.uuid4().hex[:12]}"
    send_mode = get_send_mode()
    send_mode_label = next((item["label"] for item in SEND_MODE_OPTIONS if item["id"] == send_mode), send_mode)
    Path(DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)
    Path(TASK_PROFILE_DIR).mkdir(parents=True, exist_ok=True)
    account_id = int(account.get("id") or 0) if account else 0
    account_name = account.get("name", "") if account else ""
    account_env_file = _clean_str(account.get("env_file") if account else "") or env_file_path()
    account_profile_dir = _clean_str(account.get("profile_dir") if account else "") or profile_dir_path()
    task_profile_dir = _prepare_task_profile(task_id, account)
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
        unwatermarked_url="",
        cici_url="",
        local_path="",
        conversation_id="",
        local_conversation_id="",
        page_url="",
        browser_port=0,
        browser_profile_dir=task_profile_dir,
        browser_base_profile_dir=task_profile_dir,
        browser_temp_profile=False,
        browser_persistent_profile=True,
        browser_pid=0,
        browser_session={},
        send_mode=send_mode,
        send_mode_label=send_mode_label,
        reference_images=refs,
        error="",
        fail_reason="",
        output="",
        quota_account_id=account_id,
        account_id=account_id,
        account_name=account_name,
        account_env_file=account_env_file,
        account_profile_dir=account_profile_dir,
        quota_cost=max(0, int(quota_cost or 0)),
        quota_released=False,
        retry_count=0,
        retry_errors=[],
        created_at=time.time(),
    )

    def _run() -> None:
        try:
            _set_task(task_id, status="processing", progress=5, error="", fail_reason="")
            if account_id:
                try:
                    TaskDB.update_account(task_id, account_id)
                except Exception:
                    pass
            _sync_task_db_status(task_id, "processing")
            account_env_overrides = _account_env_overrides(account_env_file, account_profile_dir)

            if send_mode == SEND_MODE_API:
                api_refs = _prepare_api_reference_paths(refs)
                args = _api_submit_args(prompt, api_refs, ratio, duration, model)

                def _on_api_output(output: str) -> None:
                    parsed = _parse_generation_output(output)
                    conversation_id = parsed.get("conversation_id", "")
                    if conversation_id:
                        _reserve_observed_quota_once(task_id, output)
                        _set_task(
                            task_id,
                            output=output[-8000:],
                            conversation_id=conversation_id,
                            page_url=f"https://www.dola.com/chat/{conversation_id}",
                            send_mode=send_mode,
                            send_mode_label=send_mode_label,
                            browser_summary={"send_mode": send_mode},
                            progress=90,
                            error="",
                            fail_reason="Dola 已接受任务，正在等待视频生成完成。",
                        )
                        _sync_task_db_status(task_id, "processing")
                    else:
                        _set_task(task_id, output=output[-8000:])

                result = _run_node_streaming(
                    args,
                    timeout=420,
                    on_output=_on_api_output,
                    env_overrides={**account_env_overrides, "DOLA_TASK_ID": task_id},
                )
                output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
                parsed = _parse_generation_output(output)
                conversation_id = parsed.get("conversation_id", "")
                video_url = parsed.get("video_url", "")
                local_path = parsed.get("local_path", "")
                updates = {
                    "output": output[-8000:],
                    "conversation_id": conversation_id,
                    "local_conversation_id": "",
                    "page_url": f"https://www.dola.com/chat/{conversation_id}" if conversation_id else "",
                    "send_mode": send_mode,
                    "send_mode_label": send_mode_label,
                    "browser_summary": {"send_mode": send_mode},
                    "video_url": video_url,
                    "unwatermarked_url": parsed.get("unwatermarked_url", ""),
                    "cici_url": parsed.get("cici_url", ""),
                    "local_path": local_path,
                    "progress": 100,
                }
                _reserve_observed_quota_once(task_id, output)
                if result.returncode != 0 and conversation_id and not video_url and not local_path and not parsed.get("failure_reason"):
                    _set_task(
                        task_id,
                        **_task_update_payload(updates, "status", "progress", "error", "fail_reason"),
                        status="collectable",
                        progress=90,
                        error="",
                        fail_reason="Dola 已接受任务，但本地等待结果超时。可稍后打开 Dola 会话或点击采集结果。",
                    )
                    _sync_task_db_status(task_id, "collectable")
                    return
                if result.returncode != 0:
                    if video_url and not local_path:
                        downloaded = _download_video_to_local(video_url, task_id=task_id, conversation_id=conversation_id)
                        if downloaded:
                            local_path = downloaded
                            updates["local_path"] = local_path
                    if video_url and not local_path:
                        message = parsed.get("failure_reason", "") or _extract_failure_reason(output) or f"Dola API 生成失败：视频地址已获取但下载失败。远程地址: {video_url[:200]}"
                        _fail_task(task_id, message, **updates)
                        return
                    if not video_url and not local_path:
                        message = parsed.get("failure_reason", "") or _extract_failure_reason(output) or "Dola API 生成失败"
                        _fail_task(task_id, message, **updates)
                        return
                failure_reason = parsed.get("failure_reason", "")
                if failure_reason:
                    _fail_task(task_id, failure_reason, **updates)
                    return
                if not conversation_id and not video_url and not local_path:
                    message = "Dola API 已结束，但没有拿到视频地址或会话信息。"
                    _fail_task(task_id, message, **updates)
                    return
                if video_url and not local_path:
                    downloaded = _download_video_to_local(video_url, task_id=task_id, conversation_id=conversation_id)
                    if downloaded:
                        local_path = downloaded
                        updates["local_path"] = local_path
                if video_url or local_path:
                    _set_task(
                        task_id,
                        **_task_update_payload(updates, "status", "error", "fail_reason"),
                        status="completed",
                        error="",
                        fail_reason="",
                    )
                    _sync_task_db_status(task_id, "completed", local_path or video_url or "")
                else:
                    _set_task(
                        task_id,
                        **_task_update_payload(updates, "status", "progress", "error", "fail_reason"),
                        status="processing",
                        progress=90,
                        error="",
                        fail_reason="",
                    )
                    _sync_task_db_status(task_id, "processing")
                    threading.Thread(
                        target=_poll_task_result,
                        args=(task_id, conversation_id, account_env_overrides),
                        daemon=True,
                    ).start()
                return

            browser_output_path = os.path.join(DOWNLOAD_DIR, f"dola-browser-{task_id}.mp4")
            args = _browser_submit_args(prompt, refs, ratio, duration, browser_output_path, task_profile_dir)

            def _on_output(output: str) -> None:
                parsed = _parse_browser_submit_output(output)
                progress = 20
                if "upload" in output.lower() or "上传" in output:
                    progress = 35
                if "/chat/completion" in output or parsed.get("local_conversation_id"):
                    progress = 65
                if parsed.get("conversation_id") or parsed.get("page_url"):
                    progress = 85
                if parsed.get("video_url") or parsed.get("local_path"):
                    progress = 95
                _set_task(
                    task_id,
                    output=output[-8000:],
                    conversation_id=parsed.get("conversation_id", ""),
                    local_conversation_id=parsed.get("local_conversation_id", ""),
                    page_url=parsed.get("page_url", ""),
                    browser_port=parsed.get("browser_port") or 0,
                    browser_profile_dir=parsed.get("browser_profile_dir") or task_profile_dir,
                    browser_base_profile_dir=parsed.get("browser_base_profile_dir") or task_profile_dir,
                    browser_temp_profile=False,
                    browser_persistent_profile=True,
                    browser_pid=parsed.get("browser_pid") or 0,
                    browser_session=parsed.get("browser_session") or {},
                    browser_summary=parsed.get("summary") or {},
                    video_url=parsed.get("video_url", ""),
                    unwatermarked_url=parsed.get("unwatermarked_url", ""),
                    cici_url=parsed.get("cici_url", ""),
                    local_path=parsed.get("local_path", ""),
                    progress=progress,
                )

            result = _run_node_streaming(args, timeout=900, on_output=_on_output, env_overrides={**account_env_overrides, "DOLA_TASK_ID": task_id})
            output = result.stdout or ""
            parsed = _parse_browser_submit_output(output)
            updates = {
                "output": output[-8000:],
                "conversation_id": parsed.get("conversation_id", ""),
                "local_conversation_id": parsed.get("local_conversation_id", ""),
                "page_url": parsed.get("page_url", ""),
                "browser_port": parsed.get("browser_port") or 0,
                "browser_profile_dir": parsed.get("browser_profile_dir") or task_profile_dir,
                "browser_base_profile_dir": parsed.get("browser_base_profile_dir") or task_profile_dir,
                "browser_temp_profile": False,
                "browser_persistent_profile": True,
                "browser_pid": parsed.get("browser_pid") or 0,
                "browser_session": parsed.get("browser_session") or {},
                "send_mode": send_mode,
                "send_mode_label": send_mode_label,
                "browser_summary": parsed.get("summary") or {},
                "video_url": parsed.get("video_url", ""),
                "unwatermarked_url": parsed.get("unwatermarked_url", ""),
                "cici_url": parsed.get("cici_url", ""),
                "local_path": parsed.get("local_path", ""),
                "progress": 100,
            }
            if result.returncode != 0:
                video_url = _clean_str(parsed.get("video_url", ""))
                local_path = _clean_str(parsed.get("local_path", ""))
                if video_url and not local_path:
                    downloaded = _download_video_to_local(video_url, task_id=task_id, conversation_id=parsed.get("conversation_id", ""))
                    if downloaded:
                        updates["local_path"] = downloaded
                        _set_task(
                            task_id,
                            **_task_update_payload(updates, "status", "error", "fail_reason"),
                            status="completed",
                            error="",
                            fail_reason="",
                        )
                        _sync_task_db_status(task_id, "completed", downloaded)
                        return
                message = parsed.get("failure_reason", "") or _extract_failure_reason(output) or "Dola 浏览器提交失败"
                _fail_task(task_id, message, **updates)
                return

            video_url = parsed.get("video_url", "")
            local_path = parsed.get("local_path", "")
            if video_url and not local_path:
                downloaded = _download_video_to_local(video_url, task_id=task_id, conversation_id=parsed.get("conversation_id", ""))
                if downloaded:
                    local_path = downloaded
                    updates["local_path"] = local_path
            if video_url or local_path:
                _set_task(
                    task_id,
                    **_task_update_payload(updates, "status", "error", "fail_reason"),
                    status="completed",
                    error="",
                    fail_reason="",
                )
                _sync_task_db_status(task_id, "completed", local_path or video_url or "")
                return

            failure_reason = parsed.get("failure_reason", "")
            if failure_reason:
                _fail_task(task_id, failure_reason, **updates)
                return

            conversation_id = parsed.get("conversation_id", "")
            local_conversation_id = parsed.get("local_conversation_id", "")
            if not parsed.get("submit_ok"):
                message = "Dola 浏览器已打开，但没有观测到视频生成请求。请检查页面是否完成上传、切到视频并点击生成。"
                _fail_task(task_id, message, **updates)
                return
            if not conversation_id and not local_conversation_id:
                message = "Dola 已发起生成请求，但没有记录到查询会话。请打开浏览器历史确认任务。"
                _fail_task(task_id, message, **updates)
                return

            # 浏览器提交成功，拿到 conversation_id 后直接启动 API 轮询获取视频结果
            # 不再需要手动采集（复用 dola-video-poll-flat.mjs 调 /im/chain/single）
            _set_task(
                task_id,
                **_task_update_payload(updates, "status", "progress", "error", "fail_reason"),
                status="processing",
                progress=90,
                error="",
                fail_reason="",
            )
            _sync_task_db_status(task_id, "processing")
            threading.Thread(
                target=_poll_task_result,
                args=(task_id, conversation_id, account_env_overrides),
                daemon=True,
            ).start()
        except Exception as e:  # noqa: BLE001
            _fail_task(task_id, str(e), progress=0)

    threading.Thread(target=_run, daemon=True).start()
    return _get_task(task_id)


def _poll_task_result(task_id: str, conversation_id: str, env_overrides: dict | None = None, manual_collect: bool = False) -> None:
    """用 dola-video-poll-flat.mjs 轮询 Dola API (/im/chain/single) 获取视频结果。

    直接通过 Node 脚本调 signedFetch，不需要开浏览器。
    轮询成功后更新为 completed；API 暂无结果或临时异常时保持 collectable 便于重试。
    """
    conv = _clean_str(conversation_id)
    if not conv:
        _fail_task(task_id, "缺少 conversation_id，无法轮询获取视频结果")
        return
    try:
        current_task = _get_task(task_id)
        try:
            current_progress = int(current_task.get("progress") or 0)
        except (TypeError, ValueError):
            current_progress = 0
        start_status = "collecting" if manual_collect else "processing"
        start_reason = "正在通过 API 采集 Dola 视频结果..." if manual_collect else ""
        _set_task(task_id, status=start_status, progress=max(20, current_progress), error="", fail_reason=start_reason)
        _sync_task_db_status(task_id, "processing")
        Path(DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)
        output_path = os.path.join(DOWNLOAD_DIR, f"dola-{conv}.mp4")
        poll_env_overrides = dict(env_overrides or {})
        if manual_collect:
            poll_env_overrides.setdefault("DOLA_MAX_POLL_TIME_MS", "120000")
            poll_env_overrides.setdefault("DOLA_POLL_INTERVAL_MS", "3000")
            poll_env_overrides.setdefault("DOLA_POLL_REQUEST_TIMEOUT_MS", "8000")
        result = _run_node(["dola-video-poll-flat.mjs", conv, output_path], timeout=150 if manual_collect else 480, env_overrides=poll_env_overrides)
        output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
        parsed = _parse_generation_output(output)
        updates = {
            "output": output[-8000:],
            "conversation_id": conv,
            "video_url": parsed.get("video_url", ""),
            "unwatermarked_url": parsed.get("unwatermarked_url", ""),
            "cici_url": parsed.get("cici_url", ""),
            "local_path": parsed.get("local_path", ""),
            "fail_reason": parsed.get("failure_reason", ""),
            "progress": 100 if result.returncode == 0 or parsed.get("failure_reason") else 90,
            "collect_finished_at": time.time(),
        }
        if parsed.get("video_url") or parsed.get("local_path"):
            local_path = _clean_str(parsed.get("local_path", ""))
            video_url = _clean_str(parsed.get("video_url", ""))
            if video_url and not local_path:
                downloaded = _download_video_to_local(video_url, task_id=task_id, conversation_id=conv)
                if downloaded:
                    local_path = downloaded
                    updates["local_path"] = local_path
                else:
                    _fail_task(
                        task_id,
                        f"视频已生成但下载到本地失败，远程链接可能已过期。可尝试重新采集或打开浏览器查看。远程地址: {video_url[:200]}",
                        **updates,
                    )
                    if manual_collect:
                        _close_task_browser(task_id)
                    return
            _set_task(
                task_id,
                **_task_update_payload(updates, "status", "error", "fail_reason"),
                status="completed",
                error="",
                fail_reason="",
                collect_fail_count=0,
            )
            _sync_task_db_status(task_id, "completed", local_path or video_url or "")
            if manual_collect:
                _close_task_browser(task_id)
        elif parsed.get("failure_reason") and any(marker in parsed.get("failure_reason", "") for marker in ("侵权", "违规", "违法", "违禁", "无法生成", "无法返回", "生成失败", "内容未通过", "抱歉", "时长超过", "拒绝生成", "达到上限", "已达上限", "cannot be generated", "longer than")):
            _fail_task(task_id, parsed.get("failure_reason", ""), **updates)
            if manual_collect:
                _close_task_browser(task_id)
        elif _looks_like_quota_rejection(output):
            quota_reason = _compact_log_text(output)[:500]
            _fail_task(task_id, f"额度不足或被拒绝生成: {quota_reason}", **updates)
            if manual_collect:
                _close_task_browser(task_id)
        elif result.returncode == 0:
            _set_task(
                task_id,
                **_task_update_payload(updates, "status", "error", "fail_reason"),
                status="completed",
                error="",
                fail_reason="",
            )
            _sync_task_db_status(task_id, "completed", parsed.get("local_path") or parsed.get("video_url") or "")
            if manual_collect:
                _close_task_browser(task_id)
        else:
            collectable_updates = _task_update_payload(updates, "status", "error", "fail_reason")
            retry_reason = parsed.get("failure_reason", "") or "暂未拿到视频，已保留会话，可稍后继续采集。"
            retry_evidence = "\n".join([retry_reason, output])
            if "服务端始终未返回视频块" in retry_evidence or "整个轮询期间未成功拉取到任何消息" in retry_evidence:
                retry_reason = "API 暂未读取到该 Dola 会话的视频消息；如果网页已显示视频，可能是当前账号 API 会话看不到这条页面消息。可稍后重试，或显式打开浏览器调试采集。"
            elif result.returncode == 124:
                retry_reason = "本次 API 采集超时，已停止后台采集并保留为可重试状态。"
            # 采集失败计数：连续拿不到视频达阈值则判定生成失败（覆盖"网页已违规但 API 看不到"的情况）
            try:
                prev_fail_count = int(current_task.get("collect_fail_count") or 0)
            except (TypeError, ValueError):
                prev_fail_count = 0
            next_fail_count = prev_fail_count + 1
            COLLECT_FAIL_THRESHOLD = 3
            if next_fail_count >= COLLECT_FAIL_THRESHOLD:
                _fail_task(
                    task_id,
                    f"连续 {next_fail_count} 次采集均未拿到视频，判定为生成失败（可能是内容违规被 Dola 拒绝、或账号 API 会话无法读取该消息）。最后原因：{retry_reason}",
                    progress=100,
                    collect_fail_count=next_fail_count,
                )
            else:
                _set_task(
                    task_id,
                    **collectable_updates,
                    status="collectable",
                    error="",
                    fail_reason=retry_reason,
                    collect_fail_count=next_fail_count,
                )
                _sync_task_db_status(task_id, "collectable")
    except Exception as e:  # noqa: BLE001
        _set_task(
            task_id,
            status="collectable",
            progress=90,
            error="",
            fail_reason=f"API 采集异常，可稍后重试: {e}",
            collect_finished_at=time.time(),
        )
        _sync_task_db_status(task_id, "collectable")
    finally:
        with _task_lock:
            _active_collect_tasks.discard(task_id)


def _collect_task_result_browser_context(task_id: str, conversation_id: str) -> bool:
    task = _get_task(task_id)
    conv = _clean_str(conversation_id)
    if not conv:
        return False
    try:
        browser_port = int(task.get("browser_port") or 0)
    except (TypeError, ValueError):
        browser_port = 0
    if not browser_port:
        return False

    page_url = _clean_str(task.get("page_url")) or f"https://www.dola.com/chat/{conv}"
    if not _is_chrome_debug_port_ready(browser_port):
        return False
    try:
        _set_task(task_id, status="collecting", progress=25, error="", fail_reason="正在通过任务浏览器会话采集 Dola 结果...")
        _sync_task_db_status(task_id, "processing")
        Path(DOWNLOAD_DIR).mkdir(parents=True, exist_ok=True)
        output_path = os.path.join(DOWNLOAD_DIR, f"dola-browser-{task_id}.mp4")
        result = _run_node([
            "browser-send-test.mjs",
            "--collect-only",
            "--port", str(browser_port),
            "--conversation-id", conv,
            "--url", page_url,
            "--poll-output", output_path,
            "--poll-timeout-ms", "120000",
            "--poll-interval-ms", "5000",
        ], timeout=150, env_overrides={"DOLA_TASK_ID": task_id})
        output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
        parsed = _parse_browser_submit_output(output)
        updates = {
            "output": output[-8000:],
            "conversation_id": conv,
            "page_url": page_url,
            "video_url": parsed.get("video_url", ""),
            "unwatermarked_url": parsed.get("unwatermarked_url", ""),
            "cici_url": parsed.get("cici_url", ""),
            "local_path": parsed.get("local_path", ""),
            "browser_summary": parsed.get("summary") or {},
            "progress": 100 if result.returncode == 0 and (parsed.get("video_url") or parsed.get("local_path")) else 90,
        }
        if parsed.get("video_url") or parsed.get("local_path"):
            local_path = _clean_str(parsed.get("local_path", ""))
            video_url = _clean_str(parsed.get("video_url", ""))
            if video_url and not local_path:
                downloaded = _download_video_to_local(video_url, task_id=task_id, conversation_id=conv)
                if downloaded:
                    local_path = downloaded
                    updates["local_path"] = local_path
            if not local_path:
                _set_task(
                    task_id,
                    **_task_update_payload(updates, "status", "error", "fail_reason"),
                    status="collectable",
                    error="",
                    fail_reason=f"视频地址已获取但下载到本地失败，可稍后重试。远程地址: {video_url[:200]}",
                )
                _sync_task_db_status(task_id, "collectable")
                return False
            _set_task(
                task_id,
                **_task_update_payload(updates, "status", "error", "fail_reason"),
                status="completed",
                error="",
                fail_reason="",
            )
            _sync_task_db_status(task_id, "completed", local_path)
            _close_task_browser(task_id)
            return True
        if result.returncode != 0 and "CDP not ready" in output:
            _set_task(
                task_id,
                **_task_update_payload(updates, "status", "error", "fail_reason"),
                status="collectable",
                error="",
                fail_reason="任务浏览器窗口已关闭或调试端口不可用，无法读取该无痕会话里的生成结果。请重新打开该任务浏览器会话后再采集，或保持任务窗口不关闭。",
            )
            _sync_task_db_status(task_id, "collectable")
            return False
        if _looks_like_quota_rejection(output):
            quota_reason = _compact_log_text(output)[:500]
            _fail_task(task_id, f"额度不足或被拒绝生成: {quota_reason}", **updates)
            _close_task_browser(task_id)
            return True
        failure_reason = parsed.get("failure_reason", "")
        if failure_reason:
            _fail_task(task_id, failure_reason, **updates)
            _close_task_browser(task_id)
            return True
        _set_task(
            task_id,
            **_task_update_payload(updates, "status", "error", "fail_reason"),
            status="collectable",
            error="",
            fail_reason="任务浏览器会话内暂未读取到视频地址，请确认 Dola 页面视频已完成后再点手动采集。",
        )
        _sync_task_db_status(task_id, "collectable")
        return False
    except Exception as e:  # noqa: BLE001
        _set_task(
            task_id,
            status="collectable",
            error="",
            fail_reason=f"任务浏览器会话采集失败: {e}",
            progress=90,
        )
        _sync_task_db_status(task_id, "collectable")
        return False


def _reopen_account_browser_and_collect(task_id: str, conversation_id: str) -> bool:
    task = _get_task(task_id)
    conv = _clean_str(conversation_id)
    if not conv:
        return False
    account_env_file = _clean_str(task.get("account_env_file"))
    account_profile_dir = _clean_str(task.get("account_profile_dir"))
    # 优先使用任务专属 profile（创建任务时从账号 profile 复制而来），
    # 它保留了任务提交时的完整登录态，比重新从账号 profile 打开更可靠。
    task_profile_dir = _clean_str(task.get("browser_profile_dir")) or account_profile_dir
    if not account_env_file and not task_profile_dir:
        return False
    page_url = _clean_str(task.get("page_url")) or f"https://www.dola.com/chat/{conv}"
    try:
        _set_task(task_id, status="collecting", progress=30, error="", fail_reason="正在重新打开账号会话采集 Dola 结果...")
        result = open_account_browser(
            profile_dir=task_profile_dir,
            env_file=account_env_file,
            wait_ms=8000,
            url=page_url,
            persistent=True,
        )
        account_payload = {"env_file": account_env_file, "profile_dir": task_profile_dir}
        remember_browser_session_for_conversation(conv, result, account_payload)
        try:
            browser_port = int(result.get("port") or 0)
        except (TypeError, ValueError):
            browser_port = 0
        if not browser_port or not _wait_chrome_debug_port(browser_port, timeout=12):
            _set_task(
                task_id,
                status="collectable",
                progress=90,
                error="",
                fail_reason="已重新打开 Dola 会话，但浏览器调试端口暂未就绪，请稍后再采集。",
            )
            _sync_task_db_status(task_id, "collectable")
            return False
        _set_task(
            task_id,
            browser_port=browser_port,
            browser_pid=int(result.get("pid") or 0),
            browser_profile_dir=_clean_str(result.get("profile_dir")) or account_profile_dir,
            browser_base_profile_dir=_clean_str(result.get("base_profile_dir")) or _clean_str(result.get("profile_dir")) or account_profile_dir,
            page_url=page_url,
        )
        return _collect_task_result_browser_context(task_id, conv)
    except Exception as e:  # noqa: BLE001
        _set_task(
            task_id,
            status="collectable",
            progress=90,
            error="",
            fail_reason=f"重新打开账号会话采集失败: {e}",
        )
        _sync_task_db_status(task_id, "collectable")
        return False


def collect_task(task_id: str = "", conversation_id: str = "", account: dict | None = None) -> dict:
    task = _get_task(task_id) if task_id else {}
    conv = _clean_str(conversation_id) or _clean_str(task.get("conversation_id"))
    if not conv:
        raise DolaError("缺少 conversation_id，无法采集")
    account_env_file = _clean_str(account.get("env_file") if account else "") or _clean_str(task.get("account_env_file"))
    account_profile_dir = _clean_str(account.get("profile_dir") if account else "") or _clean_str(task.get("account_profile_dir"))
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
            unwatermarked_url="",
            cici_url="",
            local_path="",
            error="",
            fail_reason="",
            output="",
            account_env_file=account_env_file,
            account_profile_dir=account_profile_dir,
            created_at=time.time(),
        )
        task = _get_task(task_id)

    with _task_lock:
        if task_id in _active_collect_tasks:
            current = dict(_task_cache.get(task_id, task))
            current.update({
                "status": "collecting",
                "fail_reason": "该任务正在采集中，请等待本轮采集结束。",
                "updated_at": time.time(),
            })
            _task_cache[task_id] = current
            _persist_task_cache()
            return dict(current)
        _active_collect_tasks.add(task_id)

    _set_task(
        task_id,
        status="collecting",
        progress=max(20, int(task.get("progress") or 0) if str(task.get("progress") or "").isdigit() else 20),
        error="",
        fail_reason="正在采集 Dola 视频结果...",
        collect_started_at=time.time(),
    )
    _sync_task_db_status(task_id, "processing")

    def _run_collect() -> None:
        # 同一账号的采集任务串行执行，避免多个浏览器实例争抢同一个 Chrome profile。
        account_id_for_lock = int(account.get("id") or 0) if account else 0
        account_lock = _get_account_collect_lock(account_id_for_lock) if account_id_for_lock else None
        if account_lock:
            with account_lock:
                _do_collect(task_id, conv, env_overrides)
        else:
            _do_collect(task_id, conv, env_overrides)

    def _do_collect(task_id: str, conv: str, env_overrides: dict) -> None:
        # 采集结果优先走浏览器路径（能用页面真实签名参数，更稳定），
        # 浏览器路径都失败时再回退到纯 API 轮询。
        try:
            if _collect_task_result_browser_context(task_id, conv):
                return
            if _reopen_account_browser_and_collect(task_id, conv):
                return
            _poll_task_result(task_id, conv, env_overrides, True)
        finally:
            # 采集结束后统一关闭浏览器，无论成功还是失败
            _close_task_browser(task_id)

    threading.Thread(target=_run_collect, daemon=True).start()
    return _get_task(task_id)


def get_task_status(task_id: str, normalize_failure: bool = True) -> dict:
    task = _get_task(task_id)
    if not task:
        raise DolaError("task not found", status_code=404)
    if normalize_failure and task.get("status") not in ("completed", "failed") and not task.get("video_url") and not task.get("local_path"):
        evidence_text = "\n".join([
            _clean_str(task.get("error")),
            _clean_str(task.get("fail_reason")),
        ])
        failure_reason = _extract_failure_reason(evidence_text)
        if failure_reason:
            try:
                progress = int(task.get("progress") or 100)
            except (TypeError, ValueError):
                progress = 100
            _fail_task(task_id, failure_reason, progress=progress)
            task = _get_task(task_id)
    return task


def list_tasks(limit: int = 100) -> list[dict]:
    with _task_lock:
        changed = False
        repaired_cache: dict[str, dict] = {}
        for key, value in _task_cache.items():
            repaired = _repair_internal_state_error(dict(value))
            repaired_cache[key] = repaired
            changed = changed or repaired != value
        if changed:
            _task_cache.update(repaired_cache)
            _persist_task_cache()
        rows = list(_task_cache.values())
    rows.sort(key=lambda x: float(x.get("created_at") or 0), reverse=True)
    return [dict(row) for row in rows[:limit]]
