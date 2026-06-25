// 角色一键打码：浏览器端用 OpenCV.js 自动识别人脸，再在脸上叠加一个
// 半透明白色几何符号（用户手绘的折角图形）。不做马赛克，不遮挡脸部，
// 仅叠加细线条标记。详见角色资产管理器里的「一键打码」入口。
//
// 关键技术点：
// - opencv.js（含 objdetect/CascadeClassifier，OpenCV 3.3 预编译版）通过
//   <script> 注入加载，wasm 已内嵌在单文件里，可离线使用。
// - 动漫脸用 lbpcascade_animeface，真人脸用 haarcascade_frontalface 兜底，
//   两个模型结果合并，过滤掉画面下半部（肚子等）的误检，再做简单 NMS 去重。

import cvScriptUrl from 'opencv.js?url';
import animeCascadeUrl from '../assets/cascades/lbpcascade_animeface.xml?url';
import haarCascadeUrl from '../assets/cascades/haarcascade_frontalface_default.xml?url';
import { WIZSTAR_API } from '../config';

const ANIME_CASCADE = 'lbpcascade_animeface.xml';
const HAAR_CASCADE = 'haarcascade_frontalface_default.xml';

// 用户手绘符号的归一化顶点（以符号中心为原点，半尺寸=1 缩放）。
const SYMBOL_POINTS = {
  P1: [-0.96, -0.72],
  P2: [0.97, -0.65],
  P3: [0.71, -0.07],
  P4: [-0.90, -0.16],
  P5: [-0.52, 0.71],
};
const SYMBOL_SEGMENTS = [
  ['P1', 'P2'],
  ['P2', 'P3'],
  ['P3', 'P5'],
  ['P5', 'P4'],
  ['P4', 'P1'],
  ['P4', 'P3'],
  ['P1', 'P3'],
];

export const DEFAULT_CENSOR_OPTIONS = {
  scale: 1.7, // 符号相对人脸框的放大倍数
  alpha: 0.6, // 半透明度（0~1），越小越透，越不影响脸
  lineWidthFactor: 0.03, // 线宽相对符号半尺寸
  color: '#ffffff',
  detectMaxSide: 640, // 检测前把长边缩到这个尺寸，加速
  upperRegionRatio: 0.45, // 只保留中心落在画面上半部分(<H*ratio)的人脸框
  // 分阶段检测：按顺序尝试，命中即停。动漫模型(LBP)很快，真人模型(haar)较慢。
  // 每阶段 = [级联文件, scaleFactor, minNeighbors]
  stages: [
    [ANIME_CASCADE, 1.1, 3], // 1) 动漫脸快扫（最快）
    [HAAR_CASCADE, 1.1, 3], //  2) 真人脸快扫
    [HAAR_CASCADE, 1.05, 3], // 3) 真人脸细扫（慢，兜底）
  ],
};

let _cvPromise = null;
let _cascadesReady = false;

function pollUntilReady(resolve, reject) {
  let tries = 0;
  const timer = setInterval(() => {
    const cv = window.cv;
    if (cv && cv.Mat && cv.CascadeClassifier) {
      try {
        const probe = new cv.Mat();
        probe.delete();
        clearInterval(timer);
        resolve(cv);
        return;
      } catch (e) {
        /* 运行时还没就绪，继续等 */
      }
    }
    if (++tries > 600) {
      clearInterval(timer);
      reject(new Error('OpenCV 初始化超时'));
    }
  }, 100);
}

// 注入 opencv.js 脚本并等待运行时就绪。
export function loadOpenCV() {
  if (window.cv && window.cv.Mat && window.cv.CascadeClassifier) {
    return Promise.resolve(window.cv);
  }
  if (_cvPromise) return _cvPromise;
  _cvPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById('opencv-js-script');
    if (existing) {
      pollUntilReady(resolve, reject);
      return;
    }
    const script = document.createElement('script');
    script.id = 'opencv-js-script';
    script.async = true;
    script.src = cvScriptUrl;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    console.log('[faceCensor] 开始加载 OpenCV…');
    script.onload = () => pollUntilReady(
      (cv) => {
        const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        console.log(`[faceCensor] OpenCV 就绪，用时 ${ms}ms`);
        resolve(cv);
      },
      reject,
    );
    script.onerror = () => {
      _cvPromise = null;
      reject(new Error('OpenCV 脚本加载失败'));
    };
    document.head.appendChild(script);
  });
  return _cvPromise;
}

