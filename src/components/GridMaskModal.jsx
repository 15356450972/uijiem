import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';

// 网格遮罩：可在角色图上放多个网格方块，拖动定位、滑块调大小，
// 确定后合成并回传 dataURL。用于遮挡面部等隐私区域。
//
// props:
//   open: boolean
//   src: string            待遮罩的图片（dataURL / file:// / http）
//   onApply: (dataUrl) => void
//   onClose: () => void
export default function GridMaskModal({ open, src, onApply, onClose }) {
  const [imgEl, setImgEl] = useState(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [boxes, setBoxes] = useState([]); // [{ id, cx, cy, half, gridLines }]
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canvasRef = useRef(null);
  const draggingRef = useRef(false);
  const idRef = useRef(0);
  const dragPosRef = useRef(null);
  const rafRef = useRef(null);

  const MAX_W = Math.min(window.innerWidth - 80, 900);
  const MAX_H = Math.min(window.innerHeight - 200, 700);
  const displayScale = natural.w
    ? Math.min(MAX_W / natural.w, MAX_H / natural.h, 1)
    : 1;
  const dispW = Math.round(natural.w * displayScale);
  const dispH = Math.round(natural.h * displayScale);
  const defaultHalf = natural.w ? Math.min(natural.w, natural.h) * 0.22 : 40;
  const selected = boxes.find((s) => s.id === selectedId) || null;

  useEffect(() => {
    if (!open || !src) return;
    setError('');
    setImgEl(null);
    setBoxes([]);
    setSelectedId(null);
    const img = new Image();
    if (/^https?:\/\//i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      setImgEl(img);
      setNatural({ w, h });
      const half = Math.min(w, h) * 0.22;
      const id = ++idRef.current;
      setBoxes([{ id, cx: w / 2, cy: h * 0.4, half, gridLines: 10 }]);
      setSelectedId(id);
    };
    img.onerror = () => setError('图片加载失败');
    img.src = src;
  }, [open, src]);

  const drawGridBox = (ctx, cx, cy, half, gridLines = 10) => {
    const x = cx - half;
    const y = cy - half;
    const size = half * 2;
    const step = size / gridLines;

    // No background fill — fully transparent so face is visible underneath

    // Clip to box bounds so lines don't extend beyond edges
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();

    // Draw grid lines (semi-transparent white)
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(0.5, size / gridLines / 12);
    ctx.beginPath();
    for (let i = 0; i <= gridLines; i++) {
      const offset = i * step;
      ctx.moveTo(x + offset, y);
      ctx.lineTo(x + offset, y + size);
      ctx.moveTo(x, y + offset);
      ctx.lineTo(x + size, y + offset);
    }
    ctx.stroke();
    ctx.restore();
  };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgEl || !dispW || !dispH) return;
    canvas.width = dispW;
    canvas.height = dispH;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(imgEl, 0, 0, dispW, dispH);
    for (const s of boxes) {
      const cx = s.cx * displayScale;
      const cy = s.cy * displayScale;
      const half = s.half * displayScale;
      drawGridBox(ctx, cx, cy, half, s.gridLines);
    }
  }, [imgEl, dispW, dispH, boxes, selectedId, displayScale]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const pointerToNatural = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      cx: (e.clientX - rect.left) / displayScale,
      cy: (e.clientY - rect.top) / displayScale,
    };
  };

  const hitTest = (p) => {
    for (let i = boxes.length - 1; i >= 0; i--) {
      const s = boxes[i];
      if (Math.abs(p.cx - s.cx) <= s.half && Math.abs(p.cy - s.cy) <= s.half) {
        return s.id;
      }
    }
    return null;
  };

  const handlePointerDown = (e) => {
    const p = pointerToNatural(e);
    const hitId = hitTest(p);
    if (hitId != null) {
      setSelectedId(hitId);
      draggingRef.current = true;
    } else {
      const half = selected ? selected.half : defaultHalf;
      const gridLines = selected ? selected.gridLines : 10;
      const id = ++idRef.current;
      setBoxes((prev) => [...prev, { id, cx: p.cx, cy: p.cy, half, gridLines }]);
      setSelectedId(id);
      draggingRef.current = true;
    }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current || selectedId == null) return;
    const p = pointerToNatural(e);
    dragPosRef.current = p;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const pos = dragPosRef.current;
      if (!pos) return;
      const canvas = canvasRef.current;
      if (!canvas || !imgEl || !dispW || !dispH) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, dispW, dispH);
      ctx.drawImage(imgEl, 0, 0, dispW, dispH);
      for (const s of boxes) {
        const cx = (s.id === selectedId ? pos.cx : s.cx) * displayScale;
        const cy = (s.id === selectedId ? pos.cy : s.cy) * displayScale;
        const half = s.half * displayScale;
        drawGridBox(ctx, cx, cy, half, s.gridLines);
      }
    });
  };
  const handlePointerUp = () => {
    draggingRef.current = false;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const pos = dragPosRef.current;
    dragPosRef.current = null;
    if (pos && selectedId != null) {
      setBoxes((prev) => prev.map((s) => (s.id === selectedId ? { ...s, cx: pos.cx, cy: pos.cy } : s)));
    }
  };

  const addBoxAtCenter = () => {
    if (!natural.w) return;
    const half = selected ? selected.half : defaultHalf;
    const gridLines = selected ? selected.gridLines : 10;
    const id = ++idRef.current;
    setBoxes((prev) => [...prev, { id, cx: natural.w / 2, cy: natural.h / 2, half, gridLines }]);
    setSelectedId(id);
  };

  const deleteSelected = () => {
    if (selectedId == null) return;
    setBoxes((prev) => {
      const next = prev.filter((s) => s.id !== selectedId);
      setSelectedId(next.length ? next[next.length - 1].id : null);
      return next;
    });
  };

  const handleApply = async () => {
    if (!src || !boxes.length) {
      setError('请至少放置一个网格');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // Render at full natural resolution
      const canvas = document.createElement('canvas');
      canvas.width = natural.w;
      canvas.height = natural.h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgEl, 0, 0, natural.w, natural.h);
      for (const s of boxes) {
        drawGridBox(ctx, s.cx, s.cy, s.half, s.gridLines);
      }
      const dataUrl = canvas.toDataURL('image/png');
      onApply?.(dataUrl);
      onClose?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const minHalf = natural.w ? Math.min(natural.w, natural.h) * 0.04 : 10;
  const maxHalf = natural.w ? Math.min(natural.w, natural.h) * 0.6 : 100;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#1a1b1f] border border-dark-border rounded-xl shadow-2xl flex flex-col overflow-hidden max-w-[92vw]">
        <div className="h-11 px-4 flex items-center justify-between border-b border-dark-border bg-[#111214]">
          <span className="text-xs font-bold text-dark-text">
            网格遮罩 · 点空白处放一个，点中网格可拖动（已放 {boxes.length} 个）
          </span>
          <button
            onClick={onClose}
            className="text-dark-muted hover:text-white w-6 h-6 rounded flex items-center justify-center hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col items-center space-y-3">
          {error ? (
            <div className="text-xs text-red-400 py-10">{error}</div>
          ) : !imgEl ? (
            <div className="text-xs text-dark-muted py-10">图片加载中…</div>
          ) : (
            <>
              <div
                className="relative select-none touch-none cursor-crosshair rounded-lg overflow-hidden border border-dark-border"
                style={{ width: dispW, height: dispH }}
              >
                <canvas
                  ref={canvasRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  className="block"
                />
              </div>
              <div className="w-full flex items-center space-x-3 px-1 flex-wrap gap-y-2">
                <button
                  type="button"
                  onClick={addBoxAtCenter}
                  title="再放一个网格"
                  className="flex items-center space-x-1 px-2 py-1 rounded-md bg-dark-input border border-dark-border text-[10px] font-bold text-dark-text hover:text-white hover:border-brand/40 shrink-0"
                >
                  <Plus className="w-3 h-3" />
                  <span>再放一个</span>
                </button>
                <button
                  type="button"
                  onClick={deleteSelected}
                  disabled={selectedId == null}
                  title="删除选中的网格"
                  className="flex items-center space-x-1 px-2 py-1 rounded-md bg-dark-input border border-dark-border text-[10px] font-bold text-dark-muted hover:text-red-400 hover:border-red-400/40 disabled:opacity-40 shrink-0"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>删除选中</span>
                </button>
                <span className="text-[10px] text-dark-muted shrink-0 ml-1">大小</span>
                <input
                  type="range"
                  min={minHalf}
                  max={maxHalf}
                  step={1}
                  value={selected ? selected.half : defaultHalf}
                  disabled={!selected}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setBoxes((prev) => prev.map((s) => (s.id === selectedId ? { ...s, half: val } : s)));
                  }}
                  className="flex-1 accent-brand disabled:opacity-40 min-w-[80px]"
                />
                <span className="text-[10px] text-dark-muted shrink-0 ml-1">格数</span>
                <input
                  type="range"
                  min={3}
                  max={20}
                  step={1}
                  value={selected ? selected.gridLines : 10}
                  disabled={!selected}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setBoxes((prev) => prev.map((s) => (s.id === selectedId ? { ...s, gridLines: val } : s)));
                  }}
                  className="w-20 accent-brand disabled:opacity-40"
                />
                <span className="text-[10px] text-dark-muted w-4 shrink-0">{selected ? selected.gridLines : 10}</span>
              </div>
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-dark-border bg-dark-card flex items-center justify-end space-x-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-[#222328] border border-dark-border text-xs font-bold text-dark-text hover:bg-[#2d2e33]"
          >
            取消
          </button>
          <button
            onClick={handleApply}
            disabled={busy || !imgEl || !boxes.length}
            className="px-4 py-1.5 rounded-lg bg-brand text-xs font-bold text-black hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? '处理中…' : '确定遮罩'}
          </button>
        </div>
      </div>
    </div>
  );
}
