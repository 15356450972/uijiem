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

function loadLocalDrafts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DRAFTS);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
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
      setDrafts(data.data || []);
    } catch (e) {
      console.warn('读取后端项目失败，临时回退到浏览器本地缓存:', e);
      setDrafts(loadLocalDrafts());
    }
  }, []);

  useEffect(() => {
    refreshDrafts();
  }, [refreshDrafts]);

  const handleSetDrafts = useCallback(async (nextDraftsOrUpdater) => {
    const nextDrafts = typeof nextDraftsOrUpdater === 'function'
      ? nextDraftsOrUpdater(drafts)
      : nextDraftsOrUpdater;

    const currentMap = new Map(drafts.map(d => [String(d.id), d]));
    const nextMap = new Map(nextDrafts.map(d => [String(d.id), d]));

    try {
      for (const oldDraft of drafts) {
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
        return <MailboxPool />;
      case 'wizstar-accounts':
        return <WizstarAccounts />;
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
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
