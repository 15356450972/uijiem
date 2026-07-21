import React, { useState, useEffect } from 'react';
import { 
  Mail, 
  Plus, 
  Trash2, 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  RefreshCw,
  AlertCircle,
  Upload,
  Zap
} from 'lucide-react';
import { WIZSTAR_API as API_BASE } from '../config';

const CHANNEL_LABELS = {
  wizstar: '渠道一',
  quickframe: '渠道三',
  oiioii: '渠道四',
  dola: '渠道六',
  lovart: '渠道七',
  oreateai: '渠道八',
  framia: '渠道九',
  tensorart: '渠道十',
};

const usageStatusText = (usage) => {
  if (usage.status === 'registered') return '·已使用';
  if (usage.status === 'reserved') return '·占用中';
  if (usage.status === 'released') return '·可用';
  if (usage.status !== 'failed') return '';
  const retryAfter = Number(usage.retry_after || 0);
  const remainingSeconds = retryAfter - Date.now() / 1000;
  if (remainingSeconds <= 0) return '·可重试';
  if (remainingSeconds < 3600) return `·冷却${Math.ceil(remainingSeconds / 60)}分钟`;
  return `·冷却${Math.ceil(remainingSeconds / 3600)}小时`;
};

export default function MailboxPool({ onLoginComplete }) {
  const [mailboxes, setMailboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBatchForm, setShowBatchForm] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [googleBatchText, setGoogleBatchText] = useState('');
  const [googleBatchConcurrency, setGoogleBatchConcurrency] = useState(2);
  const [googleBatchStep, setGoogleBatchStep] = useState('idle');
  const [googleBatchResults, setGoogleBatchResults] = useState({});
  const [googleBatchSummary, setGoogleBatchSummary] = useState(null);
  const [formData, setFormData] = useState({
    provider: 'microsoft',
    email: '',
    password: '',
    client_id: '',
    refresh_token: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [showLoginForm, setShowLoginForm] = useState(false);
  const [selectedMailboxIds, setSelectedMailboxIds] = useState([]);
  const [loggingIn, setLoggingIn] = useState(false);
  const [activeLoginMailboxId, setActiveLoginMailboxId] = useState(null);
  const [loginProgress, setLoginProgress] = useState(null);

  const fetchMailboxes = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/mailboxes`);
      const data = await res.json();
      setMailboxes(data.data || []);
      setError('');
    } catch (e) {
      setError('无法连接到全局邮箱库，请确认 Python 服务已启动');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMailboxes();
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onWizstarLoginProgress) return undefined;
    const unsubscribe = window.electronAPI.onWizstarLoginProgress((data) => {
      const labels = {
        launching_chrome: '正在启动 Chrome...',
        opening_wizstar: '正在打开 Wizstar...',
        opening_lovart: '正在打开 Wizstar...',
        wizstar_register_clicked: '正在切换到 Wizstar 注册...',
        wizstar_login_clicked: '正在进入 Google 注册...',
        lovart_login_clicked: '正在进入 Google 登录...',
        google_oauth_opened: 'Google 登录页已打开',
        inputting_email: '正在输入 Google 邮箱...',
        email_retry_inserttext: '邮箱输入重试中...',
        email_retry_typing: '邮箱输入重试中...',
        email_input_verified: 'Google 邮箱已输入',
        email_next: '正在提交 Google 邮箱...',
        inputting_password: '正在输入 Google 密码...',
        password_next: '正在提交 Google 登录...',
        google_continue_clicked: '正在完成 Google 授权...',
        extracting_state: '正在获取 Wizstar Cookie...',
        login_complete: 'Cookie 获取成功，正在保存账号...',
      };
      setLoginProgress((current) => current ? {
        ...current,
        message: labels[data?.step] || data?.step || current.message,
      } : current);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onWizstarBatchProgress) return undefined;
    const unsubscribe = window.electronAPI.onWizstarBatchProgress((data) => {
      if (data?.step === 'batch_complete') {
        setGoogleBatchSummary(data.data || null);
        setGoogleBatchStep('done');
        return;
      }
      if (data?.index === undefined) return;
      setGoogleBatchResults((current) => ({
        ...current,
        [data.index]: {
          ...current[data.index],
          email: data.email,
          step: data.step,
          ok: data.step === 'saved_to_db' ? true : data.step === 'failed' ? false : current[data.index]?.ok,
          error: data.data?.error || current[data.index]?.error || '',
        },
      }));
    });
    return unsubscribe;
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    const hasMicrosoftOAuth = Boolean(formData.client_id.trim() && formData.refresh_token.trim());
    if (!formData.email || (formData.provider === 'google' ? !formData.password : (!formData.password && !hasMicrosoftOAuth))) {
      setError(formData.provider === 'google'
        ? 'Google 账号必须填写密码'
        : 'Microsoft 邮箱需填写账号密码，或填写完整的 client_id + refresh_token');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/mailboxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '添加失败');
      }
      setFormData({
        provider: 'microsoft',
        email: '',
        password: '',
        client_id: '',
        refresh_token: '',
      });
      setShowAddForm(false);
      fetchMailboxes();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleBatchImport = async (e) => {
    e.preventDefault();
    if (!batchText.trim()) return;
    setSubmitting(true);
    setSuccessMsg('');
    try {
      const res = await fetch(`${API_BASE}/mailboxes/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw_text: batchText }),
      });
      const responseText = await res.text();
      let result = {};
      try {
        result = responseText ? JSON.parse(responseText) : {};
      } catch {
        if (!res.ok) throw new Error(responseText || `导入失败（HTTP ${res.status}）`);
        throw new Error('导入接口返回了无效数据');
      }
      if (!res.ok) {
        throw new Error(result.detail || `导入失败（HTTP ${res.status}）`);
      }
      const { imported, errors, total } = result.data;
      setBatchText('');
      setShowBatchForm(false);
      setSuccessMsg(`成功导入 ${imported.length}/${total} 个邮箱${errors.length > 0 ? `，${errors.length} 个失败` : ''}`);
      if (errors.length > 0) {
        setError(errors.map(e => `${e.line}: ${e.error}`).join('\n'));
      }
      fetchMailboxes();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleBatchLogin = async () => {
    const accounts = googleBatchText
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('|');
        if (separator < 0) return null;
        return {
          email: line.slice(0, separator).trim(),
          password: line.slice(separator + 1).trim(),
        };
      })
      .filter((account) => account?.email && account.password);
    if (accounts.length === 0) {
      setError('请输入有效账号，每行格式为 Google 邮箱|Google 密码');
      return;
    }
    if (!window.electronAPI?.wizstarBatchLogin) {
      setError('批量 Google 登录需要在 Electron 桌面客户端中进行；更新后请重启客户端');
      return;
    }

    setGoogleBatchStep('running');
    setGoogleBatchResults(Object.fromEntries(accounts.map((account, index) => [index, {
      email: account.email,
      step: 'queued',
    }])));
    setGoogleBatchSummary(null);
    setError('');
    setSuccessMsg('');
    try {
      const result = await window.electronAPI.wizstarBatchLogin({
        accounts,
        concurrency: googleBatchConcurrency,
      });
      if (!result?.ok) throw new Error(result?.error || '批量 Google 登录失败');
      setGoogleBatchSummary({ total: accounts.length, succeeded: result.succeeded, failed: result.failed });
      setGoogleBatchStep('done');
      setSuccessMsg(`Google 登录完成：成功 ${result.succeeded} 个，失败 ${result.failed} 个`);
      const failures = (result.results || []).filter((item) => !item.ok);
      if (failures.length > 0) {
        setError(failures.map((item) => `${item.email}: ${item.error}`).join('\n'));
      }
      await fetchMailboxes();
      if (result.succeeded > 0) onLoginComplete?.();
    } catch (error) {
      setGoogleBatchStep('idle');
      setError(error.message || '批量 Google 登录失败');
    }
  };

  const loginMailboxes = async (mailboxIds, { closeForm = false } = {}) => {
    const ids = mailboxIds.map((id) => String(id)).filter(Boolean);
    if (ids.length === 0) {
      setError('请至少选择一个邮箱');
      return;
    }
    if (!window.electronAPI?.wizstarGoogleLogin) {
      setError('谷歌授权需要在 Electron 桌面客户端中进行');
      return;
    }
    setLoggingIn(true);
    setError('');
    setSuccessMsg('');
    setLoginProgress({ total: ids.length, done: 0, message: '正在启动 Chrome...' });
    const success = [];
    const failed = [];
    try {
      for (const mailboxId of ids) {
        setActiveLoginMailboxId(String(mailboxId));
        const result = await window.electronAPI.wizstarGoogleLogin(parseInt(mailboxId, 10));
        if (result?.ok) {
          success.push(mailboxId);
        } else if (result?.canceled) {
          failed.push({ mailbox_id: mailboxId, error: result.error || '已取消' });
        } else {
          failed.push({ mailbox_id: mailboxId, error: result?.error || '登录失败' });
        }
        setLoginProgress((current) => ({
          total: ids.length,
          done: success.length + failed.length,
          message: current?.message || '',
        }));
        if (result?.canceled) break;
      }
      setSuccessMsg(`Google 登录完成：成功 ${success.length} 个，失败 ${failed.length} 个`);
      if (failed.length > 0) {
        setError(failed.map((item) => `${item.mailbox_id}: ${item.error}`).join('\n'));
      }
      if (closeForm) {
        setShowLoginForm(false);
        setSelectedMailboxIds([]);
      }
      await fetchMailboxes();
    } catch (error) {
      setError(error.message || 'Google 登录失败');
    } finally {
      setLoggingIn(false);
      setActiveLoginMailboxId(null);
      setLoginProgress(null);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    await loginMailboxes(selectedMailboxIds, { closeForm: true });
  };

  const handleRelogin = async (mailboxId) => {
    await loginMailboxes([mailboxId]);
  };

  const availableMailboxes = mailboxes.filter(
    (mb) => mb.provider === 'google' && mb.has_password
  );
  const isElectronLoginAvailable = Boolean(window.electronAPI?.wizstarGoogleLogin);

  const openLoginPanel = () => {
    setError('');
    setSuccessMsg('');
    setShowLoginForm(true);
    if (availableMailboxes.length === 1) {
      setSelectedMailboxIds([String(availableMailboxes[0].id)]);
    }
  };

  const toggleMailboxSelection = (id) => {
    setSelectedMailboxIds(prev =>
      prev.includes(String(id))
        ? prev.filter(x => x !== String(id))
        : [...prev, String(id)]
    );
  };

  const selectAllMailboxes = () => {
    if (selectedMailboxIds.length === availableMailboxes.length) {
      setSelectedMailboxIds([]);
    } else {
      setSelectedMailboxIds(availableMailboxes.map(mb => String(mb.id)));
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('确定删除该邮箱？')) return;
    try {
      await fetch(`${API_BASE}/mailboxes/${id}`, { method: 'DELETE' });
      fetchMailboxes();
    } catch (e) {
      setError('删除失败');
    }
  };

  const handleClearChannelFailure = async (mailboxId, channel) => {
    if (!confirm(`确定解除该邮箱在${CHANNEL_LABELS[channel] || channel}的失败冷却？`)) return;
    try {
      const res = await fetch(`${API_BASE}/mailboxes/${mailboxId}/usage/${encodeURIComponent(channel)}`, {
        method: 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.detail || '解除失败冷却失败');
      setError('');
      fetchMailboxes();
    } catch (e) {
      setError(e.message || '解除失败冷却失败');
    }
  };

  const handleTest = async (id) => {
    setTestingId(id);
    try {
      const res = await fetch(`${API_BASE}/mailboxes/${id}/test`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'available') {
        setError('');
      } else {
        setError(`邮箱测试失败: ${data.message}`);
      }
      fetchMailboxes();
    } catch (e) {
      setError('测试请求失败');
    } finally {
      setTestingId(null);
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'available':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-500/10 text-green-400">
            <CheckCircle2 className="w-3 h-3" /> 可用
          </span>
        );
      case 'logged_in':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-400">
            <CheckCircle2 className="w-3 h-3" /> 已登录
          </span>
        );
      case 'login_expired':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-500/10 text-amber-400">
            <AlertCircle className="w-3 h-3" /> 登录已失效
          </span>
        );
      case 'forbidden':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-500/10 text-red-400">
            <XCircle className="w-3 h-3" /> 账号受限
          </span>
        );
      case 'registered':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-400">
            <CheckCircle2 className="w-3 h-3" /> 已绑定账号
          </span>
        );
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-500/10 text-red-400">
            <XCircle className="w-3 h-3" /> 异常
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-dark-muted/20 text-dark-muted">
            <AlertCircle className="w-3 h-3" /> 未测试
          </span>
        );
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/20">
      {/* Header */}
      <div className="h-14 border-b border-dark-border px-6 flex items-center justify-between shrink-0 bg-dark-bg/40">
        <div className="flex items-center space-x-2">
          <Mail className="w-4 h-4 text-brand" />
          <h1 className="text-sm font-semibold text-white">邮箱凭证库</h1>
          <span className="text-xs text-dark-muted">成功后仅屏蔽对应渠道；占用时全局锁定；失败后冷却再重试</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchMailboxes}
            className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={openLoginPanel}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 text-sm font-medium hover:bg-green-500/20 transition-colors"
          >
            <Zap className="w-4 h-4" /> 渠道一登录
          </button>
          <button
            onClick={() => setShowBatchForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 text-sm font-medium hover:bg-purple-500/20 transition-colors"
          >
            <Upload className="w-4 h-4" /> 批量导入
          </button>
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand/10 text-brand text-sm font-medium hover:bg-brand/20 transition-colors"
          >
            <Plus className="w-4 h-4" /> 添加邮箱
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="rounded-xl border border-blue-500/25 bg-dark-card p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Zap className="w-4 h-4 text-blue-300" />
                Google 批量登录
              </div>
              <p className="mt-1 text-xs text-dark-muted">
                与渠道六相同：每行粘贴一个账号，格式为 <code className="text-blue-300">Google 邮箱|Google 密码</code>。系统会为每个账号使用独立 Chrome 配置。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowBatchForm((value) => !value)}
              disabled={googleBatchStep === 'running'}
              className="shrink-0 text-xs text-purple-300 hover:text-purple-200 disabled:opacity-40"
            >
              {showBatchForm ? '收起凭证导入' : '导入邮箱凭证'}
            </button>
          </div>

          {googleBatchStep !== 'running' && (
            <>
              <textarea
                value={googleBatchText}
                onChange={(event) => setGoogleBatchText(event.target.value)}
                placeholder={"account1@gmail.com|password1\naccount2@gmail.com|password2"}
                rows={7}
                className="w-full resize-none rounded-lg border border-dark-border bg-dark-bg p-3 font-mono text-sm text-white placeholder:text-dark-muted/50 focus:border-blue-500 focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs text-dark-muted">并发数</label>
                <input
                  type="number"
                  min="1"
                  max="3"
                  value={googleBatchConcurrency}
                  onChange={(event) => setGoogleBatchConcurrency(Math.max(1, Math.min(3, Number.parseInt(event.target.value, 10) || 1)))}
                  className="w-16 rounded-lg border border-dark-border bg-dark-bg p-2 text-center text-sm text-white focus:border-blue-500 focus:outline-none"
                />
                <span className="text-xs text-dark-muted">同时打开的 Chrome 数量，建议 1–3</span>
                <button
                  type="button"
                  onClick={handleGoogleBatchLogin}
                  disabled={!googleBatchText.trim() || !isElectronLoginAvailable}
                  className="ml-auto flex items-center gap-1.5 rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Zap className="w-4 h-4" />
                  开始登录（{googleBatchText.split('\n').filter((line) => line.includes('|') && line.trim()).length}）
                </button>
              </div>
            </>
          )}

          {(googleBatchStep === 'running' || googleBatchStep === 'done') && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-white">
                  {googleBatchStep === 'running' ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> : <CheckCircle2 className="w-4 h-4 text-green-400" />}
                  {googleBatchStep === 'running' ? '批量登录进行中...' : `登录完成：成功 ${googleBatchSummary?.succeeded || 0}，失败 ${googleBatchSummary?.failed || 0}`}
                </span>
                {googleBatchStep === 'done' && (
                  <button
                    type="button"
                    onClick={() => {
                      setGoogleBatchStep('idle');
                      setGoogleBatchResults({});
                      setGoogleBatchSummary(null);
                    }}
                    className="text-xs text-blue-300 hover:text-blue-200"
                  >
                    继续登录
                  </button>
                )}
              </div>
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {Object.entries(googleBatchResults)
                  .sort(([left], [right]) => Number(left) - Number(right))
                  .map(([index, info]) => (
                    <div key={index} className="flex items-center justify-between gap-3 rounded-lg border border-dark-border/60 bg-dark-bg/60 px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {info.ok === true ? (
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-green-400" />
                        ) : info.ok === false ? (
                          <XCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />
                        ) : info.step === 'queued' ? (
                          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-dark-muted" />
                        ) : (
                          <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-blue-400" />
                        )}
                        <span className="truncate text-xs text-white">{info.email}</span>
                      </div>
                      <span className={`shrink-0 text-[11px] ${info.ok === false ? 'text-red-400' : 'text-dark-muted'}`} title={info.error || ''}>
                        {info.step === 'queued' ? '等待中' :
                          info.step === 'starting' ? '启动中' :
                          info.step === 'mailbox_saved' ? '凭证已保存' :
                          info.step === 'launching_chrome' ? '启动 Chrome' :
                          info.step === 'opening_wizstar' ? '打开 Wizstar' :
                          info.step === 'inputting_email' ? '输入邮箱' :
                          info.step === 'inputting_password' ? '输入密码' :
                          info.step === 'google_continue_clicked' ? 'Google 授权中' :
                          info.step === 'extracting_state' ? '提取登录态' :
                          info.step === 'saved_to_db' ? '已保存' :
                          info.step === 'failed' ? (info.error || '登录失败') :
                          info.step || '处理中'}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-blue-500/20 bg-gradient-to-r from-blue-500/10 via-dark-card to-dark-card p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Zap className="w-4 h-4 text-blue-300" />
                Google 登录入口
              </div>
              <p className="mt-1 text-xs text-dark-muted">
                第 1 步导入邮箱与 Google 密码，第 2 步选择邮箱启动 Chrome，第 3 步授权成功后账号自动进入渠道一账号库。
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded-full border border-dark-border bg-dark-bg/60 px-2.5 py-1 text-dark-muted">
                  1. 添加或批量导入邮箱
                </span>
                <span className="text-dark-subtle">→</span>
                <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-blue-300">
                  2. 点击开始 Google 登录
                </span>
                <span className="text-dark-subtle">→</span>
                <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-green-300">
                  3. 自动保存 Wizstar 登录态
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {mailboxes.length === 0 && (
                <button
                  onClick={() => setShowBatchForm(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-purple-500/20 bg-purple-500/10 px-3 py-2 text-sm font-medium text-purple-300 hover:bg-purple-500/20 transition-colors"
                >
                  <Upload className="w-4 h-4" />
                  先导入邮箱
                </button>
              )}
              <button
                onClick={openLoginPanel}
                disabled={!isElectronLoginAvailable || availableMailboxes.length === 0 || loggingIn}
                className="flex items-center gap-1.5 rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                title={!isElectronLoginAvailable ? '请在 Electron 桌面客户端中使用' : availableMailboxes.length === 0 ? '请先导入包含账号密码的邮箱' : '启动渠道一 Google 登录'}
              >
                {loggingIn ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                开始 Google 登录
              </button>
            </div>
          </div>
          {!isElectronLoginAvailable && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <AlertCircle className="w-4 h-4 shrink-0" />
              当前是普通浏览器环境。Google 自动登录只在 Electron 桌面客户端中可用。
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
            <button onClick={() => setError('')} className="ml-auto text-red-400/60 hover:text-red-400">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Success Message */}
        {successMsg && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {successMsg}
            <button onClick={() => setSuccessMsg('')} className="ml-auto text-green-400/60 hover:text-green-400">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Batch Import Form */}
        {showBatchForm && (
          <div className="p-4 rounded-xl bg-dark-card border border-purple-500/20 space-y-3">
            <h3 className="text-sm font-medium text-white">邮箱凭证批量导入</h3>
            <p className="text-xs text-dark-muted">
              OAuth 取件邮箱使用 <code className="text-purple-400">邮箱----client_id----refresh_token</code>；
              完整凭证使用 <code className="text-purple-400">邮箱----密码----client_id----refresh_token</code>（也会自动识别 refresh_token 与 client_id 对调）；
              <code className="text-purple-400">邮箱|密码</code> 默认识别为 Google 登录账号。
            </p>
            <form onSubmit={handleBatchImport} className="space-y-3">
              <textarea
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                placeholder={"oauth@outlook.com----9e5f94bc-xxxx-xxxx-xxxx-xxxxxxxxxxxx----M.C537_BAY.0.U.-xxxxx\nfull@outlook.com----password123----9e5f94bc-xxxx-xxxx-xxxx-xxxxxxxxxxxx----M.C508_BAY.0.U.-xxxxx\npassword-only@gmail.com|password123"}
                rows={6}
                className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-purple-500/50 resize-none font-mono text-xs"
              />
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={submitting || !batchText.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-purple-500 text-white text-sm font-medium hover:bg-purple-500/90 disabled:opacity-50 transition-colors"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  导入
                </button>
                <button
                  type="button"
                  onClick={() => setShowBatchForm(false)}
                  className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                >
                  取消
                </button>
                <span className="text-xs text-dark-muted ml-2">
                  {batchText.trim() ? `${batchText.trim().split('\n').filter(l => l.trim()).length} 行` : ''}
                </span>
              </div>
            </form>
          </div>
        )}

        {/* Register Form */}
        {showLoginForm && (
          <div className="p-4 rounded-xl bg-dark-card border border-green-500/20 space-y-3">
            <h3 className="text-sm font-medium text-white">Google 账号登录</h3>
            <p className="text-xs text-dark-muted">
              选择一个或多个已导入邮箱。系统会按顺序打开独立 Chrome 登录 Google，并在 Wizstar 授权完成后自动保存登录态。
            </p>
            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-dark-muted">选择邮箱（可多选）</label>
                  <button
                    type="button"
                    onClick={selectAllMailboxes}
                    className="text-xs text-brand hover:text-brand/80"
                  >
                    {selectedMailboxIds.length === availableMailboxes.length ? '取消全选' : '全选'}
                  </button>
                </div>
                {availableMailboxes.length === 0 ? (
                  <p className="text-xs text-yellow-400 py-2">没有可用邮箱，请先添加邮箱或处理异常邮箱</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto rounded-lg bg-dark-bg border border-dark-border p-2 space-y-1">
                    {availableMailboxes.map((mb) => (
                      <label
                        key={mb.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-dark-card/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedMailboxIds.includes(String(mb.id))}
                          onChange={() => toggleMailboxSelection(mb.id)}
                          className="rounded border-dark-border text-brand focus:ring-brand/50"
                        />
                        <span className="text-sm text-white truncate">{mb.email}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-xs text-dark-muted mt-1">
                  已选择 {selectedMailboxIds.length} 个邮箱
                </p>
              </div>

              <div className="p-3 rounded-lg bg-dark-bg border border-dark-border text-xs text-dark-muted">
                登录窗口使用独立浏览器配置，不会读取你日常 Chrome 的个人资料。若 Google 要求验证码或二次验证，请直接在弹出的 Chrome 窗口中完成。
              </div>

              {loginProgress && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-brand/5 border border-brand/20">
                  <Loader2 className="w-4 h-4 text-brand animate-spin" />
                  <span className="text-xs text-brand">
                    {loginProgress.message || `正在等待 Google 授权 ${selectedMailboxIds.length} 个账号（按顺序处理）...`}
                    {loginProgress.total > 0 && (
                      <span className="ml-2 text-brand/70">
                        {loginProgress.done}/{loginProgress.total}
                      </span>
                    )}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={loggingIn || selectedMailboxIds.length === 0}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-600/90 disabled:opacity-50 transition-colors"
                >
                  {loggingIn ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> 登录中...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4" /> 开始 Google 登录 ({selectedMailboxIds.length})
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowLoginForm(false)}
                  disabled={loggingIn}
                  className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Add Form */}
        {showAddForm && (
          <div className="p-4 rounded-xl bg-dark-card border border-dark-border space-y-3">
            <h3 className="text-sm font-medium text-white">添加邮箱凭证</h3>
            <form onSubmit={handleAdd} className="space-y-3">
              <div>
                <label className="block text-xs text-dark-muted mb-1">账号类型</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['microsoft', 'Microsoft 邮箱'],
                    ['google', 'Google 账号'],
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      onClick={() => setFormData({
                        ...formData,
                        provider: value,
                        client_id: value === 'google' ? '' : formData.client_id,
                        refresh_token: value === 'google' ? '' : formData.refresh_token,
                      })}
                      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                        formData.provider === value
                          ? 'border-brand/50 bg-brand/10 text-brand'
                          : 'border-dark-border bg-dark-bg text-dark-muted hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-dark-muted mb-1">邮箱地址</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="example@outlook.com"
                  className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50"
                />
              </div>
              <div>
                <label className="block text-xs text-dark-muted mb-1">
                  {formData.provider === 'google'
                    ? 'Google 密码（渠道一、六、七、九登录使用）'
                    : 'Microsoft 账号密码（仅需要密码登录的渠道使用）'}
                </label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder={formData.provider === 'google'
                    ? '渠道一、六、七、九登录时使用'
                    : '仅收验证码时可不填'}
                  className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50"
                />
              </div>
              {formData.provider === 'microsoft' && (
                <>
                  <div>
                    <label className="block text-xs text-dark-muted mb-1">Microsoft OAuth2 Client ID（渠道三、四、八取件需要）</label>
                    <input
                      type="text"
                      value={formData.client_id}
                      onChange={(e) => setFormData({ ...formData, client_id: e.target.value })}
                      placeholder="Azure AD 应用的 Client ID"
                      className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-dark-muted mb-1">Microsoft OAuth2 Refresh Token（渠道三、四、八取件需要）</label>
                    <textarea
                      value={formData.refresh_token}
                      onChange={(e) => setFormData({ ...formData, refresh_token: e.target.value })}
                      placeholder="Microsoft OAuth2 Refresh Token"
                      rows={3}
                      className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50 resize-none"
                    />
                  </div>
                </>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  确认添加
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="px-4 py-2 rounded-lg text-dark-muted text-sm hover:text-white hover:bg-dark-card/80 transition-colors"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Mailbox List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-brand animate-spin" />
          </div>
        ) : mailboxes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-dark-muted">
            <Mail className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">暂无邮箱，点击上方"添加邮箱"开始</p>
          </div>
        ) : (
          <div className="space-y-2">
            {mailboxes.map((mb) => (
              <div
                key={mb.id}
                className="flex items-center justify-between p-4 rounded-xl bg-dark-card border border-dark-border hover:border-dark-border/80 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
                    <Mail className="w-4 h-4 text-brand" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate">{mb.email}</div>
                    {mb.client_id && (
                      <div className="text-xs text-dark-muted truncate">
                        Client ID: {mb.client_id.slice(0, 8)}...
                      </div>
                    )}
                    <div className={`mt-0.5 text-[11px] ${
                      mb.provider === 'microsoft'
                        ? 'text-sky-300'
                        : mb.provider === 'google'
                          ? 'text-green-300'
                          : 'text-dark-muted'
                    }`}>
                      {mb.provider === 'microsoft'
                        ? 'Microsoft 邮箱 · 用于接收验证码/验证链接'
                        : mb.provider === 'google'
                          ? 'Google 账号 · 用于 Google OAuth 登录'
                          : '未识别邮箱类型'}
                    </div>
                    {Array.isArray(mb.channel_usage) && mb.channel_usage.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {mb.channel_usage.map((usage) => (
                          <button
                            type="button"
                            key={`${mb.id}-${usage.channel}`}
                            disabled={usage.status !== 'failed'}
                            onClick={() => handleClearChannelFailure(mb.id, usage.channel)}
                            className={`rounded px-1.5 py-0.5 text-[10px] ${
                              usage.status === 'registered'
                                ? 'bg-green-500/10 text-green-400'
                                : usage.status === 'reserved'
                                  ? 'bg-blue-500/10 text-blue-300'
                                  : usage.status === 'failed'
                                    ? 'bg-red-500/10 text-red-300 hover:bg-red-500/20'
                                    : 'bg-dark-muted/10 text-dark-muted'
                            }`}
                            title={usage.status === 'failed'
                              ? `${usage.last_error || '注册失败'}；点击可手动解除冷却`
                              : usage.status}
                          >
                            {CHANNEL_LABELS[usage.channel] || usage.channel}
                            {usageStatusText(usage)}
                          </button>
                        ))}
                      </div>
                    )}
                    {!mb.has_password && mb.has_refresh_token && (
                      <div className="text-[11px] text-amber-400 mt-0.5">
                        OAuth 取件凭证：可供渠道三、四、八使用
                      </div>
                    )}
                    {!mb.has_password && !mb.has_refresh_token && (
                      <div className="text-[11px] text-red-400 mt-0.5">
                        缺少可用登录或取件凭证
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {getStatusBadge(mb.status)}
                  <button
                    onClick={() => handleRelogin(mb.id)}
                    disabled={loggingIn || mb.provider !== 'google' || !mb.has_password}
                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-green-400 hover:bg-green-500/10 disabled:opacity-40 transition-colors"
                    title={mb.provider === 'google' ? '使用该 Google 账号登录渠道一' : 'Microsoft 邮箱不能用于 Google 登录'}
                  >
                    {activeLoginMailboxId === String(mb.id) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                    {mb.status === 'logged_in' ? '重新登录' : '登录'}
                  </button>
                  <button
                    onClick={() => handleTest(mb.id)}
                    disabled={testingId === mb.id || !mb.has_oauth}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-50 transition-colors"
                    title={mb.has_oauth ? '测试 Microsoft OAuth 取件凭证' : '该邮箱未配置 OAuth 取件凭证'}
                  >
                    {testingId === mb.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => handleDelete(mb.id)}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
