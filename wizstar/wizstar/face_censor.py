"""后端角色脸部打码：Python/OpenCV 检测 + Pillow 叠加符号。"""

from __future__ import annotations

import base64
import io
import os
import urllib.parse
from pathlib import Path

import requests

ANIME_CASCADE = "lbpcascade_animeface.xml"
HAAR_CASCADE = "haarcascade_frontalface_default.xml"

DEFAULT_CENSOR_OPTIONS = {
    "scale": 1.7,
    "alpha": 0.6,
    "line_width_factor": 0.03,
    "color": "#ffffff",
    "detect_max_side": 640,
    "upper_region_ratio": 0.45,
    "stages": [
        (ANIME_CASCADE, 1.1, 3),
        (HAAR_CASCADE, 1.1, 3),
        (HAAR_CASCADE, 1.05, 3),
    ],
}

SYMBOL_POINTS = {
    "P1": (-0.96, -0.72),
    "P2": (0.97, -0.65),
    "P3": (0.71, -0.07),
    "P4": (-0.90, -0.16),
    "P5": (-0.52, 0.71),
}
SYMBOL_SEGMENTS = [
    ("P1", "P2"),
    ("P2", "P3"),
    ("P3", "P5"),
    ("P5", "P4"),
    ("P4", "P1"),
    ("P4", "P3"),
    ("P1", "P3"),
]

_CLASSIFIER_CACHE: dict[str, object] = {}


def _imports():
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        from PIL import Image, ImageColor, ImageDraw  # type: ignore
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(
            "后端自动打码依赖未安装，请安装 opencv-python-headless、numpy、Pillow"
        ) from e
    return cv2, np, Image, ImageColor, ImageDraw


def _decode_data_url(data_url: str) -> bytes:
    raw = str(data_url or "").strip()
    if not raw.startswith("data:image/"):
        raise ValueError("不支持的 data-url 图片格式")
    try:
        header, encoded = raw.split(",", 1)
    except ValueError as e:
        raise ValueError("图片 data-url 格式无效") from e
    if ";base64" not in header:
        raise ValueError("data-url 必须是 base64 图片")
    try:
        return base64.b64decode(encoded, validate=True)
    except Exception as e:  # noqa: BLE001
        raise ValueError("图片 data-url base64 解码失败") from e


def _read_source_bytes(src: str = "", file_path: str = "", data_url: str = "") -> bytes:
    if data_url:
        return _decode_data_url(data_url)

    resolved_path = str(file_path or "").strip()
    raw_src = str(src or "").strip()
    if not resolved_path and raw_src and not raw_src.startswith(("http://", "https://", "data:image/")):
        resolved_path = raw_src

    if resolved_path:
        if resolved_path.startswith("file://"):
            try:
                resolved_path = urllib.parse.unquote(urllib.parse.urlparse(resolved_path).path)
            except Exception:  # noqa: BLE001
                resolved_path = resolved_path.replace("file://", "", 1)
        path_obj = Path(os.path.abspath(os.path.expanduser(resolved_path)))
        if not path_obj.is_file():
            raise FileNotFoundError(f"图片文件不存在: {path_obj}")
        return path_obj.read_bytes()

    if raw_src.startswith("data:image/"):
        return _decode_data_url(raw_src)
    if raw_src.startswith(("http://", "https://")):
        resp = requests.get(raw_src, timeout=30)
        resp.raise_for_status()
        return resp.content

    raise ValueError("请提供有效的图片来源")


def _cascade_candidates(name: str, cv2) -> list[Path]:  # noqa: ANN001
    module_dir = Path(__file__).resolve().parent
    repo_root = module_dir.parents[2]
    candidates = []
    if name == HAAR_CASCADE:
        candidates.append(Path(getattr(cv2.data, "haarcascades", "")) / HAAR_CASCADE)
    candidates.extend([
        module_dir / "assets" / "cascades" / name,
        repo_root / "src" / "assets" / "cascades" / name,
    ])
    return [path for path in candidates if str(path)]


def _load_classifier(name: str):
    cached = _CLASSIFIER_CACHE.get(name)
    if cached is not None:
        return cached
    cv2, *_ = _imports()
    for path in _cascade_candidates(name, cv2):
        if not path.is_file():
            continue
        classifier = cv2.CascadeClassifier(str(path))
        if classifier.empty():
            continue
        _CLASSIFIER_CACHE[name] = classifier
        return classifier
    raise FileNotFoundError(f"未找到可用的人脸级联模型: {name}")


