import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { X, Plus, Trash2, FolderOpen, Save, Image as ImageIcon, Download, GripVertical } from 'lucide-react';
import {
  mergeImages,
  blobToUint8Array,
  timestampForFilename,
  DEFAULT_MERGE_OPTIONS,
} from '../utils/imageMerge';

// 把渲染端 file:// / blob: src 加载好之后，扔进 imageMerge 做合成。
// 详见 `合并图片功能设计.md`。
//
// props:
//   open: boolean
//   onClose: () => void
//   initialItems: Array<{ id?, src, label?, labelPrefix?, localPath? }>
//   defaultDir?: string                   // 保存到本地时的优先目录
//   onApplyAsReference?: (filePath) => void  // "作为该行垫图" 回调；不传则不显示该按钮
//   title?: string
export default function ImageMergeModal({
  open,
  onClose,
  initialItems = [],
  defaultDir,
  onApplyAsReference,
  title = '合并图片',
}) {
  const [items, setItems] = useState([]);
  const [opts, setOpts] = useState({ ...DEFAULT_MERGE_OPTIONS });
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewSize, setPreviewSize] = useState({ w: 0, h: 0, bytes: 0 });
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const dragIndexRef = useRef(null);
  const lastBlobRef = useRef(null);
  const previewUrlRef = useRef('');
  const lastSignatureRef = useRef('');

  useEffect(() => {
    if (!open) return;
    setItems(initialItems.map((it, idx) => ({
      key: it.id ? String(it.id) : `it-${idx}-${Date.now()}`,
      src: it.src,
      label: it.label || '',
      labelPrefix: it.labelPrefix || '',
      localPath: it.localPath || '',
    })));
    setErrorMsg('');
    setSavedPath('');
  }, [open, initialItems]);

  useEffect(() => () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = '';
    }
  }, []);

  const renderPreview = useCallback(async () => {
    if (!open) return;
    if (items.length === 0) {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = '';
      lastBlobRef.current = null;
      setPreviewUrl('');
      setPreviewSize({ w: 0, h: 0, bytes: 0 });
      return;
    }
    const sig = JSON.stringify({
      items: items.map((it) => ({ src: it.src, label: it.label, prefix: it.labelPrefix })),
      opts,
    });
    if (sig === lastSignatureRef.current) return;
    lastSignatureRef.current = sig;
    setBusy(true);
    setErrorMsg('');
    try {
      const result = await mergeImages(items, opts);
      lastBlobRef.current = result.blob;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = URL.createObjectURL(result.blob);
      setPreviewUrl(previewUrlRef.current);
      setPreviewSize({ w: result.canvasWidth, h: result.canvasHeight, bytes: result.blob.size });
    } catch (e) {
      lastBlobRef.current = null;
      setPreviewUrl('');
      setPreviewSize({ w: 0, h: 0, bytes: 0 });
      setErrorMsg(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [items, opts, open]);

  useEffect(() => {
    const t = setTimeout(renderPreview, 80);
    return () => clearTimeout(t);
  }, [renderPreview]);

  const handleAddLocalFiles = async () => {
    if (!window.electronAPI || !window.electronAPI.selectFiles) {
      alert('当前环境不支持文件选择，请在桌面客户端中使用此功能。');
      return;
    }
    const filePaths = await window.electronAPI.selectFiles([
      { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] },
    ]);
    const arr = Array.isArray(filePaths) ? filePaths : (filePaths ? [filePaths] : []);
    if (arr.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...arr.map((p, i) => ({
        key: `local-${Date.now()}-${i}`,
        src: 'file:///' + String(p).replace(/\\/g, '/'),
        localPath: p,
        label: getFileStem(p),
        labelPrefix: '',
      })),
    ]);
  };

  const handleAddLocalDir = async () => {
    if (!window.electronAPI || !window.electronAPI.selectImageDirectory) {
      alert('当前环境不支持文件夹选择，请在桌面客户端中使用此功能。');
      return;
    }
    const res = await window.electronAPI.selectImageDirectory();
    if (!res || res.canceled) return;
    const filePaths = (res.filePaths || []).filter((p) => /\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(p));
    if (filePaths.length === 0) {
      alert('所选文件夹内没有可导入的图片。');
      return;
    }
    setItems((prev) => [
      ...prev,
      ...filePaths.map((p, i) => ({
        key: `dir-${Date.now()}-${i}`,
        src: 'file:///' + String(p).replace(/\\/g, '/'),
        localPath: p,
        label: getFileStem(p),
        labelPrefix: '',
      })),
    ]);
  };

  const handleRemove = (key) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  };

  const handleClear = () => setItems([]);

  const handleEditLabel = (key) => {
    const target = items.find((it) => it.key === key);
    if (!target) return;
    const next = prompt('编辑该图的名字标签（前缀符号 @/$/# 会自动保留）:', `${target.labelPrefix || ''}${target.label || ''}`);
    if (next == null) return;
    const trimmed = String(next).trim();
    let prefix = '';
    let raw = trimmed;
    if (/^[@$#]/.test(trimmed)) {
      prefix = trimmed[0];
      raw = trimmed.slice(1);
    }
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, label: raw, labelPrefix: prefix } : it)));
  };

  const onDragStart = (idx) => (e) => {
    dragIndexRef.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (idx) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (idx) => (e) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    if (from == null || from === idx) return;
    setItems((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(idx, 0, moved);
      return next;
    });
  };

  const handleSaveLocal = async () => {
    if (!lastBlobRef.current) {
      alert('当前没有可保存的合成图。');
      return;
    }
    if (!window.electronAPI || !window.electronAPI.saveMergedImage) {
      alert('当前环境不支持保存到本地，请在桌面客户端中使用此功能。');
      return;
    }
    const ext = opts.format === 'jpeg' || opts.format === 'jpg' ? 'jpg' : 'png';
    const bytes = await blobToUint8Array(lastBlobRef.current);
    const res = await window.electronAPI.saveMergedImage({
      bytes,
      ext,
      defaultDir,
      defaultName: `merge_${timestampForFilename()}`,
      silent: false,
    });
    if (res?.canceled) return;
    if (!res?.ok) {
      alert(`保存失败：${res?.error || '未知错误'}`);
      return;
    }
    setSavedPath(res.filePath);
  };

  const handleApplyAsReference = async () => {
    if (!onApplyAsReference) return;
    if (!lastBlobRef.current) {
      alert('当前没有可保存的合成图。');
      return;
    }
    if (!window.electronAPI || !window.electronAPI.saveMergedImage) {
      alert('当前环境不支持保存到本地，请在桌面客户端中使用此功能。');
      return;
    }
    const ext = opts.format === 'jpeg' || opts.format === 'jpg' ? 'jpg' : 'png';
    const bytes = await blobToUint8Array(lastBlobRef.current);
    const res = await window.electronAPI.saveMergedImage({
      bytes,
      ext,
      defaultDir,
      defaultName: `merge_${timestampForFilename()}`,
      silent: true,
    });
    if (!res?.ok) {
      alert(`保存失败：${res?.error || '未知错误'}`);
      return;
    }
    onApplyAsReference(res.filePath);
    onClose?.();
  };

  const handleRevealInFolder = () => {
    if (!savedPath) return;
    if (window.electronAPI?.showItemInFolder) {
      window.electronAPI.showItemInFolder(savedPath);
    }
  };

  const fileSize = useMemo(() => formatBytes(previewSize.bytes), [previewSize.bytes]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[1024px] max-w-[96vw] max-h-[92vh] bg-dark-card border border-dark-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="h-12 px-4 flex items-center justify-between border-b border-dark-border bg-dark-sidebar/60">
          <div className="flex items-center space-x-2">
            <ImageIcon className="w-4 h-4 text-brand" />
            <span className="text-sm font-bold text-white">{title}</span>
            <span className="text-[10px] text-dark-muted">原图分辨率 1:1 · 不压缩</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-dark-muted hover:text-white hover:bg-dark-bg/50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 grid grid-cols-[360px_1fr] min-h-0">
          {/* 左：候选图 + 选项 */}
          <div className="border-r border-dark-border flex flex-col min-h-0">
            <div className="p-3 border-b border-dark-border space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white">已选图片 ({items.length})</span>
                <button
                  onClick={handleClear}
                  disabled={!items.length}
                  className="text-[10px] text-dark-muted hover:text-red-400 disabled:opacity-40"
                >
                  清空
                </button>
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={handleAddLocalFiles}
                  className="flex-1 flex items-center justify-center space-x-1 px-2 py-1.5 bg-dark-input hover:bg-dark-bg border border-dark-border hover:border-brand/40 rounded-lg text-[11px] text-dark-text"
                >
                  <Plus className="w-3 h-3" />
                  <span>本地文件</span>
                </button>
                <button
                  onClick={handleAddLocalDir}
                  className="flex-1 flex items-center justify-center space-x-1 px-2 py-1.5 bg-dark-input hover:bg-dark-bg border border-dark-border hover:border-brand/40 rounded-lg text-[11px] text-dark-text"
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>文件夹</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1.5 no-scrollbar">
              {items.length === 0 ? (
                <div className="text-center text-[11px] text-dark-muted py-10">
                  暂无图片，点击上方按钮添加
                </div>
              ) : items.map((it, idx) => (
                <div
                  key={it.key}
                  draggable
                  onDragStart={onDragStart(idx)}
                  onDragOver={onDragOver(idx)}
                  onDrop={onDrop(idx)}
                  className="group flex items-center space-x-2 p-1.5 bg-dark-input/60 border border-dark-border rounded-lg hover:border-brand/40 transition-colors"
                >
                  <GripVertical className="w-3 h-3 text-dark-subtle shrink-0 cursor-grab" />
                  <span className="text-[10px] text-dark-muted w-4 text-center shrink-0">{idx + 1}</span>
                  <img src={it.src} alt={it.label} className="w-10 h-10 object-cover rounded-md border border-dark-border shrink-0 bg-black" />
                  <button
                    type="button"
                    onClick={() => handleEditLabel(it.key)}
                    className="flex-1 min-w-0 text-left text-[11px] text-dark-text hover:text-brand truncate"
                    title="点击编辑名字标签"
                  >
                    <span className="text-brand">{it.labelPrefix || ''}</span>
                    {it.label || <span className="text-dark-subtle italic">未命名</span>}
                  </button>
                  <button
                    onClick={() => handleRemove(it.key)}
                    className="p-1 rounded hover:bg-red-500/20 text-dark-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="移除"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>

            <div className="p-3 border-t border-dark-border space-y-2.5 bg-dark-sidebar/30">
              <Row label="每行图片数">
                <SegmentedButton
                  options={[{ v: 2, t: '2 张' }, { v: 3, t: '3 张' }]}
                  value={opts.columns}
                  onChange={(v) => setOpts((s) => ({ ...s, columns: v }))}
                />
              </Row>
              <Row label="末行对齐">
                <SegmentedButton
                  options={[{ v: 'center', t: '居中' }, { v: 'left', t: '靠左' }]}
                  value={opts.lastRowAlign}
                  onChange={(v) => setOpts((s) => ({ ...s, lastRowAlign: v }))}
                />
              </Row>
              <Row label="背景">
                <SegmentedButton
                  options={[{ v: '#000000', t: '黑' }, { v: '#ffffff', t: '白' }]}
                  value={opts.background}
                  onChange={(v) => setOpts((s) => ({ ...s, background: v }))}
                />
              </Row>
              <Row label="名字标签">
                <div className="flex items-center space-x-1.5">
                  <SegmentedButton
                    options={[{ v: true, t: '显示' }, { v: false, t: '隐藏' }]}
                    value={opts.showLabel}
                    onChange={(v) => setOpts((s) => ({ ...s, showLabel: v }))}
                  />
                </div>
              </Row>
              {opts.showLabel && (
                <Row label="标签位置">
                  <select
                    value={opts.labelPosition}
                    onChange={(e) => setOpts((s) => ({ ...s, labelPosition: e.target.value }))}
                    className="flex-1 bg-dark-input border border-dark-border rounded px-2 py-1 text-[11px] text-dark-text"
                  >
                    <option value="bottom-left">左下</option>
                    <option value="bottom-right">右下</option>
                    <option value="top-left">左上</option>
                    <option value="top-right">右上</option>
                  </select>
                </Row>
              )}
              <Row label="格式">
                <SegmentedButton
                  options={[{ v: 'png', t: 'PNG' }, { v: 'jpeg', t: 'JPEG' }]}
                  value={opts.format}
                  onChange={(v) => setOpts((s) => ({ ...s, format: v }))}
                />
              </Row>
              <Row label="间距 (px)">
                <input
                  type="number"
                  min={0}
                  max={128}
                  value={opts.padding}
                  onChange={(e) => setOpts((s) => ({ ...s, padding: Math.max(0, Math.min(128, Number(e.target.value) || 0)) }))}
                  className="w-20 bg-dark-input border border-dark-border rounded px-2 py-1 text-[11px] text-dark-text"
                />
              </Row>
            </div>
          </div>

          {/* 右：预览 */}
          <div className="flex flex-col min-h-0">
            <div className="flex-1 overflow-auto bg-[#0a0a0a] p-4 flex items-center justify-center">
              {busy ? (
                <div className="text-xs text-dark-muted">生成预览中...</div>
              ) : errorMsg ? (
                <div className="text-xs text-red-400 max-w-md text-center whitespace-pre-wrap">{errorMsg}</div>
              ) : previewUrl ? (
                <img
                  src={previewUrl}
                  alt="merged preview"
                  className="max-w-full max-h-full object-contain shadow-lg"
                  style={{ imageRendering: 'pixelated' }}
                />
              ) : (
                <div className="text-xs text-dark-muted">暂无预览，请先添加图片</div>
              )}
            </div>
            <div className="border-t border-dark-border px-4 py-2 bg-dark-sidebar/40 flex items-center justify-between text-[11px]">
              <div className="text-dark-muted">
                {previewSize.w > 0 ? (
                  <>
                    原始尺寸 <span className="text-white font-bold">{previewSize.w} × {previewSize.h}</span>
                    <span className="mx-2 text-dark-subtle">·</span>
                    估算 <span className="text-white font-bold">{fileSize}</span>
                  </>
                ) : '—'}
              </div>
              {savedPath && (
                <button
                  onClick={handleRevealInFolder}
                  className="text-brand hover:underline truncate max-w-[280px]"
                  title={savedPath}
                >
                  已保存到 {savedPath}
                </button>
              )}
            </div>
            <div className="border-t border-dark-border px-4 py-3 bg-dark-card flex items-center justify-end space-x-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-dark-muted hover:text-white hover:bg-dark-bg"
              >
                取消
              </button>
              <button
                onClick={handleSaveLocal}
                disabled={busy || !previewUrl}
                className="flex items-center space-x-1 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-dark-input border border-dark-border hover:border-brand/40 text-dark-text hover:text-white disabled:opacity-40"
              >
                <Download className="w-3 h-3" />
                <span>保存到本地</span>
              </button>
              {onApplyAsReference && (
                <button
                  onClick={handleApplyAsReference}
                  disabled={busy || !previewUrl}
                  className="flex items-center space-x-1 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-brand text-black hover:bg-brand-dark disabled:opacity-40 transition-all"
                >
                  <Save className="w-3 h-3" />
                  <span>作为该行垫图</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between space-x-2">
      <span className="text-[10px] text-dark-muted shrink-0">{label}</span>
      <div className="flex items-center justify-end">{children}</div>
    </div>
  );
}

function SegmentedButton({ options, value, onChange }) {
  return (
    <div className="flex bg-dark-input border border-dark-border rounded-md p-0.5">
      {options.map((opt) => {
        const active = opt.v === value;
        return (
          <button
            key={String(opt.v)}
            onClick={() => onChange(opt.v)}
            className={`px-2.5 py-0.5 text-[10px] font-bold rounded transition-colors ${
              active ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'
            }`}
          >
            {opt.t}
          </button>
        );
      })}
    </div>
  );
}

function getFileStem(filePath = '') {
  const fileName = String(filePath).split(/[\\/]/).pop() || '';
  return fileName.replace(/\.[^.]+$/, '').trim() || 'image';
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(2) : n.toFixed(1)} ${units[i]}`;
}
