"""UMS 图形验证码：SVG → PNG → YesCaptcha OCR。"""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from . import constants as C
from .http import request

# 验证码只需 SVG→PNG，默认不起浏览器：macOS 用 qlmanage（~0.1s）。
# Chrome 仅当 INSMIND_CAPTCHA_ALLOW_CHROME=1 时作兜底（高并发易 exit 21）。
_RENDER_SEM = threading.Semaphore(int(os.environ.get("INSMIND_CAPTCHA_RENDER_CONCURRENCY") or "4"))
_RENDER_RETRIES = max(1, int(os.environ.get("INSMIND_CAPTCHA_RENDER_RETRIES") or "3"))
_ALLOW_CHROME = (os.environ.get("INSMIND_CAPTCHA_ALLOW_CHROME") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def load_yescap_key() -> str:
    env_key = (os.environ.get("YESCAP_KEY") or os.environ.get("YESCAPTCHA_KEY") or "").strip()
    if env_key:
        return env_key
    root = Path(__file__).resolve().parents[2]
    candidates = [
        root / "quickframe-sdk-full" / "_yescap_key.txt",
        root / "insmind-sdk" / "_yescap_key.txt",
        Path.cwd() / "_yescap_key.txt",
    ]
    for path in candidates:
        if path.is_file():
            key = path.read_text(encoding="utf-8").strip()
            if key:
                return key
    raise RuntimeError("YesCaptcha key missing (YESCAP_KEY or _yescap_key.txt)")


def fetch_capcha_svg(email: str) -> bytes:
    result = request(
        f"{C.UMS_HOST}/api/capcha",
        method="POST",
        headers={
            "Accept": "image/svg+xml,application/json,*/*",
            "Origin": C.UMS_HOST,
            "Referer": f"{C.UMS_HOST}/cgi-bin?biz_code={C.BIZ_CODE}&appid={C.CLIENT_ID}",
            "x-biz-code": C.BIZ_CODE,
            "x-region-id": C.REGION_ID,
            "x-endpoint": C.ENDPOINT,
        },
        body={"channel": "email", "email": email.strip().lower()},
        form=True,
        timeout=20,
    )
    raw = result.get("text") or ""
    if result["status"] != 200 or "<svg" not in raw:
        raise RuntimeError(f"fetch captcha failed: {result['status']} {raw[:200]}")
    return raw.encode("utf-8")


def _read_png_if_ok(path: Path) -> bytes | None:
    try:
        if path.is_file() and path.stat().st_size > 0:
            return path.read_bytes()
    except OSError:
        return None
    return None


def _qlmanage_to_png(svg_path: Path, work_dir: Path) -> bytes | None:
    """macOS 系统预览，轻量且并发友好（~0.1s）。"""
    qlmanage = shutil.which("qlmanage")
    if not qlmanage:
        return None
    try:
        subprocess.run(
            [qlmanage, "-t", "-s", "400", "-o", str(work_dir), str(svg_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    return _read_png_if_ok(work_dir / "cap.svg.png")


def _chrome_to_png(html_path: Path, png_path: Path, work_dir: Path) -> bytes | None:
    chrome = os.environ.get("CHROME_PATH") or (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
    if not Path(chrome).exists():
        return None

    # 独立 profile，避免与桌面 Chrome / 其它 headless 抢默认目录
    user_data = work_dir / "chrome-profile"
    user_data.mkdir(parents=True, exist_ok=True)
    crash_dumps = work_dir / "chrome-crashes"
    crash_dumps.mkdir(parents=True, exist_ok=True)

    cmd = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--hide-scrollbars",
        "--mute-audio",
        f"--user-data-dir={user_data}",
        f"--crash-dumps-dir={crash_dumps}",
        f"--screenshot={png_path}",
        "--window-size=300,120",
        html_path.as_uri(),
    ]
    try:
        # stderr 丢弃，避免 PIPE 塞满导致假死
        proc = subprocess.run(
            cmd,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"[insmind-captcha] chrome render timeout/oserr: {exc}", flush=True)
        return None

    data = _read_png_if_ok(png_path)
    if data:
        return data
    if proc.returncode not in (0, None):
        print(
            f"[insmind-captcha] chrome render failed code={proc.returncode}",
            flush=True,
        )
    return None


def svg_to_png(svg_bytes: bytes) -> bytes:
    """SVG → PNG。默认无浏览器（qlmanage）；可选 Chrome 兜底。"""
    last_err = "unable to render captcha SVG to PNG (need qlmanage; or set INSMIND_CAPTCHA_ALLOW_CHROME=1)"
    for attempt in range(1, _RENDER_RETRIES + 1):
        with _RENDER_SEM:
            with tempfile.TemporaryDirectory(prefix="insmind-capcha-") as tmp:
                tmp_path = Path(tmp)
                svg_path = tmp_path / "cap.svg"
                svg_path.write_bytes(svg_bytes)
                data = _qlmanage_to_png(svg_path, tmp_path)
                if data:
                    return data
                if _ALLOW_CHROME:
                    html_path = tmp_path / "cap.html"
                    png_path = tmp_path / "cap.png"
                    html_path.write_text(
                        "<!doctype html><html><body style='margin:0;background:#fff'>"
                        f"<img src='{svg_path.name}' width='300' height='100'></body></html>",
                        encoding="utf-8",
                    )
                    data = _chrome_to_png(html_path, png_path, tmp_path)
                    if data:
                        return data
                last_err = (
                    f"unable to render captcha SVG to PNG "
                    f"(attempt {attempt}/{_RENDER_RETRIES}; chrome={'on' if _ALLOW_CHROME else 'off'})"
                )
        if attempt < _RENDER_RETRIES:
            time.sleep(0.2 * attempt)
    raise RuntimeError(last_err)


def solve_image_captcha(png_bytes: bytes, *, max_wait: int = 60) -> str:
    key = load_yescap_key()
    create = request(
        f"{C.YESCAPTCHA_API}/createTask",
        method="POST",
        body={
            "clientKey": key,
            "task": {
                "type": "ImageToTextTask",
                "body": base64.b64encode(png_bytes).decode("ascii"),
                "case": True,
                "minLength": 4,
                "maxLength": 4,
            },
        },
        timeout=30,
    )
    data = create.get("json") or {}
    if data.get("errorId"):
        raise RuntimeError(f"YesCaptcha createTask failed: {data}")
    if data.get("status") == "ready":
        text = ((data.get("solution") or {}).get("text") or "").strip()
        if text:
            return text
    task_id = data.get("taskId")
    if not task_id:
        raise RuntimeError(f"YesCaptcha missing taskId: {data}")
    deadline = time.time() + max_wait
    while time.time() < deadline:
        time.sleep(2)
        poll = request(
            f"{C.YESCAPTCHA_API}/getTaskResult",
            method="POST",
            body={"clientKey": key, "taskId": task_id},
            timeout=30,
        )
        payload = poll.get("json") or {}
        if payload.get("errorId"):
            raise RuntimeError(f"YesCaptcha getTaskResult failed: {payload}")
        if payload.get("status") == "ready":
            text = ((payload.get("solution") or {}).get("text") or "").strip()
            if not text:
                raise RuntimeError(f"YesCaptcha empty solution: {payload}")
            return text
    raise TimeoutError("YesCaptcha OCR timeout")