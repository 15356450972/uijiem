"""insMind 渠道十二桥接层。

协议细节留在 `insmind-sdk`，本模块只负责：
  - 解析 SDK 路径（开发 / PyInstaller / Nuitka）
  - 账号池选取
  - 把本地服务的任务接口映射为统一「提交 / 查询状态」生命周期
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any, Optional

from .app_paths import get_wizstar_data_dir


def _resolve_repo_root() -> Path:
    """开发态：仓库根；冻结态：可执行文件旁 / _MEIPASS。"""
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def _resolve_sdk_root() -> Path:
    env = (os.environ.get("INSMIND_SDK_DIR") or "").strip()
    if env:
        path = Path(env).expanduser()
        if path.is_dir() and (path / "insmind").is_dir():
            return path
    repo = _resolve_repo_root()
    candidates = [
        repo / "insmind-sdk",
        Path(sys.executable).resolve().parent / "insmind-sdk",
        Path(sys.executable).resolve().parent.parent / "insmind-sdk",
        Path(__file__).resolve().parents[2] / "insmind-sdk",
    ]
    for path in candidates:
        if path.is_dir() and (path / "insmind").is_dir():
            return path
    return repo / "insmind-sdk"


_REPO_ROOT = _resolve_repo_root()
_SDK_ROOT = _resolve_sdk_root()
if str(_SDK_ROOT) not in sys.path:
    sys.path.insert(0, str(_SDK_ROOT))

from insmind import InsMindClient, register_account  # noqa: E402
from insmind import http as insmind_http  # noqa: E402

MODEL = "insMind Seedance 2.0 Mini"
DEFAULT_RESOLUTION = "480P"
DEFAULT_DURATION = "5"
DEFAULT_RATIO = "original"

# 活动免费 SKU（activity-skus）实测矩阵 —— omni_reference
# duration5 + 480P/720P；duration10/15 仅 480P
INSMIND_DURATION_OPTIONS = (5, 10, 15)
INSMIND_RESOLUTION_OPTIONS = ("480P", "720P")
INSMIND_VALID_OMNI = {
    5: ("480P", "720P"),
    10: ("480P",),
    15: ("480P",),
}

# 动态代理默认（凭据走本地 insmind_config.json，勿提交明文账号）
CONFIG_PATH = os.path.join(get_wizstar_data_dir(), "insmind_config.json")
_PROXY_DEFAULTS = {
    "use_proxy": True,
    "proxy_host": "us.ipwo.net",
    "proxy_port": 7878,
    "proxy_user": "",
    "proxy_pass": "",
}


class InsMindError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


# ====================== 代理配置 ======================


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def get_proxy_settings() -> dict:
    """合并默认值与本地配置。"""
    cfg = _load_config()
    merged = dict(_PROXY_DEFAULTS)
    for key in ("proxy_host", "proxy_port", "proxy_user", "proxy_pass"):
        if cfg.get(key) not in (None, ""):
            merged[key] = cfg[key]
    if "use_proxy" in cfg:
        merged["use_proxy"] = bool(cfg.get("use_proxy"))
    try:
        merged["proxy_port"] = int(merged.get("proxy_port") or 7878)
    except (TypeError, ValueError):
        merged["proxy_port"] = 7878
    merged["proxy_host"] = str(merged.get("proxy_host") or "").strip()
    merged["proxy_user"] = str(merged.get("proxy_user") or "").strip()
    merged["proxy_pass"] = str(merged.get("proxy_pass") or "")
    merged["proxy_url"] = ""
    if merged["use_proxy"] and merged["proxy_host"]:
        merged["proxy_url"] = insmind_http.build_proxy_url(
            merged["proxy_host"],
            merged["proxy_port"],
            merged["proxy_user"],
            merged["proxy_pass"],
        )
    return merged


def save_config(
    use_proxy: Optional[bool] = None,
    proxy_host: Optional[str] = None,
    proxy_port: Optional[int] = None,
    proxy_user: Optional[str] = None,
    proxy_pass: Optional[str] = None,
) -> dict:
    """保存代理配置（仅更新传入的非 None 字段）。"""
    config = _load_config()
    if use_proxy is not None:
        config["use_proxy"] = bool(use_proxy)
    if proxy_host is not None:
        config["proxy_host"] = str(proxy_host).strip()
    if proxy_port is not None:
        config["proxy_port"] = int(proxy_port)
    if proxy_user is not None:
        config["proxy_user"] = str(proxy_user).strip()
    if proxy_pass is not None:
        config["proxy_pass"] = str(proxy_pass)
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    apply_proxy_settings()
    return get_proxy_settings()


def apply_proxy_settings() -> dict:
    """把当前设置注入 SDK HTTP 层。"""
    settings = get_proxy_settings()
    if settings.get("use_proxy") and settings.get("proxy_url"):
        insmind_http.set_proxy(settings["proxy_url"])
    else:
        insmind_http.set_proxy("")
    return settings


def config_status() -> dict:
    """供前端展示（密码脱敏）。"""
    settings = get_proxy_settings()
    password = settings.get("proxy_pass") or ""
    return {
        "use_proxy": bool(settings.get("use_proxy")),
        "proxy_host": settings.get("proxy_host") or "",
        "proxy_port": int(settings.get("proxy_port") or 7878),
        "proxy_user": settings.get("proxy_user") or "",
        "proxy_pass": password,
        "proxy_pass_set": bool(password),
        "proxy_url_configured": bool(settings.get("proxy_url")),
        "hint": "开启后注册走动态 IP，可缓解 UMS 发码 IP 限流（1001012）",
    }


def test_proxy() -> dict:
    """测动态代理出口 IP（注册前自检）。"""
    settings = apply_proxy_settings()
    result = {
        "use_proxy": bool(settings.get("use_proxy")),
        "proxy_host": settings.get("proxy_host") or "",
        "proxy_port": int(settings.get("proxy_port") or 7878),
        "proxy_user": settings.get("proxy_user") or "",
        "ok": False,
        "exit_ip": "",
        "message": "",
    }
    if not settings.get("use_proxy"):
        result["message"] = "未开启动态代理（当前直连）"
        try:
            with urllib.request.urlopen("https://api.ipify.org?format=json", timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8", "ignore") or "{}")
            result["exit_ip"] = str(data.get("ip") or "")
            result["ok"] = True
            result["message"] = f"直连出口 IP: {result['exit_ip']}"
        except Exception as error:  # noqa: BLE001
            result["message"] = f"直连探测失败: {error}"
        return result

    if not settings.get("proxy_url"):
        result["message"] = "代理主机未配置"
        return result

    try:
        # 走 SDK 同源代理栈，避免测试与注册行为不一致
        probe = insmind_http.request("https://api.ipify.org?format=json", timeout=25)
        payload = probe.get("json") or {}
        exit_ip = str(payload.get("ip") or "").strip()
        if probe.get("status") != 200 or not exit_ip:
            result["message"] = f"代理探测失败: HTTP {probe.get('status')} {str(probe.get('text') or '')[:160]}"
            return result
        result["ok"] = True
        result["exit_ip"] = exit_ip
        result["message"] = f"动态代理出口 IP: {exit_ip}"
        return result
    except Exception as error:  # noqa: BLE001
        result["message"] = f"代理探测失败: {error}"
        return result


def _env_account() -> dict:
    """环境变量 / 本地 json 兜底账号（无 DB 时仍可用）。"""
    candidates = [
        Path(os.environ.get("INSMIND_ACCOUNT", "")).expanduser(),
        _SDK_ROOT / "insmind_account.json",
        _REPO_ROOT / "insmind_account.json",
        Path(__file__).resolve().parents[2] / "insmind_account.json",
    ]
    for path in candidates:
        if not str(path) or not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and (data.get("access_token") or data.get("token")):
            return {
                "id": 0,
                "email": data.get("email") or "insMind-env",
                "access_token": (data.get("access_token") or data.get("token") or "").strip(),
                "cookie": (data.get("cookie") or "").strip(),
                "user_id": str(data.get("user_id") or ""),
                "org_id": str(data.get("org_id") or ""),
                "status": "active",
            }
    token = (os.environ.get("INSMIND_TOKEN") or "").strip()
    if token:
        return {
            "id": 0,
            "email": "insMind-env",
            "access_token": token,
            "cookie": (os.environ.get("INSMIND_COOKIE") or "").strip(),
            "user_id": "",
            "org_id": "",
            "status": "active",
        }
    return {}


def has_valid_token(account: dict | None) -> bool:
    if not account:
        return False
    if str(account.get("status") or "active").lower() not in {"active", ""}:
        return False
    return bool(str(account.get("access_token") or "").strip())


def pick_account(account_id: int = 0) -> dict:
    """从账号池选取可用账号；无库账号时回退 env/json。"""
    from .database import InsmindAccountDB, TaskDB

    try:
        if account_id:
            account = InsmindAccountDB.get(int(account_id))
            if not account:
                raise InsMindError("渠道十二账号不存在", status_code=404)
            if not has_valid_token(account):
                raise InsMindError("渠道十二账号登录态无效")
            return account

        candidates = [
            account
            for account in InsmindAccountDB.list_all_internal()
            if has_valid_token(account)
        ]
        if candidates:
            candidates.sort(
                key=lambda account: (
                    TaskDB.active_count_for_account(
                        int(account.get("id") or 0),
                        model_prefix="insmind:",
                    ),
                    str(account.get("updated_at") or ""),
                )
            )
            return candidates[0]
    except InsMindError:
        raise
    except Exception:
        # 表未建 / DB 暂不可用时，继续走 env/json 兜底
        pass

    fallback = _env_account()
    if has_valid_token(fallback):
        return fallback
    raise InsMindError("渠道十二没有可用账号，请先在设置/账号池注册或导入 token", status_code=400)


def client_from_account(account: dict) -> InsMindClient:
    token = str(account.get("access_token") or "").strip()
    if not token:
        raise InsMindError("渠道十二账号缺少 access_token")
    return InsMindClient(
        token,
        cookie=str(account.get("cookie") or "").strip() or None,
        user_id=str(account.get("user_id") or "") or None,
        auto_ensure_tenant=False,
    )


def client(account_id: int = 0) -> InsMindClient:
    return client_from_account(pick_account(account_id))


def configured() -> bool:
    try:
        pick_account(0)
        return True
    except InsMindError:
        return False


def register_one(*, max_wait: int = 90) -> dict:
    """调用 SDK 邮箱验证码注册（GPTMail），返回含 token 的账号 dict。"""
    proxy = apply_proxy_settings()
    try:
        result = register_account(bind_tenant=True, max_wait=max_wait)
    except Exception as error:  # noqa: BLE001
        suffix = ""
        if proxy.get("use_proxy") and proxy.get("proxy_url"):
            suffix = f"（已走动态代理 {proxy.get('proxy_host')}:{proxy.get('proxy_port')}）"
        elif proxy.get("use_proxy"):
            suffix = "（已开启代理但主机为空）"
        else:
            suffix = "（当前直连，易触发 IP 发码限流）"
        print(f"[insmind-register] FAIL {type(error).__name__}: {error}{suffix}", flush=True)
        raise InsMindError(f"渠道十二注册失败: {error}{suffix}") from error
    if not result.get("access_token"):
        print("[insmind-register] FAIL missing access_token", flush=True)
        raise InsMindError("渠道十二注册未返回 access_token")
    print(
        f"[insmind-register] OK email={result.get('email') or ''} "
        f"org={result.get('org_id') or ''}",
        flush=True,
    )
    expires_raw = result.get("access_token_expires_at") or 0
    try:
        expires_at = int(float(expires_raw or 0))
    except (TypeError, ValueError):
        expires_at = 0
    # SDK 可能给秒；统一存毫秒若数值看起来像秒
    if 0 < expires_at < 10_000_000_000:
        expires_at *= 1000
    return {
        "email": result.get("email") or "",
        "access_token": result.get("access_token") or "",
        "refresh_token": result.get("refresh_token") or "",
        "cookie": result.get("cookie") or "",
        "expires_at": expires_at,
        "user_id": str(result.get("user_id") or ""),
        "org_id": str(result.get("org_id") or ""),
        "raw": result,
    }


def normalize_params(
    *,
    duration: Any = DEFAULT_DURATION,
    resolution: str = DEFAULT_RESOLUTION,
    ratio: str = DEFAULT_RATIO,
) -> dict[str, str]:
    """对齐官方活动 SKU：时长仅 5/10/15，720P 仅 5 秒，无 1080P。"""
    try:
        seconds = int(float(duration))
    except (TypeError, ValueError):
        seconds = int(DEFAULT_DURATION)
    # 吸附到最近合法时长
    seconds = min(INSMIND_DURATION_OPTIONS, key=lambda value: abs(value - seconds))

    raw = str(resolution or DEFAULT_RESOLUTION).upper().replace(" ", "")
    if raw in {"480", "480P"}:
        normalized_resolution = "480P"
    elif raw in {"720", "720P"}:
        normalized_resolution = "720P"
    elif raw in {"1080", "1080P"}:
        # 免费 SKU 无 1080P，降到 720P（再由时长约束可能再降到 480P）
        normalized_resolution = "720P"
    else:
        normalized_resolution = DEFAULT_RESOLUTION

    allowed_resolutions = INSMIND_VALID_OMNI.get(seconds) or (DEFAULT_RESOLUTION,)
    if normalized_resolution not in allowed_resolutions:
        # 优先保留时长，分辨率降到该时长允许的最高档
        normalized_resolution = allowed_resolutions[-1] if allowed_resolutions else DEFAULT_RESOLUTION

    normalized_ratio = str(ratio or DEFAULT_RATIO)
    if normalized_ratio not in {"original", "16:9", "9:16", "1:1"}:
        normalized_ratio = DEFAULT_RATIO
    return {
        "duration": str(seconds),
        "resolution": normalized_resolution,
        "ratio": normalized_ratio,
    }


def create_task(
    *,
    prompt: str,
    image_paths: list[str],
    image_urls: list[str],
    duration: Any,
    resolution: str,
    ratio: str,
    account_id: int = 0,
) -> dict:
    account = pick_account(account_id)
    params = normalize_params(duration=duration, resolution=resolution, ratio=ratio)
    sdk = client_from_account(account)
    urls = list(image_urls)
    local_paths: list[str] = []
    for image_path in image_paths:
        if image_path.startswith(("http://", "https://")):
            urls.append(image_path)
        else:
            local_paths.append(image_path)
    for image_path in local_paths:
        if image_path and Path(image_path).is_file():
            uploaded = sdk.upload_file(image_path)
            if uploaded.get("url"):
                urls.append(uploaded["url"])
    if not urls:
        raise InsMindError("渠道十二需要至少一张有效垫图", status_code=400)
    prompt_text = (prompt or "").strip()
    if "[image" not in prompt_text:
        prompt_text = " ".join(f"[image{i + 1}]" for i in range(len(urls))) + " " + prompt_text
    result = sdk.generate_omni(
        prompt=prompt_text,
        image_urls=urls,
        resolution=params["resolution"],
        duration=params["duration"],
        ratio=params["ratio"],
        wait=False,
    )
    return {
        "task_id": result["task_id"],
        "status": "processing",
        "account_id": int(account.get("id") or 0),
        "account_name": account.get("email") or "insMind",
    }


def get_status(task_id: str, account_id: int = 0) -> dict:
    from .database import InsmindAccountDB

    account = None
    if account_id:
        try:
            bound = InsmindAccountDB.get(int(account_id))
            if bound and has_valid_token(bound):
                account = bound
        except Exception:
            account = None
    if account is None:
        account = pick_account(0)
    result = client_from_account(account).process_batch([task_id])
    if not result:
        return {
            "status": "processing",
            "video_url": "",
            "error": "",
            "account_id": int(account.get("id") or 0),
            "account_name": account.get("email") or "insMind",
        }
    parsed = InsMindClient.parse_process_result(result[0])
    if parsed.get("error"):
        return {
            "status": "failed",
            "video_url": "",
            "error": parsed.get("message") or "insMind 生成失败",
            "account_id": int(account.get("id") or 0),
            "account_name": account.get("email") or "insMind",
        }
    return {
        "status": "completed" if parsed.get("done") else "processing",
        "video_url": parsed.get("video_url") or "",
        "error": "",
        "account_id": int(account.get("id") or 0),
        "account_name": account.get("email") or "insMind",
    }