async function writeCascadeFile(cv, name, url) {
  try {
    cv.FS_stat(name);
    return; // 已存在
  } catch (e) {
    /* 不存在，下面写入 */
  }
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  try {
    cv.FS_createDataFile('/', name, buf, true, false, false);
  } catch (e) {
    /* 并发写入时可能已存在，忽略 */
  }
}

async function ensureCascades(cv) {
  if (_cascadesReady) return;
  await Promise.all([
    writeCascadeFile(cv, ANIME_CASCADE, animeCascadeUrl),
    writeCascadeFile(cv, HAAR_CASCADE, haarCascadeUrl),
  ]);
  _cascadesReady = true;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('图片为空'));
      return;
    }
    const img = new Image();
    if (/^https?:\/\//i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

function runOneCascade(cv, gray, invScale, cascadeName, scaleFactor, minNeighbors) {
  const minSide = Math.max(20, Math.round(Math.min(gray.cols, gray.rows) * 0.05));
  const boxes = [];
  const classifier = new cv.CascadeClassifier();
  classifier.load(cascadeName);
  const rects = new cv.RectVector();
  const minSize = new cv.Size(minSide, minSide);
  const maxSize = new cv.Size(0, 0);
  try {
    classifier.detectMultiScale(gray, rects, scaleFactor, minNeighbors, 0, minSize, maxSize);
    for (let i = 0; i < rects.size(); i++) {
      const r = rects.get(i);
      boxes.push({
        x: r.x * invScale,
        y: r.y * invScale,
        width: r.width * invScale,
        height: r.height * invScale,
      });
    }
  } catch (e) {
    /* 单个模型异常不影响整体 */
  } finally {
    rects.delete();
    classifier.delete();
  }
  return boxes;
}

function filterAndDedup(boxes, fullH, opts) {
  // 只保留人脸中心位于画面上半部分的框，过滤肚子/躯干等误检。
  const upper = boxes.filter((b) => b.y + b.height / 2 < fullH * opts.upperRegionRatio);
  // 简单 NMS：优先保留大框，丢弃与已保留框重叠较多的小框。
  upper.sort((a, b) => b.width * b.height - a.width * a.height);
  const kept = [];
  for (const b of upper) {
    const overlapped = kept.some((k) => {
      const ix = Math.max(0, Math.min(b.x + b.width, k.x + k.width) - Math.max(b.x, k.x));
      const iy = Math.max(0, Math.min(b.y + b.height, k.y + k.height) - Math.max(b.y, k.y));
      return ix * iy > 0.3 * b.width * b.height;
    });
    if (!overlapped) kept.push(b);
  }
  return kept;
}

function detectFacesOnGray(cv, gray, fullH, invScale, opts) {
  // 分阶段检测：按顺序尝试，某阶段检测到人脸就停，避免无谓地跑慢模型。
  for (const [cascadeName, scaleFactor, minNeighbors] of opts.stages) {
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const kept = filterAndDedup(
      runOneCascade(cv, gray, invScale, cascadeName, scaleFactor, minNeighbors),
      fullH,
      opts,
    );
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t);
    console.log(`[faceCensor] 阶段 ${cascadeName.replace('.xml', '')} sf=${scaleFactor} -> ${kept.length} 张, ${ms}ms`);
    if (kept.length) return kept;
  }
  return [];
}

// 在任意 canvas 上下文上，于 (cx, cy) 处按 half(符号半尺寸) 绘制打码符号。
// 自动打码与手动放置共用这一份绘制逻辑，保证形状一致。
export function drawSymbol(ctx, cx, cy, half, userOpts = {}) {
  const opts = { ...DEFAULT_CENSOR_OPTIONS, ...userOpts };
  const lineWidth = Math.max(1.5, half * opts.lineWidthFactor);
  const pt = (key) => [cx + SYMBOL_POINTS[key][0] * half, cy + SYMBOL_POINTS[key][1] * half];

  ctx.save();
  ctx.globalAlpha = opts.alpha;
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // 极淡的描边阴影，保证白线在浅色脸上也能看清，但不遮挡脸。
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = lineWidth * 0.8;
  ctx.beginPath();
  for (const [a, b] of SYMBOL_SEGMENTS) {
    const p1 = pt(a);
    const p2 = pt(b);
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
  }
  ctx.stroke();
  ctx.restore();
}

function drawSymbolOnFace(ctx, face, opts) {
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  const half = (Math.max(face.width, face.height) * opts.scale) / 2;
  drawSymbol(ctx, cx, cy, half, opts);
}

