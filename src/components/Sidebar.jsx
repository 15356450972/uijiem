import React from 'react';
import { 
  PenTool, 
  Settings, 
  Users2,
  Mail,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react';

export default function Sidebar({ activeTab, setActiveTab, collapsed, setCollapsed }) {
  const menuItems = [
    { id: 'creator', label: '内容创作', icon: PenTool, category: '常用' },
    { id: 'wizstar-mailbox', label: '邮箱库', icon: Mail, category: '渠道一' },
    { id: 'wizstar-accounts', label: '账号库', icon: KeyRound, category: '渠道一' },
    { id: 'accounts', label: '账号管理', icon: Users2, category: '个人' },
    { id: 'settings', label: '设置', icon: Settings, category: '个人' },
  ];

  const categories = ['常用', '渠道一', '个人'];

  return (
    <div className={`${collapsed ? 'w-14' : 'w-52'} bg-dark-sidebar border-r border-dark-border flex flex-col justify-start h-full shrink-0 select-none transition-all duration-200`}>
      {/* Collapse toggle */}
      <div className={`flex ${collapsed ? 'justify-center' : 'justify-end'} px-2 pt-3 pb-1`}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-md text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
      </div>

      {/* Menu List */}
      <div className={`${collapsed ? 'py-4 px-1.5' : 'py-4 px-3'} flex flex-col space-y-5 flex-1 overflow-y-auto no-scrollbar`}>
        {categories.map((cat) => (
          <div key={cat} className="space-y-1.5">
            {!collapsed && (
              <div className="px-3 text-[11px] font-semibold text-dark-subtle uppercase tracking-wider">
                {cat}
              </div>
            )}
            <div className="space-y-1">
              {menuItems
                .filter((item) => item.category === cat)
                .map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id)}
                      title={collapsed ? item.label : undefined}
                      className={`w-full flex items-center ${collapsed ? 'justify-center px-2' : 'space-x-3 px-3'} py-2.5 rounded-lg text-sm font-medium transition-all ${
                        isActive
                          ? 'bg-brand/10 text-brand border-l-2 border-brand shadow-[inset_0_0_8px_rgba(16,185,129,0.05)] font-semibold'
                          : 'text-dark-muted hover:text-white hover:bg-dark-card/50'
                      }`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-brand' : ''}`} />
                      {!collapsed && <span>{item.label}</span>}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
