import React, { useState } from 'react';
import { 
  Users2, 
  Plus, 
  RefreshCw, 
  Trash2, 
  UserCheck, 
  UserX, 
  ShieldCheck, 
  KeyRound, 
  ExternalLink,
  QrCode,
  Globe
} from 'lucide-react';

export default function AccountManagement() {
  const [accounts, setAccounts] = useState([]);

  const [showAddModal, setShowShowAddModal] = useState(false);
  const [newAccountPlatform, setNewAccountPlatform] = useState('抖音');
  const [newAccountName, setNewAccountName] = useState('');
  const [simulatedQRStep, setSimulatedQRStep] = useState(0); // 0: input details, 1: QR scan simulation, 2: complete

  const platforms = [
    { name: '抖音', color: 'bg-black text-white border-zinc-800' },
    { name: '快手', color: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
    { name: '小红书', color: 'bg-red-500/10 text-red-400 border-red-500/20' },
    { name: '微信视频号', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    { name: '哔哩哔哩', color: 'bg-pink-500/10 text-pink-400 border-pink-500/20' },
  ];

  const handleToggleSelect = (id) => {
    setAccounts(accounts.map(acc => acc.id === id ? { ...acc, selected: !acc.selected } : acc));
  };

  const handleSelectAll = (val) => {
    setAccounts(accounts.map(acc => ({ ...acc, selected: val })));
  };

  const handleDelete = (id) => {
    if (confirm('确定要移除这个账号吗？删除后批量发布时将无法推送到此账号。')) {
      setAccounts(accounts.filter(acc => acc.id !== id));
    }
  };

  const handleRefreshCookie = (id) => {
    setAccounts(accounts.map(acc => {
      if (acc.id === id) {
        return {
          ...acc,
          status: '正常',
          lastSync: '刚刚'
        };
      }
      return acc;
    }));
    alert('账号状态及发布Cookie已刷新，连接正常！');
  };

  // Add simulated account pipeline
  const triggerAddAccount = () => {
    if (!newAccountName) {
      alert('请输入账号昵称！');
      return;
    }
    setSimulatedQRStep(1);
    setTimeout(() => {
      // Simulate successful scan after 2.5s
      const newAcc = {
        id: String(Date.now()),
        name: newAccountName,
        platform: newAccountPlatform,
        avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=80',
        followers: '0',
        status: '正常',
        lastSync: '刚刚',
        selected: true
      };
      setAccounts([...accounts, newAcc]);
      setSimulatedQRStep(2);
      setTimeout(() => {
        // Reset states
        setShowShowAddModal(false);
        setSimulatedQRStep(0);
        setNewAccountName('');
      }, 1000);
    }, 2500);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/20">
      {/* Page Header */}
      <div className="h-14 border-b border-dark-border px-6 flex items-center justify-between shrink-0 bg-dark-bg/40">
        <div className="flex items-center space-x-2">
          <Users2 className="w-4 h-4 text-brand" />
          <span className="text-sm font-bold text-white">多平台账号管理</span>
          <span className="text-[10px] bg-dark-border text-dark-muted px-2 py-0.5 rounded">
            已选账号: {accounts.filter(a => a.selected).length} / {accounts.length}
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button 
            onClick={() => handleSelectAll(true)}
            className="px-3 py-1.5 border border-dark-border hover:border-brand/40 bg-dark-card hover:bg-dark-cardHover rounded-lg text-xs text-dark-muted hover:text-white transition-all"
          >
            全选
          </button>
          <button 
            onClick={() => handleSelectAll(false)}
            className="px-3 py-1.5 border border-dark-border hover:border-brand/40 bg-dark-card hover:bg-dark-cardHover rounded-lg text-xs text-dark-muted hover:text-white transition-all"
          >
            取消全选
          </button>
          <button 
            onClick={() => setShowShowAddModal(true)}
            className="flex items-center space-x-1 px-4 py-1.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-lg shadow-brand/10"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加账号</span>
          </button>
        </div>
      </div>

      {/* Grid Content */}
      <div className="flex-1 overflow-y-auto p-6 no-scrollbar flex flex-col justify-center">
        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto space-y-5 animate-in fade-in duration-300">
            <div className="w-16 h-16 rounded-full bg-dark-card border border-dark-border flex items-center justify-center text-dark-muted shadow-[0_0_15px_rgba(16,185,129,0.03)]">
              <Users2 className="w-8 h-8 text-brand stroke-[1.5]" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-sm font-bold text-white">暂无绑定的发布账号</h3>
              <p className="text-xs text-dark-muted leading-relaxed">
                一站式支持抖音、快手、小红书、微信视频号、哔哩哔哩等多渠道一键同步发布。点击右上角“添加账号”绑定您的第一个分发账号！
              </p>
            </div>
            <button 
              type="button"
              onClick={() => setShowShowAddModal(true)}
              className="flex items-center space-x-1.5 px-6 py-2.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-md shadow-brand/10 hover:scale-105"
            >
              <Plus className="w-4 h-4" />
              <span>绑定第一个分发账号</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {accounts.map(acc => {
              const isNormal = acc.status === '正常';
              return (
                <div 
                  key={acc.id}
                  className={`border rounded-xl p-4.5 bg-dark-card/40 transition-all flex flex-col justify-between space-y-4 ${
                    acc.selected 
                      ? 'border-brand/30 bg-brand/[0.02] shadow-[0_0_15px_rgba(16,185,129,0.02)]' 
                      : 'border-dark-border hover:border-dark-subtle'
                  }`}
                >
                  {/* Header row */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3 min-w-0">
                      {/* Select Checkbox */}
                      <input 
                        type="checkbox" 
                        checked={acc.selected} 
                        onChange={() => handleToggleSelect(acc.id)}
                        className="w-4 h-4 rounded border-dark-border text-brand focus:ring-brand focus:ring-opacity-25 bg-dark-input cursor-pointer"
                      />

                      {/* Avatar */}
                      <div className="relative shrink-0">
                        <img src={acc.avatar} alt={acc.name} className="w-10 h-10 rounded-full object-cover border border-dark-border" />
                        <span className="absolute -bottom-1 -right-1 text-[9px] bg-black border border-dark-border text-white font-bold px-1 py-0.2 rounded scale-90">
                          {acc.platform}
                        </span>
                      </div>

                      {/* Details */}
                      <div className="min-w-0">
                        <h4 className="text-xs font-bold text-white truncate max-w-[120px]">{acc.name}</h4>
                        <p className="text-[10px] text-dark-muted">粉丝数: <span className="text-white font-semibold">{acc.followers}</span></p>
                      </div>
                    </div>

                    {/* Status Indicator */}
                    <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full shrink-0 flex items-center space-x-1 ${
                      isNormal 
                        ? 'bg-brand/10 text-brand border border-brand/20' 
                        : 'bg-red-500/10 text-red-400 border border-red-500/20'
                    }`}>
                      {isNormal ? <UserCheck className="w-2.5 h-2.5" /> : <UserX className="w-2.5 h-2.5" />}
                      <span>{acc.status}</span>
                    </span>
                  </div>

                  {/* Info block */}
                  <div className="bg-dark-input/50 border border-dark-border/40 rounded-lg p-2 flex items-center justify-between text-[10px] text-dark-muted">
                    <div className="flex items-center space-x-1">
                      <ShieldCheck className="w-3 h-3 text-brand" />
                      <span>自动同步Cookie</span>
                    </div>
                    <div>同步时间: <span className="text-white">{acc.lastSync}</span></div>
                  </div>

                  {/* Footer Controls Row */}
                  <div className="flex items-center justify-between pt-1 border-t border-dark-border/40">
                    <button 
                      onClick={() => handleRefreshCookie(acc.id)}
                      className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-brand transition-colors p-1"
                      title="刷新Cookie授权"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>刷新凭证</span>
                    </button>

                    <div className="flex items-center space-x-1">
                      <button 
                        onClick={() => alert(`已打开 ${acc.platform} 对应控制台页面...`)}
                        className="p-1 hover:bg-dark-card rounded text-dark-muted hover:text-white transition-colors"
                        title="打开后台"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        onClick={() => handleDelete(acc.id)}
                        className="p-1 hover:bg-red-500/10 rounded text-dark-muted hover:text-red-400 transition-colors"
                        title="移除账号"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Account Modal matching custom electron overlays */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-dark-sidebar border border-dark-border rounded-xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
            {/* Modal Header */}
            <div className="h-12 border-b border-dark-border px-5 flex items-center justify-between bg-dark-bg">
              <span className="text-xs font-bold text-white">添加新平台账号</span>
              <button 
                onClick={() => setShowAddModal(false)}
                className="text-dark-muted hover:text-white text-xs"
              >
                ✕
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-4">
              {simulatedQRStep === 0 && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-dark-muted uppercase">发布平台</label>
                    <div className="grid grid-cols-3 gap-2">
                      {platforms.map(p => (
                        <button
                          key={p.name}
                          onClick={() => setNewAccountPlatform(p.name)}
                          className={`py-2 px-1 border rounded-lg text-xs font-semibold text-center transition-all ${
                            newAccountPlatform === p.name 
                              ? 'bg-brand text-black border-brand shadow-[0_0_10px_rgba(16,185,129,0.15)]' 
                              : 'bg-dark-input text-dark-muted border-dark-border hover:border-dark-subtle hover:text-white'
                          }`}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-dark-muted uppercase">账号昵称</label>
                    <input 
                      type="text"
                      placeholder="例如: 猫蚕剧小分队_01"
                      value={newAccountName}
                      onChange={(e) => setNewAccountName(e.target.value)}
                      className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2.5 text-white placeholder-dark-subtle"
                    />
                  </div>

                  <div className="bg-dark-input border border-dark-border rounded-lg p-3 flex items-start space-x-2.5">
                    <KeyRound className="w-4 h-4 text-brand shrink-0 mt-0.5" />
                    <div className="text-[10px] text-dark-muted leading-relaxed">
                      <span className="text-white font-bold block mb-0.5">安全声明</span>
                      我们将使用高强度本地加密保存您的平台登录Cookie凭证，绝不会上传至第三方服务器。
                    </div>
                  </div>

                  <button 
                    onClick={triggerAddAccount}
                    className="w-full flex items-center justify-center space-x-1.5 py-2.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-md shadow-brand/10"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>扫码登录或Cookie导入</span>
                  </button>
                </>
              )}

              {simulatedQRStep === 1 && (
                <div className="flex flex-col items-center justify-center py-6 text-center space-y-4">
                  <div className="p-4 bg-white rounded-lg relative shadow-inner">
                    {/* Simulated QRCode overlay with scanner beam */}
                    <div className="w-36 h-36 bg-zinc-100 border border-zinc-300 flex items-center justify-center relative overflow-hidden">
                      <QrCode className="w-28 h-28 text-black opacity-90 animate-pulse" />
                      <div className="absolute w-full h-0.5 bg-brand top-0 left-0 animate-[bounce_2s_infinite]" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-white">正在等待手机扫码授权...</p>
                    <p className="text-[10px] text-dark-muted">请打开手机端 {newAccountPlatform} App 扫描二维码</p>
                  </div>
                  <div className="flex items-center justify-center space-x-2 text-[10px] text-brand">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>连接安全隧道中...</span>
                  </div>
                </div>
              )}

              {simulatedQRStep === 2 && (
                <div className="flex flex-col items-center justify-center py-10 text-center space-y-4">
                  <div className="w-12 h-12 rounded-full bg-brand/10 border border-brand flex items-center justify-center text-brand font-bold text-lg animate-ping">
                    ✓
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-brand">扫码授权成功！</p>
                    <p className="text-[10px] text-dark-muted">正在加密保存 Cookie 并同步至本地凭据库...</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