function localFilePathFromUrlValue(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    try { return decodeURIComponent(new URL(raw).pathname); } catch (_) { return raw.replace(/^file:\/\/+/, '/'); }
  }
  if (/^\/(?!\/)/.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) return raw;
  return '';
}

async function censorImageSrcInBackend(src, userOpts = {}) {
  const payload = {};
  const raw = String(src || '').trim();
  const localPath = localFilePathFromUrlValue(raw);
  if (userOpts.filePath) payload.file_path = userOpts.filePath;
  else if (localPath) payload.file_path = localPath;
  else if (/^data:image\//i.test(raw)) payload.data_url = raw;
  else payload.src = raw;

  ['scale', 'alpha', 'lineWidthFactor', 'color', 'detectMaxSide', 'upperRegionRatio'].forEach((key) => {
    if (userOpts[key] == null) return;
    const backendKey = ({
      lineWidthFactor: 'line_width_factor',
      detectMaxSide: 'detect_max_side',
      upperRegionRatio: 'upper_region_ratio',
    })[key] || key;
    payload[backendKey] = userOpts[key];
  });

  const res = await fetch(`${WIZSTAR_API}/face-censor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      message = err.detail || err.message || message;
    } catch (_) {}
    throw new Error(message);
  }
  const data = await res.json();
  const payloadData = data.data || {};
  return {
    dataUrl: payloadData.data_url || '',
    faceCount: Number(payloadData.face_count || 0),
    width: Number(payloadData.width || 0),
    height: Number(payloadData.height || 0),
    backend: payloadData.backend || 'python-opencv',
  };
}

// 浏览器兜底：后端不可用时，仍可沿用原来的 OpenCV.js 识别逻辑。
async function censorImageSrcInBrowser(src, userOpts = {}) {
  const opts = { ...DEFAULT_CENSOR_OPTIONS, ...userOpts };
  const tStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const cv = await loadOpenCV();
  await ensureCascades(cv);

  const img = await loadImageElement(src);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error('图片尺寸无效');
  console.log(`[faceCensor] 原图 ${width}x${height}`);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);

  // 检测用缩小图，加速并提升稳定性。
  const scale = Math.min(1, opts.detectMaxSide / Math.max(width, height));
  const detW = Math.max(1, Math.round(width * scale));
  const detH = Math.max(1, Math.round(height * scale));
  const detCanvas = document.createElement('canvas');
  detCanvas.width = detW;
  detCanvas.height = detH;
  const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });
  detCtx.drawImage(img, 0, 0, detW, detH);

  let mat = null;
  let gray = null;
  let faces = [];
  try {
    const imageData = detCtx.getImageData(0, 0, detW, detH);
    mat = cv.matFromImageData(imageData);
    gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    cv.equalizeHist(gray, gray);
    faces = detectFacesOnGray(cv, gray, height, 1 / scale, opts);
  } finally {
    if (gray) gray.delete();
    if (mat) mat.delete();
  }

  faces.forEach((face) => drawSymbolOnFace(ctx, face, opts));

  let dataUrl;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (e) {
    throw new Error('无法导出图片（可能是跨域网络图，请改用本地图片）');
  }
  const totalMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tStart);
  console.log(`[faceCensor] 完成：识别 ${faces.length} 张脸，总耗时 ${totalMs}ms`);
  return { dataUrl, faceCount: faces.length, width, height };
}

// 对单张图片自动识别人脸并叠加打码符号，优先走后端 Python/OpenCV。
export async function censorImageSrc(src, userOpts = {}) {
  try {
    return await censorImageSrcInBackend(src, userOpts);
  } catch (backendErr) {
    console.warn('[faceCensor] 后端自动打码不可用，回退到浏览器实现:', backendErr);
    return await censorImageSrcInBrowser(src, userOpts);
  }
}

// 手动放置：在指定位置绘制一个或多个符号(自然像素坐标 cx,cy + half 半尺寸)。
// 不走人脸识别，快速且可靠，用于自动识别不准时手动打码。
// placements 可传单个 {cx,cy,half} 或它们的数组。
export async function censorImageManual(src, placements, userOpts = {}) {
  const opts = { ...DEFAULT_CENSOR_OPTIONS, ...userOpts };
  const list = (Array.isArray(placements) ? placements : [placements]).filter(Boolean);
  const img = await loadImageElement(src);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error('图片尺寸无效');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  for (const p of list) {
    drawSymbol(ctx, p.cx, p.cy, p.half, opts);
  }

  let dataUrl;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (e) {
    throw new Error('无法导出图片（可能是跨域网络图，请改用本地图片）');
  }
  return { dataUrl, width, height };
}
