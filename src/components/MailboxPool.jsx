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

export default function MailboxPool() {
  const [mailboxes, setMailboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBatchForm, setShowBatchForm] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [formData, setFormData] = useState({ email: '', client_id: '', refresh_token: '' });
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [selectedMailboxIds, setSelectedMailboxIds] = useState([]);
  const [registerPassword, setRegisterPassword] = useState('Wz@2024secure');
  const [concurrency, setConcurrency] = useState(2);
  const [registering, setRegistering] = useState(false);
  const [registerProgress, setRegisterProgress] = useState(null);

  const fetchMailboxes = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/mailboxes`);
      const data = await res.json();
      setMailboxes(data.data || []);
      setError('');
    } catch (e) {
      setError('无法连接到渠道一服务，请确认 Python 服务已启动');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMailboxes();
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!formData.email || !formData.client_id || !formData.refresh_token) return;
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
      setFormData({ email: '', client_id: '', refresh_token: '' });
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
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '导入失败');
      }
      const result = await res.json();
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

  const handleRegister = async (e) => {
    e.preventDefault();
    if (selectedMailboxIds.length === 0) {
      setError('请至少选择一个邮箱');
      return;
    }
    setRegistering(true);
    setError('');
    setSuccessMsg('');
    setRegisterProgress({ total: selectedMailboxIds.length, done: 0 });
    try {
      const res = await fetch(`${API_BASE}/accounts/batch-register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailbox_ids: selectedMailboxIds.map(id => parseInt(id)),
          password: registerPassword,
          concurrency: concurrency,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || '注册失败');
      }
      const result = await res.json();
      const { success, failed } = result.data;
      setRegisterProgress(null);
      setSuccessMsg(`注册完成：成功 ${success.length} 个，失败 ${failed.length} 个`);
      if (failed.length > 0) {
        setError(failed.map(f => `${f.mailbox_id}: ${f.error}`).join('\n'));
      }
      setShowRegisterForm(false);
      setSelectedMailboxIds([]);
      fetchMailboxes();
    } catch (e) {
      setError(e.message);
      setRegisterProgress(null);
    } finally {
      setRegistering(false);
    }
  };

  const availableMailboxes = mailboxes.filter(
    (mb) => mb.status !== 'registered' && mb.status !== 'error'
  );

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
      case 'registered':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-500/10 text-blue-400">
            <CheckCircle2 className="w-3 h-3" /> 已注册
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
          <h1 className="text-sm font-semibold text-white">邮箱库</h1>
          <span className="text-xs text-dark-muted">管理用于注册渠道一的微软邮箱</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchMailboxes}
            className="p-2 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card/50 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowRegisterForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 text-sm font-medium hover:bg-green-500/20 transition-colors"
          >
            <Zap className="w-4 h-4" /> 批量注册
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
            <h3 className="text-sm font-medium text-white">批量导入邮箱</h3>
            <p className="text-xs text-dark-muted">
              每行一个邮箱，格式：<code className="text-purple-400">邮箱----密码----client_id----refresh_token</code>
            </p>
            <form onSubmit={handleBatchImport} className="space-y-3">
              <textarea
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                placeholder={"example@outlook.com----password123----9e5f94bc-xxxx----M.C537_BAY.0.U.-xxxxx\nanother@outlook.com----pass456----9e5f94bc-xxxx----M.C508_BAY.0.U.-xxxxx"}
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
        {showRegisterForm && (
          <div className="p-4 rounded-xl bg-dark-card border border-green-500/20 space-y-3">
            <h3 className="text-sm font-medium text-white">批量注册渠道一账号</h3>
            <p className="text-xs text-dark-muted">
              选择未注册的邮箱，设置并发数量，系统将自动批量完成注册
            </p>
            <form onSubmit={handleRegister} className="space-y-3">
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
                  <p className="text-xs text-yellow-400 py-2">没有可用邮箱，所有邮箱已注册或异常</p>
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

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-dark-muted mb-1">并发数量</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={concurrency}
                      onChange={(e) => setConcurrency(parseInt(e.target.value))}
                      className="flex-1 accent-brand"
                    />
                    <span className="text-sm text-white font-medium w-6 text-center">{concurrency}</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-dark-muted mb-1">账号密码</label>
                  <input
                    type="text"
                    value={registerPassword}
                    onChange={(e) => setRegisterPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white focus:outline-none focus:border-brand/50"
                  />
                </div>
              </div>

              {registerProgress && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-brand/5 border border-brand/20">
                  <Loader2 className="w-4 h-4 text-brand animate-spin" />
                  <span className="text-xs text-brand">
                    正在注册 {selectedMailboxIds.length} 个账号（并发 {concurrency}）...
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={registering || selectedMailboxIds.length === 0}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-600/90 disabled:opacity-50 transition-colors"
                >
                  {registering ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> 注册中...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4" /> 开始注册 ({selectedMailboxIds.length})
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRegisterForm(false)}
                  disabled={registering}
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
            <h3 className="text-sm font-medium text-white">添加微软邮箱</h3>
            <form onSubmit={handleAdd} className="space-y-3">
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
                <label className="block text-xs text-dark-muted mb-1">OAuth2 Client ID</label>
                <input
                  type="text"
                  value={formData.client_id}
                  onChange={(e) => setFormData({ ...formData, client_id: e.target.value })}
                  placeholder="Azure AD 应用的 Client ID"
                  className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50"
                />
              </div>
              <div>
                <label className="block text-xs text-dark-muted mb-1">OAuth2 Refresh Token</label>
                <textarea
                  value={formData.refresh_token}
                  onChange={(e) => setFormData({ ...formData, refresh_token: e.target.value })}
                  placeholder="Microsoft OAuth2 Refresh Token"
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg bg-dark-bg border border-dark-border text-sm text-white placeholder:text-dark-muted/50 focus:outline-none focus:border-brand/50 resize-none"
                />
              </div>
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
                    <div className="text-xs text-dark-muted truncate">
                      Client ID: {mb.client_id?.slice(0, 8)}...
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {getStatusBadge(mb.status)}
                  <button
                    onClick={() => handleTest(mb.id)}
                    disabled={testingId === mb.id}
                    className="p-1.5 rounded-lg text-dark-muted hover:text-brand hover:bg-brand/10 disabled:opacity-50 transition-colors"
                    title="测试连通性"
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
