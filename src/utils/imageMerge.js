// 图片合并工具：渲染端 Canvas 实现，严格保留原始像素分辨率。
// 详见项目根目录 `合并图片功能设计.md`。

export const DEFAULT_MERGE_OPTIONS = {
  columns: 2,
  lastRowAlign: 'center',
  padding: 16,
  background: '#000000',
  format: 'png',
  quality: 0.92,
  showLabel: true,
  labelPosition: 'bottom-left',
  // 仅在画布超过此尺寸时直接拒绝，避免触发浏览器 Canvas 上限引发的静默失败。
  maxCanvasSize: 16384,
  warnCanvasSize: 8192,
};

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('image src is empty'));
      return;
    }
    const img = new Image();
    if (/^https?:\/\//i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`图片加载失败: ${src}`));
    img.src = src;
  });
}

export function chunk(arr, size) {
  if (size <= 0) return [arr.slice()];
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawLabel(ctx, { text, x, y, w, h, position }) {
  if (!text) return;
  // 字体大小随图片宽度自适应，避免大图上字看不见、小图上字盖住主体。
  const fontSize = Math.round(Math.max(20, Math.min(64, w * 0.04)));
  ctx.font = `bold ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`;
  const padX = Math.round(fontSize * 0.6);
  const padY = Math.round(fontSize * 0.35);
  const textW = ctx.measureText(text).width;
  const boxW = textW + padX * 2;
  const boxH = fontSize + padY * 2;
  const margin = Math.round(fontSize * 0.5);

  let bx;
  let by;
  switch (position) {
    case 'top-left':
      bx = x + margin;
      by = y + margin;
      break;
    case 'top-right':
      bx = x + w - boxW - margin;
      by = y + margin;
      break;
    case 'bottom-right':
      bx = x + w - boxW - margin;
      by = y + h - boxH - margin;
      break;
    case 'bottom-left':
    default:
      bx = x + margin;
      by = y + h - boxH - margin;
      break;
  }

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(ctx, bx, by, boxW, boxH, Math.round(fontSize * 0.25));
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + padX, by + boxH / 2);
}

export function canvasToBlob(canvas, format = 'png', quality = 0.92) {
  const mime = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('canvas.toBlob 返回空 blob'));
        return;
      }
      resolve(blob);
    }, mime, quality);
  });
}

// 计算合并画布度量，单独抽出来方便预览和保存复用同一份布局。
export function computeLayout(loaded, opts) {
  const cols = Math.max(1, opts.columns || 1);
  const padding = Math.max(0, opts.padding || 0);
  const rows = chunk(loaded, cols);

  const rowMetrics = rows.map((row) => {
    const cells = row.map((it) => ({
      ...it,
      w: it.img.naturalWidth,
      h: it.img.naturalHeight,
    }));
    const rowHeight = Math.max(...cells.map((c) => c.h));
    const totalWidth = cells.reduce((s, c) => s + c.w, 0)
      + padding * Math.max(0, cells.length - 1);
    return { cells, rowHeight, totalWidth };
  });

  const innerWidth = Math.max(...rowMetrics.map((r) => r.totalWidth));
  const canvasW = innerWidth + padding * 2;
  const canvasH = rowMetrics.reduce((s, r) => s + r.rowHeight, 0)
    + padding * (rowMetrics.length + 1);

  return { rowMetrics, canvasW, canvasH, padding };
}

export async function mergeImages(items, userOpts = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('请先选择 ≥ 1 张图片');
  }
  const opts = { ...DEFAULT_MERGE_OPTIONS, ...userOpts };

  const loaded = await Promise.all(items.map(async (it) => ({
    ...it,
    img: await loadImage(it.src),
  })));

  const { rowMetrics, canvasW, canvasH, padding } = computeLayout(loaded, opts);

  if (canvasW > opts.maxCanvasSize || canvasH > opts.maxCanvasSize) {
    throw new Error(`合成画布 ${canvasW}×${canvasH} 超过上限 ${opts.maxCanvasSize}×${opts.maxCanvasSize}，建议拆开多次合并`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文');
  // 严格 1:1 绘制；关闭重采样，避免任何隐式缩放动到分辨率。
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = opts.background || '#000000';
  ctx.fillRect(0, 0, canvasW, canvasH);

  let y = padding;
  for (const r of rowMetrics) {
    let x = padding;
    const innerWidth = canvasW - padding * 2;
    if (r.totalWidth < innerWidth) {
      if (opts.lastRowAlign === 'center') {
        x = Math.round((canvasW - r.totalWidth) / 2);
      }
    }
    for (const c of r.cells) {
      ctx.drawImage(c.img, x, y, c.w, c.h);
      if (opts.showLabel && (c.label || '').trim()) {
        drawLabel(ctx, {
          text: `${c.labelPrefix || ''}${c.label}`.trim(),
          x,
          y,
          w: c.w,
          h: c.h,
          position: opts.labelPosition,
        });
      }
      x += c.w + padding;
    }
    y += r.rowHeight + padding;
  }

  const blob = await canvasToBlob(canvas, opts.format, opts.quality);
  return {
    blob,
    canvasWidth: canvasW,
    canvasHeight: canvasH,
    format: opts.format === 'jpeg' || opts.format === 'jpg' ? 'jpg' : 'png',
  };
}

export async function blobToUint8Array(blob) {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

export function timestampForFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}
