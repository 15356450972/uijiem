import React from 'react';
import { Minus, Square, X, RefreshCw } from 'lucide-react';

export default function TitleBar() {
  const isElectron = !!window.electronAPI;

  const handleMinimize = () => {
    if (isElectron) {
      window.electronAPI.minimizeWindow();
    }
  };

  const handleMaximize = () => {
    if (isElectron) {
      window.electronAPI.maximizeWindow();
    }
  };

  const handleClose = () => {
    if (isElectron) {
      window.electronAPI.closeWindow();
    }
  };

  return (
    <div className="h-10 w-full bg-dark-sidebar border-b border-dark-border flex items-center justify-between px-4 select-none titlebar-drag shrink-0 z-50">
      <div className="flex items-center space-x-2 titlebar-nodrag">
        {/* Cat Icon / Logo matching Screenshot 1 (猫蚕剧) */}
        <div className="flex items-center space-x-1.5">
          <div className="w-5 h-5 bg-brand rounded-md flex items-center justify-center text-black font-bold text-xs">
            猫
          </div>
          <span className="text-sm font-semibold tracking-wider text-white">猫蚕剧</span>
          <span className="text-[10px] bg-dark-border text-brand border border-brand/30 px-1.5 py-0.5 rounded-full scale-90">
            PRO v2.0.8
          </span>
        </div>
      </div>

      {/* Electron custom window controls (or browser indicators) */}
      <div className="flex items-center space-x-1 titlebar-nodrag">
        {isElectron ? (
          <>
            <button
              onClick={handleMinimize}
              className="p-1.5 hover:bg-dark-card rounded text-dark-muted hover:text-white transition-colors"
              title="最小化"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleMaximize}
              className="p-1.5 hover:bg-dark-card rounded text-dark-muted hover:text-white transition-colors"
              title="最大化"
            >
              <Square className="w-3 h-3" />
            </button>
            <button
              onClick={handleClose}
              className="p-1.5 hover:bg-red-500/20 rounded text-dark-muted hover:text-red-400 transition-colors"
              title="关闭"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <div className="text-[11px] text-dark-muted bg-dark-border px-2.5 py-1 rounded">
            浏览器预览模式
          </div>
        )}
      </div>
    </div>
  );
}
