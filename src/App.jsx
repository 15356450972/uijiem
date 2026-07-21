import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import ContentCreation from './components/ContentCreation';
import AccountManagement from './components/AccountManagement';
import Settings from './components/Settings';
import MailboxPool from './components/MailboxPool';
import WizstarAccounts from './components/WizstarAccounts';
import { WIZSTAR_API as API_BASE } from './config';

const STORAGE_KEY_DRAFTS = 'maocanju_drafts';

const safeArray = (value) => Array.isArray(value) ? value : [];

const normalizeDraft = (draft) => {
  if (!draft || typeof draft !== 'object') return null;
  const id = draft.id ?? draft.project_id ?? draft.title ?? Date.now();
  return {
    id: String(id),
    title: String(draft.title || draft.name || '未命名项目'),
    date: String(draft.date || ''),
    time: String(draft.time || ''),
    status: String(draft.status || '未生成'),
    progress: String(draft.progress || '0/0'),
    collection: String(draft.collection || ''),
    thumbnail: String(draft.thumbnail || ''),
    editable: draft.editable !== false,
  };
};

const normalizeDraftList = (value) => safeArray(value).map(normalizeDraft).filter(Boolean);

function loadLocalDrafts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DRAFTS);
    return normalizeDraftList(raw ? JSON.parse(raw) : []);
  } catch { return []; }
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[app-render-error]', error, info);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex-1 flex items-center justify-center bg-dark-bg p-6 text-dark-text">
        <div className="max-w-2xl rounded-xl border border-red-500/30 bg-red-500/10 p-5 shadow-xl">
          <div className="text-base font-semibold text-red-200">页面渲染失败</div>
          <div className="mt-2 text-sm text-red-100/80">已阻止整页黑屏。请把下面这段错误发给我继续定位。</div>
          <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-xs text-red-100">
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </pre>
        </div>
      </div>
    );
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState('creator');
  const [activeDraft, setActiveDraft] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const refreshDrafts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects`);
      if (!res.ok) throw new Error('projects api failed');
      const data = await res.json();
      setDrafts(normalizeDraftList(data.data));
    } catch (e) {
      console.warn('读取后端项目失败，临时回退到浏览器本地缓存:', e);
      setDrafts(loadLocalDrafts());
    }
  }, []);

  useEffect(() => {
    refreshDrafts();
  }, [refreshDrafts]);

  const handleSetDrafts = useCallback(async (nextDraftsOrUpdater) => {
    const baseDrafts = normalizeDraftList(drafts);
    const nextDrafts = normalizeDraftList(typeof nextDraftsOrUpdater === 'function'
      ? nextDraftsOrUpdater(baseDrafts)
      : nextDraftsOrUpdater);

    const currentMap = new Map(baseDrafts.map(d => [String(d.id), d]));
    const nextMap = new Map(nextDrafts.map(d => [String(d.id), d]));

    try {
      for (const oldDraft of baseDrafts) {
        if (!nextMap.has(String(oldDraft.id))) {
          await fetch(`${API_BASE}/projects/${encodeURIComponent(oldDraft.id)}`, { method: 'DELETE' });
        }
      }

      for (const draft of nextDrafts) {
        const existed = currentMap.has(String(draft.id));
        await fetch(`${API_BASE}/projects${existed ? `/${encodeURIComponent(draft.id)}` : ''}`, {
          method: existed ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
      }

      setDrafts(nextDrafts);
      localStorage.setItem(STORAGE_KEY_DRAFTS, JSON.stringify(nextDrafts));
      refreshDrafts();
    } catch (e) {
      console.error('保存项目失败:', e);
      alert(`保存项目失败: ${e.message}`);
      setDrafts(nextDrafts);
    }
  }, [drafts, refreshDrafts]);

  const handleOpenDraft = (draft) => {
    setActiveDraft(draft);
  };

  const handleBackToDrafts = () => {
    setActiveDraft(null);
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'creator':
        if (activeDraft) {
          return (
            <ContentCreation 
              activeDraft={activeDraft} 
              onBack={handleBackToDrafts}
              onProjectChanged={refreshDrafts}
            />
          );
        }
        return (
          <Dashboard 
            drafts={drafts} 
            setDrafts={handleSetDrafts} 
            onOpenDraft={handleOpenDraft}
            onRefreshDrafts={refreshDrafts}
          />
        );
      case 'wizstar-mailbox':
        return <MailboxPool onLoginComplete={() => setActiveTab('wizstar-accounts')} />;
      case 'wizstar-accounts':
        return <WizstarAccounts onOpenGoogleLogin={() => setActiveTab('wizstar-mailbox')} />;
      case 'accounts':
        return <AccountManagement />;
      case 'settings':
        return <Settings />;
      default:
        return (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-dark-muted">页面开发中...</span>
          </div>
        );
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-dark-bg text-dark-text select-none">
      {/* Main app body */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Sidebar navigation */}
        <Sidebar 
          activeTab={activeTab} 
          setActiveTab={setActiveTab}
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
        />

        {/* Content Area panel */}
        <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/30">
          <AppErrorBoundary resetKey={`${activeTab}:${activeDraft?.id || ''}`}>
            {renderContent()}
          </AppErrorBoundary>
        </div>
      </div>
    </div>
  );
}