def _filter_and_dedup(boxes: list[dict[str, float]], full_h: int, opts: dict) -> list[dict[str, float]]:
    upper = [b for b in boxes if b["y"] + b["height"] / 2 < full_h * float(opts["upper_region_ratio"])]
    upper.sort(key=lambda item: item["width"] * item["height"], reverse=True)
    kept: list[dict[str, float]] = []
    for box in upper:
        overlapped = False
        for existing in kept:
            ix = max(
                0.0,
                min(box["x"] + box["width"], existing["x"] + existing["width"]) - max(box["x"], existing["x"]),
            )
            iy = max(
                0.0,
                min(box["y"] + box["height"], existing["y"] + existing["height"]) - max(box["y"], existing["y"]),
            )
            if ix * iy > 0.3 * box["width"] * box["height"]:
                overlapped = True
                break
        if not overlapped:
            kept.append(box)
    return kept


def _run_one_cascade(gray, inv_scale: float, cascade_name: str, scale_factor: float, min_neighbors: int):
    cv2, *_ = _imports()
    min_side = max(20, round(min(gray.shape[1], gray.shape[0]) * 0.05))
    classifier = _load_classifier(cascade_name)
    rects = classifier.detectMultiScale(
        gray,
        scaleFactor=float(scale_factor),
        minNeighbors=int(min_neighbors),
        minSize=(min_side, min_side),
    )
    boxes: list[dict[str, float]] = []
    for rect in rects:
        x, y, width, height = rect
        boxes.append({
            "x": float(x) * inv_scale,
            "y": float(y) * inv_scale,
            "width": float(width) * inv_scale,
            "height": float(height) * inv_scale,
        })
    return boxes


def _detect_faces(image, opts: dict) -> list[dict[str, float]]:
    cv2, np, Image, *_ = _imports()
    width, height = image.size
    scale = min(1.0, float(opts["detect_max_side"]) / float(max(width, height)))
    det_w = max(1, round(width * scale))
    det_h = max(1, round(height * scale))
    resample = getattr(Image, "Resampling", Image).BILINEAR
    det_img = image.resize((det_w, det_h), resample)
    gray = cv2.cvtColor(np.array(det_img), cv2.COLOR_RGB2GRAY)
    gray = cv2.equalizeHist(gray)
    for cascade_name, scale_factor, min_neighbors in opts["stages"]:
        boxes = _run_one_cascade(gray, 1.0 / scale, cascade_name, scale_factor, min_neighbors)
        kept = _filter_and_dedup(boxes, height, opts)
        if kept:
            return kept
    return []


def _color_to_rgba(color: str, alpha: float, image_color) -> tuple[int, int, int, int]:  # noqa: ANN001
    rgb = image_color.getrgb(color or "#ffffff")
    return int(rgb[0]), int(rgb[1]), int(rgb[2]), max(0, min(255, round(255 * alpha)))


def _draw_symbol(image, cx: float, cy: float, half: float, opts: dict):
    _, _, _, image_color, image_draw = _imports()
    overlay = image_draw.Draw(image, "RGBA")
    line_width = max(2, round(half * float(opts["line_width_factor"])))
    shadow_width = max(1, round(line_width * 0.8))
    stroke = _color_to_rgba(str(opts["color"]), float(opts["alpha"]), image_color)
    shadow = (0, 0, 0, max(30, round(stroke[3] * 0.55)))

    def pt(key: str) -> tuple[float, float]:
        base = SYMBOL_POINTS[key]
        return cx + base[0] * half, cy + base[1] * half

    for start, end in SYMBOL_SEGMENTS:
        p1 = pt(start)
        p2 = pt(end)
        overlay.line((p1[0] + 1, p1[1] + 1, p2[0] + 1, p2[1] + 1), fill=shadow, width=shadow_width)
        overlay.line((p1[0], p1[1], p2[0], p2[1]), fill=stroke, width=line_width)


def _draw_symbols_on_faces(image, faces: list[dict[str, float]], opts: dict):
    for face in faces:
        cx = float(face["x"]) + float(face["width"]) / 2.0
        cy = float(face["y"]) + float(face["height"]) / 2.0
        half = max(float(face["width"]), float(face["height"])) * float(opts["scale"]) / 2.0
        _draw_symbol(image, cx, cy, half, opts)


def censor_image(src: str = "", file_path: str = "", data_url: str = "", user_opts: dict | None = None) -> dict:
    _, _, Image, _, _ = _imports()
    opts = {**DEFAULT_CENSOR_OPTIONS, **(user_opts or {})}
    raw_bytes = _read_source_bytes(src=src, file_path=file_path, data_url=data_url)
    image = Image.open(io.BytesIO(raw_bytes)).convert("RGBA")
    rgb_image = image.convert("RGB")
    width, height = rgb_image.size
    if not width or not height:
        raise ValueError("图片尺寸无效")

    faces = _detect_faces(rgb_image, opts)
    result = image.copy()
    if faces:
        _draw_symbols_on_faces(result, faces, opts)

    output = io.BytesIO()
    result.save(output, format="PNG")
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return {
        "data_url": f"data:image/png;base64,{encoded}",
        "face_count": len(faces),
        "width": width,
        "height": height,
        "backend": "python-opencv",
    }
