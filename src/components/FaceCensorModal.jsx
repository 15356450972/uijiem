import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { drawSymbol, censorImageManual } from '../utils/faceCensor';

// 手动放置打码符号：可在角色图上放多个符号（多视图拼图常见），
// 拖动定位、滑块调当前选中符号大小，确定后合成并回传 dataURL。
// 不走人脸识别，快速可靠，作为自动打码识别不准时的兜底。
//
// props:
//   open: boolean
//   src: string            待打码的图片（dataURL / file:// / http）
//   onApply: (dataUrl) => void
//   onClose: () => void
export default function FaceCensorModal({ open, src, onApply, onClose }) {
  const [imgEl, setImgEl] = useState(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [symbols, setSymbols] = useState([]); // [{ id, cx, cy, half }]
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canvasRef = useRef(null);
  const draggingRef = useRef(false);
  const idRef = useRef(0);

  const MAX_W = 600;
  const MAX_H = 460;
  const displayScale = natural.w
    ? Math.min(MAX_W / natural.w, MAX_H / natural.h, 1)
    : 1;
  const dispW = Math.round(natural.w * displayScale);
  const dispH = Math.round(natural.h * displayScale);
  const defaultHalf = natural.w ? Math.min(natural.w, natural.h) * 0.22 : 40;
  const selected = symbols.find((s) => s.id === selectedId) || null;

  useEffect(() => {
    if (!open || !src) return;
    setError('');
    setImgEl(null);
    setSymbols([]);
    setSelectedId(null);
    const img = new Image();
    if (/^https?:\/\//i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      setImgEl(img);
      setNatural({ w, h });
      // 默认先放一个在画面上半部分中央。
      const half = Math.min(w, h) * 0.22;
      const id = ++idRef.current;
      setSymbols([{ id, cx: w / 2, cy: h * 0.4, half }]);
      setSelectedId(id);
    };
    img.onerror = () => setError('图片加载失败');
    img.src = src;
  }, [open, src]);

  // 在叠加层 canvas 上按显示比例绘制图片 + 所有符号预览（选中的加虚线框）。
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgEl || !dispW || !dispH) return;
    canvas.width = dispW;
    canvas.height = dispH;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(imgEl, 0, 0, dispW, dispH);
    for (const s of symbols) {
      const cx = s.cx * displayScale;
      const cy = s.cy * displayScale;
      const half = s.half * displayScale;
      drawSymbol(ctx, cx, cy, half);
      if (s.id === selectedId) {
        ctx.save();
        ctx.strokeStyle = 'rgba(16,185,129,0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
        ctx.restore();
      }
    }
  }, [imgEl, dispW, dispH, symbols, selectedId, displayScale]);

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

  // 命中测试：返回点击位置落在哪个符号的包围盒内（从上层往下找）。
  const hitTest = (p) => {
    for (let i = symbols.length - 1; i >= 0; i--) {
      const s = symbols[i];
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
      // 点空白处：新放一个符号（大小沿用当前选中或默认）。
      const half = selected ? selected.half : defaultHalf;
      const id = ++idRef.current;
      setSymbols((prev) => [...prev, { id, cx: p.cx, cy: p.cy, half }]);
      setSelectedId(id);
      draggingRef.current = true;
    }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current || selectedId == null) return;
    const p = pointerToNatural(e);
    setSymbols((prev) => prev.map((s) => (s.id === selectedId ? { ...s, cx: p.cx, cy: p.cy } : s)));
  };
  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  const addSymbolAtCenter = () => {
    if (!natural.w) return;
    const half = selected ? selected.half : defaultHalf;
    const id = ++idRef.current;
    setSymbols((prev) => [...prev, { id, cx: natural.w / 2, cy: natural.h / 2, half }]);
    setSelectedId(id);
  };

  const deleteSelected = () => {
    if (selectedId == null) return;
    setSymbols((prev) => {
      const next = prev.filter((s) => s.id !== selectedId);
      setSelectedId(next.length ? next[next.length - 1].id : null);
      return next;
    });
  };

  const handleApply = async () => {
    if (!src || !symbols.length) {
      setError('请至少放置一个符号');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await censorImageManual(src, symbols);
      onApply?.(res.dataUrl);
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
            手动打码 · 点空白处放一个，点中符号可拖动（已放 {symbols.length} 个）
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
              <div className="w-full flex items-center space-x-3 px-1">
                <button
                  type="button"
                  onClick={addSymbolAtCenter}
                  title="再放一个符号"
                  className="flex items-center space-x-1 px-2 py-1 rounded-md bg-dark-input border border-dark-border text-[10px] font-bold text-dark-text hover:text-white hover:border-brand/40 shrink-0"
                >
                  <Plus className="w-3 h-3" />
                  <span>再放一个</span>
                </button>
                <button
                  type="button"
                  onClick={deleteSelected}
                  disabled={selectedId == null}
                  title="删除选中的符号"
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
                    setSymbols((prev) => prev.map((s) => (s.id === selectedId ? { ...s, half: val } : s)));
                  }}
                  className="flex-1 accent-brand disabled:opacity-40"
                />
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
            disabled={busy || !imgEl || !symbols.length}
            className="px-4 py-1.5 rounded-lg bg-brand text-xs font-bold text-black hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? '处理中…' : '确定打码'}
          </button>
        </div>
      </div>
    </div>
  );
}
