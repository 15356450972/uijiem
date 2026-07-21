import React, { useState, useEffect, useCallback } from 'react';
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
  Globe,
  LogIn,
  Loader2,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

export default function AccountManagement() {
  const [accounts, setAccounts] = useState([]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newAccountPlatform, setNewAccountPlatform] = useState('抖音');
  const [newAccountName, setNewAccountName] = useState('');
  const [simulatedQRStep, setSimulatedQRStep] = useState(0); // 0: input details, 1: QR scan simulation, 2: complete

  // Dola Google login state
  const [showDolaLogin, setShowDolaLogin] = useState(false);
  const [dolaEmail, setDolaEmail] = useState('');
  const [dolaPassword, setDolaPassword] = useState('');
  const [dolaLoginStep, setDolaLoginStep] = useState('idle'); // idle | running | success | error
  const [dolaLoginProgress, setDolaLoginProgress] = useState('');
  const [dolaLoginError, setDolaLoginError] = useState('');

  // Dola batch login state
  const [showBatchLogin, setShowBatchLogin] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchConcurrency, setBatchConcurrency] = useState(2);
  const [BatchStep, setBatchStep] = useState('idle'); // idle | running | done
  const [BatchResults, setBatchResults] = useState({}); // { index: { email, step, status } }
  const [batchSummary, setBatchSummary] = useState(null);

  // Listen for Dola batch login progress events
  useEffect(() => {
    if (!window.electronAPI?.onDolaBatchProgress) return;
    const unsubscribe = window.electronAPI.onDolaBatchProgress((data) => {
      if (data?.step === 'batch_complete') {
        setBatchSummary(data.data);
        setBatchStep('done');
        return;
      }
      if (data?.index !== undefined) {
        setBatchResults(prev => ({
          ...prev,
          [data.index]: {
            email: data.email,
            step: data.step,
            ok: data.step === 'saved_to_db' ? data.data?.ok : prev[data.index]?.ok,
          }
        }));
      }
    });
    return unsubscribe;
  }, []);

  // Listen for Dola login progress events from Electron main process
  useEffect(() => {
    if (!window.electronAPI?.onDolaLoginProgress) return;
    const unsubscribe = window.electronAPI.onDolaLoginProgress((data) => {
      if (data?.step) {
        const stepLabels = {
          launching: '正在启动浏览器...',
          chrome_ready: '浏览器已就绪',
          waiting_dola_load: '正在加载 Dola 页面...',
          clicking_login: '点击登录按钮...',
          login_clicked: '已点击登录',
          clicking_google_login: '点击 Google 登录...',
          google_login_clicked: '已点击 Google 登录',
          waiting_google_page: '等待 Google 登录页...',
          google_page_loaded: 'Google 登录页已加载',
          inputting_email: '输入邮箱中...',
          email_next: '邮箱已输入，点击下一步',
          waiting_password_page: '等待密码输入页...',
          captcha_required: '需要人机验证，请在浏览器中完成',
          waiting_captcha_solve: '等待验证码完成...',
          captcha_solved: '验证码已完成',
          inputting_password: '输入密码中...',
          password_next: '密码已输入，点击下一步',
          waiting_terms: '等待条款页面...',
          accepting_terms: '接受 Google Workspace 条款',
          waiting_consent: '等待授权页面...',
          clicking_consent: '点击授权 Dola',
          waiting_dola_redirect: '等待跳转回 Dola...',
          dola_redirected: '已跳转回 Dola',
          clicking_dola_continue: '点击继续按钮...',
          dola_continue_clicked: '已点击继续',
          confirming_age: '确认年龄...',
          waiting_dola_chat: '等待 Dola 聊天页加载...',
          extracting_state: '提取账号信息...',
          login_complete: '登录完成！',
        };
        setDolaLoginProgress(stepLabels[data.step] || data.step);
      }
    });
    return unsubscribe;
  }, []);

  const handleBatchLogin = useCallback(async () => {
    const lines = batchText.trim().split('\n').filter(l => l.trim());
    const accounts = lines.map(line => {
      const [email, password] = line.trim().split('|');
      return { email: (email || '').trim(), password: (password || '').trim() };
    }).filter(a => a.email && a.password);
    if (accounts.length === 0) {
      alert('请输入有效的账号密码，每行一个，格式: email|password');
      return;
    }
    setBatchStep('running');
    setBatchResults({});
    setBatchSummary(null);
    try {
      const result = await window.electronAPI?.dolaBatchLogin({
        accounts,
        concurrency: batchConcurrency,
      });
      if (result?.ok) {
        setBatchSummary({ succeeded: result.succeeded, failed: result.failed, total: accounts.length });
        setBatchStep('done');
      } else {
        setBatchStep('idle');
        alert(result?.error || '批量登录失败');
      }
    } catch (e) {
      setBatchStep('idle');
      alert(e.message || String(e));
    }
  }, [batchText, batchConcurrency]);

  const handleDolaLogin = useCallback(async () => {
    if (!dolaEmail || !dolaPassword) {
      setDolaLoginError('请输入邮箱和密码');
      return;
    }
    setShowAddModal(false);
    setShowDolaLogin(true);
    setDolaLoginStep('running');
    setDolaLoginError('');
    setDolaLoginProgress('正在启动...');
    try {
      const result = await window.electronAPI?.dolaGoogleLogin({
        email: dolaEmail,
        password: dolaPassword,
        visible: true,
        keepOpen: false,
      });
      if (result?.ok) {
        setDolaLoginStep('success');
        setDolaLoginProgress('登录成功！');
        setTimeout(() => {
          setShowDolaLogin(false);
          setDolaLoginStep('idle');
          setDolaEmail('');
          setDolaPassword('');
        }, 2000);
      } else {
        setDolaLoginStep('error');
        setDolaLoginError(result?.error || '登录失败');
      }
    } catch (e) {
      setDolaLoginStep('error');
      setDolaLoginError(e.message || String(e));
    }
  }, [dolaEmail, dolaPassword]);

  const platforms = [
    { name: '抖音', color: 'bg-black text-white border-zinc-800' },
    { name: '快手', color: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
    { name: '小红书', color: 'bg-red-500/10 text-red-400 border-red-500/20' },
    { name: '微信视频号', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    { name: '哔哩哔哩', color: 'bg-pink-500/10 text-pink-400 border-pink-500/20' },
    { name: 'Dola', color: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
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
    if (newAccountPlatform === 'Dola') {
      // Dola uses Google login flow, not QR scan
      setShowAddModal(false);
      setShowDolaLogin(true);
      return;
    }
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
        setShowAddModal(false);
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
            onClick={() => setShowAddModal(true)}
            className="flex items-center space-x-1 px-4 py-1.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-lg shadow-brand/10"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加账号</span>
          </button>
          <button 
            onClick={() => setShowBatchLogin(true)}
            className="flex items-center space-x-1 px-4 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg text-xs text-blue-400 font-bold transition-all"
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Dola 批量登录</span>
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
              onClick={() => setShowAddModal(true)}
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

                  {newAccountPlatform !== 'Dola' && (
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
                  )}

                  {newAccountPlatform === 'Dola' && (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-dark-muted uppercase">Google 邮箱</label>
                        <input
                          type="email"
                          placeholder="example@ffcfd.cfd"
                          value={dolaEmail}
                          onChange={(e) => setDolaEmail(e.target.value)}
                          className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2.5 text-white placeholder-dark-subtle"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-bold text-dark-muted uppercase">密码</label>
                        <input
                          type="password"
                          placeholder="••••••••"
                          value={dolaPassword}
                          onChange={(e) => setDolaPassword(e.target.value)}
                          className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2.5 text-white placeholder-dark-subtle"
                        />
                      </div>
                      <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3 flex items-start space-x-2.5">
                        <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                        <div className="text-[10px] text-dark-muted leading-relaxed">
                          <span className="text-white font-bold block mb-0.5">Dola Google 自动登录</span>
                          使用反检测浏览器自动完成 Google OAuth 登录，提取 Cookie 和 access_token。
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="bg-dark-input border border-dark-border rounded-lg p-3 flex items-start space-x-2.5">
                    <KeyRound className="w-4 h-4 text-brand shrink-0 mt-0.5" />
                    <div className="text-[10px] text-dark-muted leading-relaxed">
                      <span className="text-white font-bold block mb-0.5">安全声明</span>
                      我们将使用高强度本地加密保存您的平台登录Cookie凭证，绝不会上传至第三方服务器。
                    </div>
                  </div>

                  {newAccountPlatform === 'Dola' ? (
                    <button
                      onClick={handleDolaLogin}
                      disabled={!dolaEmail || !dolaPassword}
                      className="w-full flex items-center justify-center space-x-1.5 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs text-white font-bold transition-all shadow-md shadow-blue-500/10"
                    >
                      <LogIn className="w-4 h-4" />
                      <span>开始 Google 登录</span>
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={triggerAddAccount}
                        className="w-full flex items-center justify-center space-x-1.5 py-2.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-md shadow-brand/10"
                      >
                        <QrCode className="w-4 h-4" />
                        <span>扫码登录或Cookie导入</span>
                      </button>

                      <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t border-dark-border" />
                        </div>
                        <div className="relative flex justify-center">
                          <span className="bg-dark-sidebar px-2 text-[10px] text-dark-muted">或</span>
                        </div>
                      </div>

                      <button
                        onClick={() => {
                          setShowAddModal(false);
                          setShowDolaLogin(true);
                        }}
                        className="w-full flex items-center justify-center space-x-1.5 py-2.5 bg-white hover:bg-zinc-200 rounded-lg text-xs text-black font-bold transition-all shadow-md"
                      >
                        <LogIn className="w-4 h-4" />
                        <span>Dola Google 账号登录</span>
                      </button>
                    </>
                  )}
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

      {/* Dola Google Login Modal */}
      {showDolaLogin && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-dark-sidebar border border-dark-border rounded-xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
            {/* Modal Header */}
            <div className="h-12 border-b border-dark-border px-5 flex items-center justify-between bg-dark-bg">
              <div className="flex items-center space-x-2">
                <LogIn className="w-4 h-4 text-white" />
                <span className="text-xs font-bold text-white">Dola Google 账号登录</span>
              </div>
              <button
                onClick={() => {
                  if (dolaLoginStep !== 'running') {
                    setShowDolaLogin(false);
                    setDolaLoginStep('idle');
                    setDolaLoginError('');
                  }
                }}
                className="text-dark-muted hover:text-white text-xs"
                disabled={dolaLoginStep === 'running'}
              >
                ✕
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-4">
              {dolaLoginStep === 'idle' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-dark-muted uppercase">Google 邮箱</label>
                    <input
                      type="email"
                      placeholder="example@gmail.com"
                      value={dolaEmail}
                      onChange={(e) => setDolaEmail(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') document.getElementById('dola-password-input')?.focus(); }}
                      className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2.5 text-white placeholder-dark-subtle"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-dark-muted uppercase">密码</label>
                    <input
                      id="dola-password-input"
                      type="password"
                      placeholder="••••••••"
                      value={dolaPassword}
                      onChange={(e) => setDolaPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleDolaLogin(); }}
                      className="w-full bg-dark-input text-xs border border-dark-border focus:border-brand focus:outline-none rounded-lg p-2.5 text-white placeholder-dark-subtle"
                    />
                  </div>

                  <div className="bg-dark-input border border-dark-border rounded-lg p-3 flex items-start space-x-2.5">
                    <ShieldCheck className="w-4 h-4 text-brand shrink-0 mt-0.5" />
                    <div className="text-[10px] text-dark-muted leading-relaxed">
                      <span className="text-white font-bold block mb-0.5">反检测指纹模拟</span>
                      使用持久化浏览器配置文件和反自动化检测脚本，模拟真实用户指纹，最大程度避免 Google 人机验证 (CAPTCHA)。
                    </div>
                  </div>

                  <button
                    onClick={handleDolaLogin}
                    className="w-full flex items-center justify-center space-x-1.5 py-2.5 bg-white hover:bg-zinc-200 rounded-lg text-xs text-black font-bold transition-all shadow-md"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>开始 Google 登录</span>
                  </button>
                </>
              )}

              {dolaLoginStep === 'running' && (
                <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                  <Loader2 className="w-8 h-8 text-white animate-spin" />
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-white">{dolaLoginProgress}</p>
                    <p className="text-[10px] text-dark-muted">请勿关闭窗口，登录流程进行中...</p>
                  </div>
                  <div className="w-full bg-dark-input rounded-full h-1 overflow-hidden">
                    <div className="bg-brand h-full animate-pulse transition-all" style={{ width: '60%' }} />
                  </div>
                </div>
              )}

              {dolaLoginStep === 'success' && (
                <div className="flex flex-col items-center justify-center py-10 text-center space-y-4">
                  <CheckCircle2 className="w-12 h-12 text-brand" />
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-brand">Dola Google 登录成功！</p>
                    <p className="text-[10px] text-dark-muted">账号信息已提取并保存</p>
                  </div>
                </div>
              )}

              {dolaLoginStep === 'error' && (
                <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                  <AlertCircle className="w-10 h-10 text-red-400" />
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-red-400">登录失败</p>
                    <p className="text-[10px] text-dark-muted break-all max-w-xs">{dolaLoginError}</p>
                  </div>
                  <button
                    onClick={() => {
                      setDolaLoginStep('idle');
                      setDolaLoginError('');
                    }}
                    className="px-4 py-2 bg-dark-input hover:bg-dark-card border border-dark-border rounded-lg text-xs text-white transition-all"
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Dola Batch Login Modal */}
      {showBatchLogin && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-dark-sidebar border border-dark-border rounded-xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
            {/* Modal Header */}
            <div className="h-12 border-b border-dark-border px-5 flex items-center justify-between bg-dark-bg">
              <div className="flex items-center space-x-2">
                <Globe className="w-4 h-4 text-blue-400" />
                <span className="text-xs font-bold text-white">Dola 批量 Google 登录</span>
              </div>
              <button
                onClick={() => {
                  if (BatchStep !== 'running') {
                    setShowBatchLogin(false);
                    setBatchStep('idle');
                    setBatchText('');
                    setBatchResults({});
                    setBatchSummary(null);
                  }
                }}
                className="text-dark-muted hover:text-white text-xs"
                disabled={BatchStep === 'running'}
              >
                ✕
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-4">
              {BatchStep === 'idle' && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-dark-muted uppercase">账号列表（每行一个，格式: 邮箱|密码）</label>
                    <textarea
                      placeholder="email1@ffcfd.cfd|password1&#10;email2@ffcfd.cfd|password2&#10;email3@ffcfd.cfd|password3"
                      value={batchText}
                      onChange={(e) => setBatchText(e.target.value)}
                      rows={8}
                      className="w-full bg-dark-input text-xs border border-dark-border focus:border-blue-500 focus:outline-none rounded-lg p-3 text-white placeholder-dark-subtle font-mono resize-none"
                    />
                  </div>

                  <div className="flex items-center space-x-3">
                    <label className="text-[10px] font-bold text-dark-muted uppercase">并发数</label>
                    <input
                      type="number"
                      min="1"
                      max="5"
                      value={batchConcurrency}
                      onChange={(e) => setBatchConcurrency(Math.max(1, Math.min(5, parseInt(e.target.value) || 2)))}
                      className="w-16 bg-dark-input text-xs border border-dark-border focus:border-blue-500 focus:outline-none rounded-lg p-2 text-white text-center"
                    />
                    <span className="text-[10px] text-dark-muted">同时登录的账号数量（建议 1-3）</span>
                  </div>

                  <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3 flex items-start space-x-2.5">
                    <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                    <div className="text-[10px] text-dark-muted leading-relaxed">
                      <span className="text-white font-bold block mb-0.5">批量自动登录</span>
                      将为每个账号启动独立的浏览器实例，自动完成 Google OAuth 登录，提取 Cookie 并保存到账号库。
                    </div>
                  </div>

                  <button
                    onClick={handleBatchLogin}
                    disabled={!batchText.trim()}
                    className="w-full flex items-center justify-center space-x-1.5 py-2.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs text-white font-bold transition-all shadow-md shadow-blue-500/10"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>开始批量登录（{batchText.trim().split('\n').filter(l => l.trim() && l.includes('|')).length} 个账号）</span>
                  </button>
                </>
              )}

              {BatchStep === 'running' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-center space-x-2 py-2">
                    <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
                    <span className="text-xs font-bold text-white">批量登录进行中...</span>
                  </div>
                  <div className="space-y-1.5 max-h-80 overflow-y-auto no-scrollbar">
                    {Object.entries(BatchResults)
                      .sort(([a], [b]) => parseInt(a) - parseInt(b))
                      .map(([idx, info]) => (
                        <div key={idx} className="flex items-center justify-between bg-dark-input/50 border border-dark-border/40 rounded-lg px-3 py-2">
                          <div className="flex items-center space-x-2 min-w-0">
                            {info.ok === true ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-brand shrink-0" />
                            ) : info.ok === false ? (
                              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                            ) : (
                              <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
                            )}
                            <span className="text-[10px] text-white truncate">{info.email}</span>
                          </div>
                          <span className="text-[10px] text-dark-muted shrink-0 ml-2">
                            {info.step === 'starting' ? '启动中' :
                             info.step === 'saved_to_db' ? '已保存' :
                             info.step === 'login_complete' ? '登录完成' :
                             info.step?.includes('email') ? '输入邮箱' :
                             info.step?.includes('password') ? '输入密码' :
                             info.step?.includes('terms') ? '接受条款' :
                             info.step?.includes('consent') ? '授权中' :
                             info.step?.includes('redirect') ? '跳转中' :
                             info.step?.includes('age') ? '确认年龄' :
                             info.step || '处理中'}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {BatchStep === 'done' && batchSummary && (
                <div className="space-y-4">
                  <div className="flex flex-col items-center justify-center py-4 text-center space-y-3">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center ${batchSummary.failed === 0 ? 'bg-brand/10 border border-brand text-brand' : 'bg-orange-500/10 border border-orange-500/30 text-orange-400'}`}>
                      {batchSummary.failed === 0 ? <CheckCircle2 className="w-6 h-6" /> : <AlertCircle className="w-6 h-6" />}
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-bold text-white">批量登录完成</p>
                      <p className="text-[10px] text-dark-muted">
                        成功 <span className="text-brand font-bold">{batchSummary.succeeded}</span> / 
                        失败 <span className="text-red-400 font-bold">{batchSummary.failed}</span> / 
                        共 {batchSummary.total} 个账号
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto no-scrollbar">
                    {Object.entries(BatchResults)
                      .sort(([a], [b]) => parseInt(a) - parseInt(b))
                      .map(([idx, info]) => (
                        <div key={idx} className="flex items-center justify-between bg-dark-input/50 border border-dark-border/40 rounded-lg px-3 py-2">
                          <div className="flex items-center space-x-2 min-w-0">
                            {info.ok ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-brand shrink-0" />
                            ) : (
                              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                            )}
                            <span className="text-[10px] text-white truncate">{info.email}</span>
                          </div>
                          <span className={`text-[10px] shrink-0 ml-2 ${info.ok ? 'text-brand' : 'text-red-400'}`}>
                            {info.ok ? '已保存到账号库' : '登录失败'}
                          </span>
                        </div>
                      ))}
                  </div>

                  <button
                    onClick={() => {
                      setShowBatchLogin(false);
                      setBatchStep('idle');
                      setBatchText('');
                      setBatchResults({});
                      setBatchSummary(null);
                    }}
                    className="w-full py-2.5 bg-dark-input hover:bg-dark-card border border-dark-border rounded-lg text-xs text-white transition-all"
                  >
                    完成
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
