import React, { useState } from 'react';
import { 
  Folder, 
  Search, 
  RotateCw, 
  Plus, 
  FolderPlus, 
  Trash2, 
  Copy, 
  Edit3, 
  Play, 
  FileText 
} from 'lucide-react';

export default function Dashboard({ drafts, setDrafts, onOpenDraft, onRefreshDrafts }) {
  const [selectedCollection, setSelectedCollection] = useState('全部');
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  // Collections count math
  const totalCount = drafts.length;
  const unfolderCount = drafts.filter(d => !d.collection).length;
  const c111Count = drafts.filter(d => d.collection === '111').length;

  const collections = [
    { name: '全部', count: totalCount },
    { name: '未分集', count: unfolderCount },
    { name: '111', count: c111Count }
  ];

  // Add a single draft
  const handleCreateNewProject = () => {
    setNewProjectName(`新项目_${new Date().toLocaleDateString()}`);
    setShowNewProjectModal(true);
  };

  const confirmCreateProject = () => {
    if (!newProjectName.trim()) return;
    const newDraft = {
      id: String(Date.now()),
      title: newProjectName.trim(),
      date: new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      status: '未生成',
      progress: '0/0',
      collection: selectedCollection === '全部' || selectedCollection === '未分集' ? '' : selectedCollection,
      thumbnail: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&q=80&w=260',
      editable: true
    };
    setDrafts([newDraft, ...drafts]);
    setShowNewProjectModal(false);
    setNewProjectName('');
  };

  // Batch import folders (Simulating batch folders selection)
  const handleBatchImport = async () => {
    let folderPath = '模拟文件夹_C:/Videos/Batch_Project';
    if (window.electronAPI) {
      const selected = await window.electronAPI.selectDirectory();
      if (selected) {
        folderPath = selected;
      } else {
        return; // Canceled
      }
    } else {
      const confirmMock = confirm('正在模拟从文件夹批量导入。是否继续？');
      if (!confirmMock) return;
    }

    const folderName = folderPath.split(/[/\\]/).pop();
    
    // Simulate importing 5 files
    const batchDrafts = Array.from({ length: 5 }).map((_, i) => ({
      id: `batch-${Date.now()}-${i}`,
      title: `${folderName}_视频文件_${i + 1}`,
      date: new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      status: '导入中',
      progress: '待渲染',
      collection: '111',
      thumbnail: 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&q=80&w=260',
      editable: true
    }));

    setDrafts([...batchDrafts, ...drafts]);
  };

  // Delete draft
  const handleDeleteDraft = (id, e) => {
    e.stopPropagation();
    if (confirm('确定要删除这个草稿吗？')) {
      setDrafts(drafts.filter(d => d.id !== id));
    }
  };

  // Duplicate draft
  const handleDuplicateDraft = (draft, e) => {
    e.stopPropagation();
    const duplicated = {
      ...draft,
      id: String(Date.now()),
      title: `${draft.title} (副本)`,
    };
    setDrafts([duplicated, ...drafts]);
  };

  // Filter drafts based on search
  const filteredDrafts = drafts.filter(draft => {
    return draft.title.toLowerCase().includes(searchQuery.toLowerCase());
  });

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* New Project Modal */}
      {showNewProjectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-dark-card border border-dark-border rounded-xl p-6 w-96 space-y-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-white">新建项目</h3>
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmCreateProject(); }}
              placeholder="请输入项目名称"
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowNewProjectModal(false)}
                className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-bg transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmCreateProject}
                disabled={!newProjectName.trim()}
                className="px-4 py-2 rounded-lg bg-brand text-black text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RIGHT: Drafts Grid */}
      <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/40">
        {/* Sub Header / Filters toolbar */}
        <div className="h-14 border-b border-dark-border px-6 flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-bold text-white">草稿 ({filteredDrafts.length})</span>
          </div>

          <div className="flex items-center space-x-2">
            {/* Search */}
            <div className="relative">
              <input
                type="text"
                placeholder="搜索草稿名称"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-48 bg-dark-input text-xs border border-dark-border hover:border-dark-subtle focus:border-brand focus:outline-none rounded-lg py-1.5 pl-8 pr-3 text-white placeholder-dark-subtle transition-all"
              />
              <Search className="w-3.5 h-3.5 text-dark-subtle absolute left-2.5 top-2.5" />
            </div>

            {/* Toolbar Buttons */}
            <button
              onClick={onRefreshDrafts}
              className="flex items-center space-x-1 px-3 py-1.5 border border-dark-border hover:border-brand/30 hover:bg-dark-card rounded-lg text-xs text-dark-muted hover:text-white transition-all"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>刷新</span>
            </button>
            <button className="flex items-center space-x-1 px-3 py-1.5 border border-dark-border hover:border-brand/30 hover:bg-dark-card rounded-lg text-xs text-dark-muted hover:text-white transition-all">
              <Folder className="w-3.5 h-3.5" />
              <span>文件夹</span>
            </button>
            <button className="flex items-center space-x-1 px-3 py-1.5 border border-dark-border hover:border-brand/30 hover:bg-dark-card rounded-lg text-xs text-dark-muted hover:text-white transition-all">
              <span>官格</span>
            </button>
            <button 
              onClick={handleBatchImport}
              className="flex items-center space-x-1 px-3 py-1.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-lg shadow-brand/10"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>批量创作</span>
            </button>
          </div>
        </div>

        {/* Dashboard Grid Container */}
        <div className="flex-1 overflow-y-auto p-6 no-scrollbar">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            
            {/* CARD 1: New Project / Dotted Card */}
            <div 
              onClick={handleCreateNewProject}
              className="border-2 border-dashed border-dark-border hover:border-brand/50 bg-dark-card/20 hover:bg-dark-card/40 rounded-xl p-5 flex flex-col justify-between items-center text-center cursor-pointer transition-all aspect-square min-h-[190px] h-full group"
            >
              <div className="w-10 h-10 rounded-full border border-dark-border bg-dark-bg flex items-center justify-center text-dark-muted group-hover:text-brand group-hover:border-brand/30 transition-all mt-3">
                <Plus className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-bold text-white group-hover:text-brand transition-colors">新建项目</p>
                <p className="text-[10px] text-dark-subtle leading-normal px-2">
                  点击创建 或 拖入srt/txt文件
                </p>
              </div>
              <button 
                onClick={(e) => { e.stopPropagation(); handleBatchImport(); }}
                className="text-[10px] text-brand hover:underline font-semibold"
              >
                从文件夹批量创建
              </button>
            </div>

            {/* DRAFT CARDS */}
            {filteredDrafts.map((draft) => {
              const progressPercentage = (() => {
                if (!draft.progress || draft.progress === '待渲染' || draft.progress.includes('-')) return 0;
                const [done, total] = draft.progress.split('/').map(Number);
                return total ? (done / total) * 100 : 0;
              })();

              return (
                <div 
                  key={draft.id}
                  onClick={() => onOpenDraft(draft)}
                  className="bg-dark-card border border-dark-border/60 hover:border-brand/40 hover:bg-dark-cardHover rounded-xl overflow-hidden cursor-pointer transition-all flex flex-col justify-between h-full group relative aspect-square min-h-[190px]"
                >
                  {/* Category Badge on card top-left */}
                  {draft.collection && (
                    <span className="absolute top-2.5 left-2.5 z-10 text-[9px] bg-blue-500/20 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded font-semibold">
                      {draft.collection}
                    </span>
                  )}

                  {/* Top-Right Tag: 2天前编辑 */}
                  <span className="absolute top-2.5 right-2.5 z-10 text-[9px] bg-black/60 backdrop-blur-sm text-dark-muted px-1.5 py-0.5 rounded">
                    2天前编辑
                  </span>

                  {/* Thumbnail */}
                  <div className="relative flex-1 bg-dark-bg/80 flex items-center justify-center overflow-hidden">
                    <img 
                      src={draft.thumbnail} 
                      alt={draft.title} 
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                    
                    {/* Hover controls overlay */}
                    <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-3">
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenDraft(draft); }}
                        className="p-2 bg-brand text-black rounded-full hover:scale-110 transition-transform"
                        title="打开项目"
                      >
                        <Play className="w-4 h-4 fill-current" />
                      </button>
                      <button
                        onClick={(e) => handleDuplicateDraft(draft, e)}
                        className="p-2 bg-dark-bg/80 border border-dark-border text-white rounded-full hover:text-brand hover:scale-110 transition-all"
                        title="复制项目"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => handleDeleteDraft(draft.id, e)}
                        className="p-2 bg-dark-bg/80 border border-dark-border text-red-400 rounded-full hover:bg-red-500/20 hover:scale-110 transition-all"
                        title="删除项目"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Info footer */}
                  <div className="p-3 bg-dark-card space-y-2">
                    <div className="flex items-start justify-between">
                      <h4 className="text-xs font-bold text-white truncate max-w-[70%]" title={draft.title}>
                        {draft.title}
                      </h4>
                      <span className="text-[10px] text-dark-muted shrink-0">
                        {draft.date} {draft.time}
                      </span>
                    </div>

                    {/* Progress indicator */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-dark-subtle">
                          {draft.progress !== '待渲染' ? `生成: (${draft.progress})` : '状态: 待生成'}
                        </span>
                        <span className={`font-semibold ${
                          progressPercentage === 100 ? 'text-brand' : 'text-amber-500'
                        }`}>
                          {draft.progress === '待渲染' ? '待生成' : `${Math.round(progressPercentage)}%`}
                        </span>
                      </div>
                      
                      {/* Custom progress bar */}
                      <div className="w-full h-1 bg-dark-bg rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-brand to-emerald-400 transition-all duration-300" 
                          style={{ width: `${progressPercentage}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

          </div>
        </div>
      </div>
    </div>
  );
}
