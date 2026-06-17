import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  SlidersHorizontal, 
  Lock, 
  Unlock, 
  Play, 
  Pause, 
  Plus, 
  Video, 
  Image as ImageIcon, 
  Sparkles, 
  ChevronUp, 
  ChevronDown, 
  RefreshCw,
  Send,
  Trash2,
  FolderPlus,
  Tv,
  Gamepad2,
  Mountain,
  Castle,
  Monitor,
  Settings,
  Layers,
  FolderOpen,
  CheckCircle2,
  Check,
  Activity,
  FileImage,
  FileVideo,
  Maximize2,
  Download,
  Copy,
  X,
  Combine
} from 'lucide-react';
import { WIZSTAR_API } from '../config';
import ImageMergeModal from './ImageMergeModal';
import { mergeImages, blobToUint8Array, timestampForFilename } from '../utils/imageMerge';

const TASK_REGISTRY_KEY = 'maocanju_generation_task_registry';
let globalPollingStarted = false;
let globalPollingBusy = false;
let globalPollingCursor = 0;

const readGenerationTaskRegistry = () => {
  try {
    const raw = localStorage.getItem(TASK_REGISTRY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeGenerationTaskRegistry = (items) => {
  try {
    localStorage.setItem(TASK_REGISTRY_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn('Failed to save generation task registry:', e);
  }
};

const DEFAULT_PROMPT_SUFFIX_TEMPLATES = [
  { id: 'none', name: '无后缀', suffix: '' },
];
const PROMPT_SUFFIX_TEMPLATES_KEY = 'maocanju_prompt_suffix_templates';

const statusUrlForTask = (task) => task.channel === 'pixmax'
  ? `${WIZSTAR_API}/pixmax/tasks/${task.taskId}/status`
  : task.channel === 'oiioii'
    ? `${WIZSTAR_API}/oiioii/tasks/${task.taskId}/status`
    : task.channel === 'chatgpt2api'
      ? `${WIZSTAR_API}/chatgpt2api/tasks/${task.taskId}/status`
      : task.channel === 'dola'
        ? `${WIZSTAR_API}/dola/tasks/${task.taskId}/status`
        : `${WIZSTAR_API}/tasks/${task.taskId}/status`;

const isLocalFilePathValue = (url = '') => /^\/(?!\/)/.test(String(url || '')) || /^[a-zA-Z]:[\\/]/.test(String(url || '')) || /^\\\\/.test(String(url || ''));
const LOCAL_VIDEO_CACHE_BUSTER = String(Date.now());

const localFilePathFromUrlValue = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) {
    try { return decodeURIComponent(new URL(raw).pathname); } catch (_) { return raw.replace(/^file:\/\/+/, '/'); }
  }
  return isLocalFilePathValue(raw) ? raw : '';
};
const isLocalVideoServiceUrlValue = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (raw.startsWith('/local/video')) return true;
  try {
    const parsed = new URL(raw, WIZSTAR_API);
    const api = new URL(WIZSTAR_API);
    return parsed.pathname === '/local/video' && parsed.hostname === api.hostname && parsed.port === api.port;
  } catch (_) {
    return false;
  }
};
const isPlayableVideoUrlValue = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (isLocalVideoServiceUrlValue(raw)) return true;
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(raw)) return true;
  if (/mime_type=video_|video_mp4|download_url|play_url|main_url/i.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    return /(^|\.)dola\.com$/i.test(parsed.hostname) && /\/video\//i.test(parsed.pathname + parsed.search);
  } catch (_) {
    return false;
  }
};
const withLocalVideoCacheBuster = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw || /[?&]v=/.test(raw)) return raw;
  return `${raw}${raw.includes('?') ? '&' : '?'}v=${LOCAL_VIDEO_CACHE_BUSTER}`;
};
const toLocalVideoUrlValue = (filePath = '') => withLocalVideoCacheBuster(`${WIZSTAR_API}/local/video?path=${encodeURIComponent(filePath)}`);
const toPlayableVideoUrlValue = (url = '') => {
  if (!url) return url;
  if (isLocalVideoServiceUrlValue(url)) return withLocalVideoCacheBuster(url);
  const localPath = localFilePathFromUrlValue(url);
  if (localPath && isPlayableVideoUrlValue(localPath)) return toLocalVideoUrlValue(localPath);
  if (/^https?:\/\//i.test(url) && isPlayableVideoUrlValue(url)) {
    return `${WIZSTAR_API}/proxy/video?url=${encodeURIComponent(url)}`;
  }
  return url;
};
const mediaUrlFromPayload = (payload = {}, task = {}) => {
  const localPath = payload.local_path || task.localPath || '';
  if (payload.media_type === 'video' && localPath) return localPath;
  return payload.image_url || payload.video_url || payload.cdn_url || payload.download_url || task.mediaUrl || task.imageUrl || task.videoUrl || '';
};

const startGlobalGenerationPolling = () => {
  if (globalPollingStarted) return;
  globalPollingStarted = true;
  window.setInterval(async () => {
    if (globalPollingBusy) return;
    const registry = readGenerationTaskRegistry().filter(t => t && t.taskId && t.status !== 'completed' && t.status !== 'failed');
    if (registry.length === 0) return;

    globalPollingBusy = true;
    try {
      const batchSize = 5;
      const start = globalPollingCursor % registry.length;
      const batch = [...registry.slice(start, start + batchSize), ...registry.slice(0, Math.max(0, start + batchSize - registry.length))].slice(0, batchSize);
      globalPollingCursor = (start + batchSize) % registry.length;
      const updatedById = new Map();

      await Promise.all(batch.map(async (task) => {
        try {
          const res = await fetch(statusUrlForTask(task));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const payload = data.data || {};
          const status = payload.status || 'processing';
          const localPath = payload.local_path || task.localPath || '';
          const nextMediaUrl = mediaUrlFromPayload(payload, task);
          updatedById.set(task.taskId, {
            ...task,
            status,
            progress: payload.progress,
            queuePosition: payload.queue_position,
            mediaUrl: nextMediaUrl,
            videoUrl: payload.video_url || task.videoUrl || '',
            imageUrl: payload.image_url || task.imageUrl || '',
            mediaType: payload.media_type || task.mediaType || (payload.image_url ? 'image' : undefined),
            localPath,
            cdnUrl: payload.cdn_url || task.cdnUrl || '',
            downloadUrl: payload.download_url || task.downloadUrl || '',
            outputUri: payload.output_uri || task.outputUri || '',
            fileSize: payload.file_size ?? task.fileSize,
            accountId: payload.account_id || task.accountId || 0,
            accountName: payload.account_name || task.accountName || '',
            conversationId: payload.conversation_id || task.conversationId || '',
            error: payload.fail_reason || payload.error || payload.message || task.error || '',
            updatedAt: Date.now(),
          });
        } catch (e) {
          updatedById.set(task.taskId, {
            ...task,
            error: e.message || String(e),
            retryCount: (task.retryCount || 0) + 1,
            updatedAt: Date.now(),
          });
        }
      }));

      const latest = readGenerationTaskRegistry();
      const merged = latest.map(task => updatedById.get(task.taskId) || task);
      writeGenerationTaskRegistry(merged);
    } finally {
      globalPollingBusy = false;
    }
  }, 5000);
};

export default function ContentCreation({ activeDraft, onBack, onProjectChanged }) {
  const GLOBAL_GENERATION_SETTINGS_KEY = 'maocanju_global_generation_settings';
  const DEFAULT_GLOBAL_GENERATION_SETTINGS = {
    model: 'Seedance 2.0',
    aspectRatio: '16:9',
    duration: '5秒',
    resolution: '2K',
    generateChannel: 'wizstar',
  };
  const readGlobalGenerationSetting = (key) => {
    try {
      const rawSettings = localStorage.getItem(GLOBAL_GENERATION_SETTINGS_KEY);
      const settings = rawSettings ? JSON.parse(rawSettings) : {};
      const value = settings[key] || (key === 'generateChannel' ? localStorage.getItem('maocanju_generate_channel') : null);
      return value === 'quickframe' ? 'wizstar' : (value || DEFAULT_GLOBAL_GENERATION_SETTINGS[key]);
    } catch {
      return DEFAULT_GLOBAL_GENERATION_SETTINGS[key];
    }
  };

  const [showBatchModal, setShowBatchModal] = useState(false);
  const [globalModel, setGlobalModel] = useState(() => readGlobalGenerationSetting('model'));
  const [globalAspectRatio, setGlobalAspectRatio] = useState(() => readGlobalGenerationSetting('aspectRatio'));
  const [globalDuration, setGlobalDuration] = useState(() => readGlobalGenerationSetting('duration'));
  const [globalResolution, setGlobalResolution] = useState(() => readGlobalGenerationSetting('resolution'));
  // 生成通道：'wizstar'（账号池/渠道一）| 'pixmax'（渠道二）| 'oiioii'（渠道四）| 'chatgpt2api'（渠道五生图）| 'dola'（渠道六）
  const [generateChannel, setGenerateChannel] = useState(() => readGlobalGenerationSetting('generateChannel'));
  const [batchStarting, setBatchStarting] = useState(false);
  const IMAGE_MODEL_NAMES = new Set([
    '渠道五 GPT-Image2',
    '渠道四 GPT-Image2',
    '渠道四 Nano Pro',
    '渠道四 Nano 2',
    '渠道四 Seedream 5.0',
    '渠道四 Seedream 4.5',
    '渠道四 Midjourney niji7',
    '渠道四 Midjourney niji6',
    '渠道四 NovelAI',
    '渠道四 GPT-4o',
  ]);
  const VIDEO_MODEL_NAMES = new Set([
    'Seedance 2.0',
    'Seedance 1.5',
    'Kling',
    '渠道二 标准',
    '渠道二 高质量',
    '渠道四 Gemini',
    '渠道四 Grok',
    '渠道六 Seedance 2.0',
    '渠道六 Seedance 1.5',
    '渠道六 Seedance Lite',
  ]);
  const getModelMediaType = (modelName) => IMAGE_MODEL_NAMES.has(modelName) ? 'image' : 'video';
  const getModelLabel = (modelName) => getModelMediaType(modelName) === 'image' ? '图片' : '视频';
  const getRowModelName = (row) => {
    const currentModel = row?.model || globalModel;
    const rowType = row?.type || getModelMediaType(currentModel);
    if (rowType === 'image' && !IMAGE_MODEL_NAMES.has(currentModel)) return generateChannel === 'chatgpt2api' ? '渠道五 GPT-Image2' : '渠道四 GPT-Image2';
    if (rowType === 'video' && IMAGE_MODEL_NAMES.has(currentModel)) return generateChannel === 'oiioii' ? '渠道四 Gemini' : generateChannel === 'dola' ? '渠道六 Seedance 2.0' : 'Seedance 2.0';
    return currentModel;
  };
  const getRowMediaLabel = (row) => row?.type === 'image' ? '图片' : '视频';
  const [activePopover, setActivePopover] = useState(null); // 'model' | 'params' | 'suffix' | null
  const [userPromptSuffixTemplates, setUserPromptSuffixTemplates] = useState(() => {
    try {
      const raw = localStorage.getItem(PROMPT_SUFFIX_TEMPLATES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(t => t?.name && t?.suffix) : [];
    } catch {
      return [];
    }
  });
  const promptSuffixTemplates = [...DEFAULT_PROMPT_SUFFIX_TEMPLATES, ...userPromptSuffixTemplates];
  const [selectedPromptSuffixId, setSelectedPromptSuffixId] = useState(() => localStorage.getItem('maocanju_prompt_suffix_id') || 'none');
  const [isAddingPromptSuffix, setIsAddingPromptSuffix] = useState(false);
  const [editingPromptSuffixId, setEditingPromptSuffixId] = useState(null);
  const [expandedPromptSuffixId, setExpandedPromptSuffixId] = useState(null);
  const [newPromptSuffixName, setNewPromptSuffixName] = useState('');
  const [newPromptSuffixValue, setNewPromptSuffixValue] = useState('');
  const selectedPromptSuffix = promptSuffixTemplates.find(t => t.id === selectedPromptSuffixId) || DEFAULT_PROMPT_SUFFIX_TEMPLATES[0];
  const saveUserPromptSuffixTemplates = (templates) => {
    setUserPromptSuffixTemplates(templates);
    localStorage.setItem(PROMPT_SUFFIX_TEMPLATES_KEY, JSON.stringify(templates));
  };
  const resetPromptSuffixForm = () => {
    setIsAddingPromptSuffix(false);
    setEditingPromptSuffixId(null);
    setNewPromptSuffixName('');
    setNewPromptSuffixValue('');
  };
  const startAddingPromptSuffixTemplate = () => {
    setEditingPromptSuffixId(null);
    setNewPromptSuffixName('');
    setNewPromptSuffixValue('');
    setIsAddingPromptSuffix(true);
  };
  const startEditingPromptSuffixTemplate = (template) => {
    if (!template || template.id === 'none') return;
    setEditingPromptSuffixId(template.id);
    setNewPromptSuffixName(template.name || '');
    setNewPromptSuffixValue(template.suffix || '');
    setIsAddingPromptSuffix(true);
  };
  const savePromptSuffixTemplateForm = () => {
    const cleanName = newPromptSuffixName.trim();
    const cleanSuffix = newPromptSuffixValue.trim();
    if (!cleanName || !cleanSuffix) {
      alert('请填写模板名称和后缀内容。');
      return;
    }

    if (editingPromptSuffixId) {
      const exists = userPromptSuffixTemplates.some(t => t.id === editingPromptSuffixId);
      if (!exists) {
        alert('没有找到要修改的后缀模板，请重新选择。');
        resetPromptSuffixForm();
        return;
      }
      const nextTemplates = userPromptSuffixTemplates.map(t => (
        t.id === editingPromptSuffixId ? { ...t, name: cleanName, suffix: cleanSuffix } : t
      ));
      saveUserPromptSuffixTemplates(nextTemplates);
      setSelectedPromptSuffixId(editingPromptSuffixId);
      localStorage.setItem('maocanju_prompt_suffix_id', editingPromptSuffixId);
      resetPromptSuffixForm();
      return;
    }

    const nextTemplate = {
      id: `user-${Date.now()}`,
      name: cleanName,
      suffix: cleanSuffix,
    };
    const nextTemplates = [...userPromptSuffixTemplates, nextTemplate];
    saveUserPromptSuffixTemplates(nextTemplates);
    setSelectedPromptSuffixId(nextTemplate.id);
    localStorage.setItem('maocanju_prompt_suffix_id', nextTemplate.id);
    resetPromptSuffixForm();
  };
  const deletePromptSuffixTemplate = (templateId) => {
    const target = userPromptSuffixTemplates.find(t => t.id === templateId);
    if (!target) return;
    if (!confirm(`确定删除后缀模板「${target.name}」吗？`)) return;
    const nextTemplates = userPromptSuffixTemplates.filter(t => t.id !== templateId);
    saveUserPromptSuffixTemplates(nextTemplates);
    if (selectedPromptSuffixId === templateId) {
      setSelectedPromptSuffixId('none');
      localStorage.setItem('maocanju_prompt_suffix_id', 'none');
    }
    if (editingPromptSuffixId === templateId) {
      resetPromptSuffixForm();
    }
  };
  const parseDurationSeconds = (durationValue, fallback = 5) => {
    const match = String(durationValue || '').match(/\d+(?:\.\d+)?/);
    if (!match) return fallback;
    const seconds = Number.parseFloat(match[0]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
  };

  const formatDurationLabel = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(2))}秒`;
  };

  const resolveDurationSeconds = (rowDuration, fallbackDuration, fallback = 5) => (
    parseDurationSeconds(rowDuration, parseDurationSeconds(fallbackDuration, fallback))
  );

  const buildPromptWithSuffix = (text = '') => {
    const base = String(text || '').trim();
    const suffix = (selectedPromptSuffix.suffix || '').trim();
    if (!suffix) return base;
    if (!base) return suffix;
    return base.includes(suffix) ? base : `${base}，${suffix}`;
  };
  const [modelPopoverTab, setModelPopoverTab] = useState(() => getModelMediaType(readGlobalGenerationSetting('model')));
  const [editingRowId, setEditingRowId] = useState(null); // row.id of the row currently being edited as plain text
  const promptDraftsRef = useRef({});
  const promptTextareaRefs = useRef({});
  const wizstarAccountCursorRef = useRef(0);
  const resizePromptTextarea = (textarea) => {
    if (!textarea) return;
    const maxHeight = 260;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(maxHeight, Math.max(72, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };
  const resizePromptTextareaById = (rowId) => {
    requestAnimationFrame(() => resizePromptTextarea(promptTextareaRefs.current[rowId]));
  };
  const [fullscreenVideo, setFullscreenVideo] = useState(null); // { src, mediaType } for fullscreen preview
  const [batchTab, setBatchTab] = useState('import'); // 'import' | 'process' | 'tasks'
  const [conversionFormat, setConversionFormat] = useState('WebP');
  const [conversionResolution, setConversionResolution] = useState('2K');
  const [activeAssetSubTab, setActiveAssetSubTab] = useState('character'); // 'character' | 'scene' | 'item'
  const [showBatchPromptModal, setShowBatchPromptModal] = useState(false);
  const [batchPromptText, setBatchPromptText] = useState('');
  const [batchPromptMode, setBatchPromptMode] = useState('append'); // 'append' | 'replace'
  const draftId = activeDraft?.id || 'default';
  const STORAGE_KEY_SEGMENTS = `maocanju_segments_${draftId}`;
  const STORAGE_KEY_CHARS = `maocanju_chars_${draftId}`;
  const STORAGE_KEY_SCENES = `maocanju_scenes_${draftId}`;
  const STORAGE_KEY_ITEMS = `maocanju_items_${draftId}`;
  const isLoadingProjectRef = useRef(false);

  const [characterAssets, setCharacterAssets] = useState([]);
  const [sceneAssets, setSceneAssets] = useState(() => {
    try {
      const raw = localStorage.getItem(`maocanju_scenes_${draftId}`);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [itemAssets, setItemAssets] = useState(() => {
    try {
      const raw = localStorage.getItem(`maocanju_items_${draftId}`);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });

  // 三种触发符 → 对应资产类型的元数据，统一驱动下拉与插入
  const TRIGGERS = {
    '@': { type: 'character', label: '角色' },
    '$': { type: 'scene', label: '场景' },
    '#': { type: 'item', label: '物品' },
  };

  // Autocomplete state when typing @ / $ / # to choose assets
  const [atState, setAtState] = useState({
    rowId: null,
    isOpen: false,
    trigger: '@',
    query: '',
    cursorPos: 0,
  });
  const [hoveredCharId, setHoveredCharId] = useState(null);
  const lastPersistKeyRef = useRef('');

  const isVideoUrl = isPlayableVideoUrlValue;
  const isLocalFilePath = isLocalFilePathValue;
  const localFilePathFromUrl = localFilePathFromUrlValue;
  const makeLocalFileUrl = (filePath = '') => {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    if (!normalized) return '';
    if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`;
    return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
  };
  const toLocalVideoUrl = toLocalVideoUrlValue;
  const toPlayableUrl = toPlayableVideoUrlValue;
  const playableUrlForMaterial = (material = {}) => {
    if (material.localPath) return toLocalVideoUrl(material.localPath);
    return toPlayableUrl(material.sourceUrl || material.remoteUrl || material.thumbnail || '');
  };
  const toDownloadUrl = (url = '', filename = 'video.mp4') =>
    `${WIZSTAR_API}/download/video?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
  const getFileStem = (filePath = '') => {
    const fileName = String(filePath).split(/[\\/]/).pop() || '';
    return fileName.replace(/\.[^.]+$/, '').trim();
  };
  const cleanAssetName = (name = '', triggerSymbol = '') => {
    const triggerPattern = triggerSymbol ? `\\${triggerSymbol}` : '@#$';
    return String(name || '')
      .trim()
      .replace(new RegExp(`^\\s*\\d+[\\s._-]*(?:[${triggerPattern}][\\s._-]*)?`), '')
      .replace(new RegExp(`^\\s*[${triggerPattern}][\\s._-]*`), '')
      .trim();
  };
  const normalizeAssetNames = (assets = [], triggerSymbol = '') => {
    let changed = false;
    const normalized = assets.map((asset) => {
      const cleanName = cleanAssetName(asset?.name, triggerSymbol);
      if (!cleanName || cleanName === asset?.name) return asset;
      changed = true;
      return { ...asset, name: cleanName };
    });
    return changed ? normalized : assets;
  };
  const isImageFilePath = (filePath = '') => /\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(filePath);
  const sortFilePathsByName = (filePaths = []) => [...filePaths].sort((a, b) => {
    const nameA = String(a).split(/[\\/]/).pop().toLowerCase();
    const nameB = String(b).split(/[\\/]/).pop().toLowerCase();
    return nameA.localeCompare(nameB, undefined, { numeric: true });
  });
  const selectLocalImageFiles = async () => {
    if (window.electronAPI && window.electronAPI.selectFiles) {
      return await window.electronAPI.selectFiles([
        { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }
      ]);
    }
    alert('当前环境不支持文件选择，请在桌面客户端中使用此功能。');
    return [];
  };
  const selectLocalImageDirectory = async () => {
    if (window.electronAPI && window.electronAPI.selectImageDirectory) {
      return await window.electronAPI.selectImageDirectory();
    }
    alert('当前环境不支持文件夹选择，请在桌面客户端中使用此功能。');
    return { canceled: true, filePaths: [] };
  };
  const getReferenceDisplayUrl = (seg) => {
    if (seg?.referenceImage && typeof seg.referenceImage === 'object') {
      return seg.referenceImage.displayUrl || seg.referenceImage.remoteUrl || seg.referenceImage.uploadUrl || '';
    }
    return seg?.referenceImage || '';
  };
  const getReferenceLocalPath = (seg) => {
    if (seg?.referenceImage && typeof seg.referenceImage === 'object') {
      return seg.referenceImage.localPath || '';
    }
    return seg?.referenceImagePath || '';
  };
  const getReferenceRemoteUrl = (seg) => {
    if (seg?.referenceImage && typeof seg.referenceImage === 'object') {
      return seg.referenceImage.uploadUrl || seg.referenceImage.remoteUrl || '';
    }
    const legacyRef = seg?.referenceImage || '';
    return typeof legacyRef === 'string' && /^https?:\/\//i.test(legacyRef) ? legacyRef : '';
  };
  const makeLocalReferenceImage = (filePath, fallbackUrl = '') => ({
    source: filePath ? 'local' : 'blob',
    displayUrl: filePath ? makeLocalFileUrl(filePath) : fallbackUrl,
    localPath: filePath || '',
    remoteUrl: '',
    uploadUrl: '',
  });
  const makeRemoteReferenceImage = (url) => ({
    source: 'remote',
    displayUrl: url,
    localPath: '',
    remoteUrl: url,
    uploadUrl: url,
  });

  // Character Asset Sub-Window Manager States
  const [showCharacterModal, setShowCharacterModal] = useState(false);
  const [editingCharId, setEditingCharId] = useState(null);
  const [newCharName, setNewCharName] = useState('');
  const [newCharRole, setNewCharRole] = useState('');
  const [newCharAvatar, setNewCharAvatar] = useState('');
  const [newCharAvatarPath, setNewCharAvatarPath] = useState('');

  const [mergeModalState, setMergeModalState] = useState({ open: false, rowId: null, items: [] });
  const [mergeAllProgress, setMergeAllProgress] = useState({ running: false, current: 0, total: 0 });

  const makeCharacterAsset = () => ({
    id: editingCharId === 'new' ? `c-${Date.now()}` : editingCharId,
    name: newCharName.trim(),
    avatar: newCharAvatar,
    avatarPath: newCharAvatarPath,
    role: newCharRole,
  });

  const getAssetImageRef = (asset) => {
    const avatar = asset?.avatar || '';
    const avatarPath = asset?.avatarPath || asset?.localPath || '';
    if (avatarPath) return { file_path: avatarPath };
    if (/^data:image\//i.test(avatar)) return { data_url: avatar };
    if (/^https?:\/\//i.test(avatar)) return { image: avatar };
    if (/^file:\/\//i.test(avatar)) return { file_path: avatar.replace(/^file:\/\/+/, '/') };
    return null;
  };

  const getCharacterImageRef = (char) => getAssetImageRef(char);

  const parseReferencedCharacterNames = (text = '') => {
    if (!text) return [];
    const names = [];
    const seen = new Set();
    const pushName = (value) => {
      const name = cleanAssetName(value, '@');
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };

    // Support both inserted tokens like （@小明） and plain text like @小明 from imported docs.
    const tokenRegex = /[（(]@([^）)\n\r]+)[）)]|(^|[\s，。；、,.!?！？：:])@([A-Za-z0-9_\-\u4e00-\u9fa5]+)/gm;
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
      pushName(match[1] || match[3]);
    }
    return names;
  };

  const parseReferencedSceneNames = (text = '') => {
    if (!text) return [];
    const names = [];
    const seen = new Set();
    const pushName = (value) => {
      const name = cleanAssetName(value, '$');
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };

    const tokenRegex = /[（(]\$([^）)\n\r]+)[）)]|(^|[\s，。；、,.!?！？：:])\$([A-Za-z0-9_\-\u4e00-\u9fa5]+)/gm;
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
      pushName(match[1] || match[3]);
    }
    return names;
  };

  const convertSceneMentionsForOiiOii = (text = '') => String(text || '')
    .replace(/[（(]\$([^）)]+)[）)]/g, '（@$1）')
    .replace(/(^|[\s，。；、,.!?！？：:])\$([A-Za-z0-9_\-\u4e00-\u9fa5]+)/gm, '$1@$2');

  const parseCharacterProfileName = (text = '') => {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return '';

    const hasProfileField = lines.slice(1, 6).some(line => /^(性别|年龄|身份|职业|角色|姓名)\s*[：:]/.test(line));
    if (!hasProfileField) return '';

    return cleanAssetName(lines[0].replace(/^[#*\-\d.、\s]+/, ''), '@');
  };

  const makeExportBaseName = (row, fallbackIndex, isVideo = false) => {
    const sequenceName = String(fallbackIndex || row.id || 1);
    if (isVideo) return sequenceName;

    const promptText = buildPromptWithSuffix(promptDraftsRef.current[row.id] ?? row.text ?? '');
    const profileName = parseCharacterProfileName(promptText);
    if (profileName) return profileName;

    const characterNames = parseReferencedCharacterNames(promptText);
    const associatedNames = Array.isArray(row.associatedCharacters)
      ? row.associatedCharacters.map(char => cleanAssetName(char?.name, '@')).filter(Boolean)
      : [];
    const sceneNames = parseReferencedSceneNames(promptText);
    const nameParts = [...new Set([...characterNames, ...associatedNames, ...sceneNames])];

    return nameParts.length > 0 ? `${sequenceName}.${nameParts.join('.')}` : sequenceName;
  };

  const getSegmentCharacterImageBindings = (seg, promptText = '') => {
    const textNames = parseReferencedCharacterNames(promptText || seg?.text || '');
    const associatedChars = Array.isArray(seg?.associatedCharacters) ? seg.associatedCharacters : [];
    const associatedByName = new Map(
      associatedChars
        .map(char => [String(char?.name || '').trim(), char])
        .filter(([name]) => name)
    );
    const assetByName = new Map(
      (characterAssets || [])
        .map(char => [String(char?.name || '').trim(), char])
        .filter(([name]) => name)
    );
    const orderedNames = textNames.length > 0
      ? textNames
      : associatedChars.map(char => String(char?.name || '').trim()).filter(Boolean);

    return orderedNames.map((name) => {
      const char = associatedByName.get(name) || assetByName.get(name);
      const ref = getCharacterImageRef(char);
      if (!ref) return null;
      return { ref, alias: name };
    }).filter(Boolean);
  };

  const getSegmentCharacterImageRefs = (seg, promptText = '') =>
    getSegmentCharacterImageBindings(seg, promptText).map(item => item.ref);

  const getSegmentCharacterAliases = (seg, promptText = '') =>
    getSegmentCharacterImageBindings(seg, promptText).map(item => item.alias).filter(Boolean);

  const getSegmentSceneImageRefs = (promptText = '') => {
    const sceneNames = parseReferencedSceneNames(promptText);
    if (sceneNames.length === 0) return [];
    const sceneByName = new Map(
      (sceneAssets || [])
        .map(scene => [cleanAssetName(scene?.name, '$'), scene])
        .filter(([name]) => name)
    );
    return sceneNames.map(name => getAssetImageRef(sceneByName.get(name))).filter(Boolean);
  };

  const imageRefToInput = (ref) => {
    if (!ref) return null;
    if (ref.file_path) return { file_path: ref.file_path };
    if (ref.data_url) return { data_url: ref.data_url };
    if (ref.image) return { url: ref.image };
    return null;
  };

  const imageRefToReference = (ref) => ref?.file_path || ref?.data_url || ref?.image || '';

  const getSegmentCharacterImageRef = (seg, promptText = '') => getSegmentCharacterImageRefs(seg, promptText)[0] || null;

  // ---- 图片合并：把"角色 / 场景 / 物品 / 垫图"统一转成 ImageMergeModal 需要的 item ----
  const parseReferencedItemNames = (text = '') => {
    if (!text) return [];
    const names = [];
    const seen = new Set();
    const pushName = (value) => {
      const name = cleanAssetName(value, '#');
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    };
    const tokenRegex = /[（(]#([^）)\n\r]+)[）)]|(^|[\s，。；、,.!?！？：:])#([A-Za-z0-9_\-\u4e00-\u9fa5]+)/gm;
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
      pushName(match[1] || match[3]);
    }
    return names;
  };

  // 把图片资产或垫图字段转成 <img> 能直接吃的 src + 用于落盘的 localPath。
  const assetToMergeSrc = (asset) => {
    const localPath = asset?.avatarPath || asset?.localPath || '';
    if (localPath) return { src: makeLocalFileUrl(localPath), localPath };
    const url = asset?.avatar || '';
    if (!url) return null;
    if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url) || /^blob:/i.test(url) || /^file:\/\//i.test(url)) {
      return { src: url, localPath: '' };
    }
    return null;
  };

  const segmentReferenceToMergeItem = (seg) => {
    const localPath = getReferenceLocalPath(seg);
    const displayUrl = getReferenceDisplayUrl(seg);
    if (!localPath && !displayUrl) return null;
    return {
      src: localPath ? makeLocalFileUrl(localPath) : displayUrl,
      localPath,
      label: '垫图',
      labelPrefix: '',
    };
  };

  const collectMergeItemsForRow = (row) => {
    const items = [];
    const seen = new Set();
    const push = (item) => {
      if (!item || !item.src) return;
      const key = item.localPath || item.src;
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };

    const refItem = segmentReferenceToMergeItem(row);
    if (refItem) push(refItem);

    const promptText = buildPromptWithSuffix(promptDraftsRef.current[row.id] ?? row.text ?? '');

    const characterByName = new Map(
      (characterAssets || []).map((c) => [String(c?.name || '').trim(), c]).filter(([n]) => n)
    );
    parseReferencedCharacterNames(promptText).forEach((name) => {
      const asset = characterByName.get(name)
        || (row.associatedCharacters || []).find((c) => String(c?.name || '').trim() === name);
      const src = assetToMergeSrc(asset);
      if (src) push({ ...src, label: name, labelPrefix: '@' });
    });

    const sceneByName = new Map(
      (sceneAssets || []).map((s) => [cleanAssetName(s?.name, '$'), s]).filter(([n]) => n)
    );
    parseReferencedSceneNames(promptText).forEach((name) => {
      const src = assetToMergeSrc(sceneByName.get(name));
      if (src) push({ ...src, label: name, labelPrefix: '$' });
    });

    const itemByName = new Map(
      (itemAssets || []).map((it) => [cleanAssetName(it?.name, '#'), it]).filter(([n]) => n)
    );
    parseReferencedItemNames(promptText).forEach((name) => {
      const src = assetToMergeSrc(itemByName.get(name));
      if (src) push({ ...src, label: name, labelPrefix: '#' });
    });

    return items;
  };

  const openMergeModalForRow = (row) => {
    const items = collectMergeItemsForRow(row);
    if (items.length === 0) {
      alert('该行没有可合并的图片。请先添加垫图，或在描述词中引用 @角色 / $场景 / #物品。');
      return;
    }
    setMergeModalState({ open: true, rowId: row.id, items });
  };

  const appendMergedImageToSegment = (seg, filePath) => {
    const displayUrl = makeLocalFileUrl(filePath);
    const isVid = seg.type === 'video';
    const list = isVid ? (seg.materialsVideo || []) : (seg.materialsImage || []);
    const newMatId = Math.max(0, ...list.map((m) => Number(m.id) || 0)) + 1;
    const newMat = {
      id: newMatId,
      name: `合并图片-${seg.id}-${newMatId}`,
      thumbnail: displayUrl,
      sourceUrl: displayUrl,
      localPath: filePath,
      remoteUrl: '',
      mediaType: 'image',
      status: 'new',
      textStatus: '合图',
      fps: null,
      duration: '静态图片',
    };

    const common = {
      ...seg,
      referenceImage: makeLocalReferenceImage(filePath),
      referenceImagePath: filePath,
    };

    if (isVid) {
      return {
        ...common,
        materialsVideo: [newMat, ...list],
        currentMaterialVideo: seg.isLocked ? seg.currentMaterialVideo : {
          id: newMatId,
          name: newMat.name,
          thumbnail: displayUrl,
          sourceUrl: displayUrl,
          localPath: filePath,
          remoteUrl: '',
          mediaType: 'image',
          isPlaying: false,
          fps: null,
          duration: '静态图片',
        },
      };
    }

    return {
      ...common,
      materialsImage: [newMat, ...list],
      currentMaterialImage: seg.isLocked ? seg.currentMaterialImage : {
        id: newMatId,
        name: newMat.name,
        thumbnail: displayUrl,
        sourceUrl: displayUrl,
        localPath: filePath,
        remoteUrl: '',
        mediaType: 'image',
        fps: null,
        duration: '静态图片',
      },
    };
  };

  const applyMergedImageToRow = (rowId, filePath) => {
    if (!filePath) return;
    setSegments((prev) => prev.map((s) => (s.id === rowId
      ? appendMergedImageToSegment(s, filePath)
      : s)));
  };

  const handleMergeAllRows = async () => {
    if (!segments.length) {
      alert('当前没有任何分镜行可处理。');
      return;
    }
    if (!window.electronAPI || !window.electronAPI.saveMergedImage) {
      alert('当前环境不支持本地保存，请在桌面客户端中使用此功能。');
      return;
    }
    if (mergeAllProgress.running) return;

    const candidates = segments
      .map((row) => ({ row, items: row.isLocked ? [] : collectMergeItemsForRow(row) }))
      .filter((c) => c.items.length > 0);
    if (candidates.length === 0) {
      alert('没有可合并的行（已锁定的行会跳过；其他行需要至少有 1 张垫图 / 角色 / 场景 / 物品图）。');
      return;
    }
    if (!confirm(`将为 ${candidates.length} 行生成合并垫图，已锁定 / 无图的行会跳过。继续？`)) return;

    setMergeAllProgress({ running: true, current: 0, total: candidates.length });

    const updates = [];
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < candidates.length; i++) {
      const { row, items } = candidates[i];
      try {
        let savedPath = '';
        const result = await mergeImages(items, {
          columns: 2,
          lastRowAlign: 'center',
          padding: 16,
          background: '#000000',
          format: 'png',
          showLabel: true,
          labelPosition: 'bottom-left',
        });
        const bytes = await blobToUint8Array(result.blob);
        const res = await window.electronAPI.saveMergedImage({
          bytes,
          ext: 'png',
          defaultName: `段落_${row.id}_${timestampForFilename()}`,
          silent: true,
        });
        if (!res?.ok) throw new Error(res?.error || '保存失败');
        savedPath = res.filePath;
        updates.push({ rowId: row.id, filePath: savedPath });
        okCount += 1;
      } catch (e) {
        console.error('[merge-all] row failed:', row.id, e);
        failCount += 1;
      }
      setMergeAllProgress({ running: true, current: i + 1, total: candidates.length });
    }

    if (updates.length > 0) {
      setSegments((prev) => prev.map((s) => {
        const hit = updates.find((u) => u.rowId === s.id);
        if (!hit) return s;
        return appendMergedImageToSegment(s, hit.filePath);
      }));
    }

    setMergeAllProgress({ running: false, current: 0, total: 0 });
    const skipped = segments.length - candidates.length;
    alert(`一键合并完成。\n成功 ${okCount} 行，失败 ${failCount} 行，跳过 ${skipped} 行（已锁定或无图）。`);
  };

  const syncCharacterRefs = (asset) => {
    setSegments(prev => prev.map(seg => {
      if (!Array.isArray(seg.associatedCharacters)) return seg;
      const nextChars = seg.associatedCharacters.map(char => (
        char.name === asset.name
          ? { ...char, avatar: asset.avatar, avatarPath: asset.avatarPath, role: asset.role }
          : char
      ));
      return { ...seg, associatedCharacters: nextChars };
    }));
  };

  // Handle local image upload as base64
  const handleLocalAvatarUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setNewCharAvatarPath(file.path || '');
      const reader = new FileReader();
      reader.onload = () => {
        setNewCharAvatar(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  // Save character asset details (create/update)
  const handleSaveCharacter = () => {
    if (!newCharName.trim()) {
      alert('请输入角色名称！');
      return;
    }

    const asset = makeCharacterAsset();
    if (editingCharId === 'new') {
      setCharacterAssets([
        ...characterAssets,
        asset
      ]);
      setEditingCharId(asset.id);
    } else {
      setCharacterAssets(characterAssets.map(c => 
        c.id === editingCharId 
          ? { ...c, ...asset, id: c.id }
          : c
      ));
      syncCharacterRefs({ ...asset, id: editingCharId });
    }
    alert('角色特征资产保存成功！现在可在任何分镜描述词中直接输入 @ 触发最新头像关联！');
  };

  // Delete character asset with confirmation
  const handleDeleteCharacter = () => {
    if (characterAssets.length <= 1) {
      alert('至少需要保留一个角色特征资产！');
      return;
    }
    if (confirm(`确认删除角色 "${newCharName}" 吗？`)) {
      const remaining = characterAssets.filter(c => c.id !== editingCharId);
      setCharacterAssets(remaining);
      if (remaining.length > 0) {
        setEditingCharId(remaining[0].id);
        setNewCharName(remaining[0].name);
        setNewCharRole(remaining[0].role || '');
        setNewCharAvatar(remaining[0].avatar);
        setNewCharAvatarPath(remaining[0].avatarPath || '');
      } else {
        setEditingCharId(null);
        setNewCharName('');
        setNewCharRole('');
        setNewCharAvatar('');
        setNewCharAvatarPath('');
        setShowCharacterModal(false);
      }
    }
  };
  
  // Convert specific generated image to reference image (垫图)
  const handleConvertToVideoReference = (rowId, material) => {
    const refUrl = material.sourceUrl || material.thumbnail || material.previewUrl || '';
    if (!refUrl || isVideoUrl(refUrl) || material.mediaType === 'video') {
      alert('视频素材不能作为垫图，请选择图片素材。');
      return;
    }
    setSegments(prev => prev.map(seg => {
      if (seg.id === rowId) {
        return {
          ...seg,
          referenceImage: makeRemoteReferenceImage(refUrl.replace('&w=120', '&w=500')),
          referenceImagePath: ''
        };
      }
      return seg;
    }));
    alert(`成功！已将生成图片 "${material.name}" 设置为该分镜的视频生成垫图！可以在视频模式下一键发送进行 Image-to-Video 渲染！`);
  };

  // Download a remote video via the local proxy (forces video/mp4 + attachment)
  const handleDownloadVideo = (url, name = 'video') => {
    if (!url || !/^https?:\/\//i.test(url)) {
      alert('该素材不是可下载的远程视频');
      return;
    }
    const safeName = String(name).replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = toDownloadUrl(url, `${safeName}.mp4`);
    a.download = `${safeName}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const blobToPngBlob = (blob) => new Promise((resolve, reject) => {
    if (blob.type === 'image/png') {
      resolve(blob);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('图片转换失败'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片加载失败'));
    };
    img.src = objectUrl;
  });

  const copyImageToClipboard = async (src = '') => {
    if (!src) return;
    try {
      if (!navigator.clipboard || !window.ClipboardItem) {
        throw new Error('当前环境不支持直接复制图片');
      }
      const response = await fetch(src);
      if (!response.ok) throw new Error(`图片读取失败 HTTP ${response.status}`);
      const blob = await response.blob();
      const pngBlob = await blobToPngBlob(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      alert('图片已复制到剪贴板');
    } catch (e) {
      console.warn('Copy image failed:', e);
      try {
        if (navigator.clipboard && /^https?:\/\//i.test(src)) {
          await navigator.clipboard.writeText(src);
          alert('直接复制图片失败，已复制图片链接');
          return;
        }
      } catch (_) {}
      alert(`复制失败：${e.message || e}`);
    }
  };

  const imageDragPrepareRef = useRef(new Map());

  const getImageDragPayload = (material = {}) => {
    const src = material.sourceUrl || material.remoteUrl || (material.localPath ? makeLocalFileUrl(material.localPath) : '') || material.thumbnail || '';
    return {
      src,
      localPath: material.localPath || '',
      name: material.name || 'image',
    };
  };

  const imageDragKey = (payload = {}) => [payload.localPath || '', payload.src || '', payload.name || ''].join('|');

  const prepareExternalImageDrag = async (material = {}) => {
    if (!material?.thumbnail || material.mediaType === 'video' || isVideoUrl(material.thumbnail)) return null;
    if (!window.electronAPI?.prepareImageDrag) return null;
    const payload = getImageDragPayload(material);
    const key = imageDragKey(payload);
    const cached = imageDragPrepareRef.current.get(key);
    if (cached?.ok) return cached;
    if (cached?.pending) return cached.promise;

    const promise = window.electronAPI.prepareImageDrag(payload).then((res) => {
      const next = res?.ok ? { ok: true, file: res.file } : { ok: false, error: res?.error || '准备图片失败' };
      imageDragPrepareRef.current.set(key, next);
      return next;
    }).catch((e) => {
      const next = { ok: false, error: e.message || String(e) };
      imageDragPrepareRef.current.set(key, next);
      return next;
    });
    imageDragPrepareRef.current.set(key, { pending: true, promise });
    return promise;
  };

  const startExternalImageDrag = (event, material = {}) => {
    if (!material?.thumbnail || material.mediaType === 'video' || isVideoUrl(material.thumbnail)) return;
    if (!window.electronAPI?.startImageDrag) return;
    event.preventDefault();
    const payload = getImageDragPayload(material);
    const cached = imageDragPrepareRef.current.get(imageDragKey(payload));
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', payload.src);
    window.electronAPI.startImageDrag({
      ...payload,
      preparedFile: cached?.ok ? cached.file : '',
    });
  };

  useEffect(() => {
    if (!window.electronAPI?.onImageDragError) return undefined;
    return window.electronAPI.onImageDragError((message) => {
      alert(`图片拖出失败：${message || '未知错误'}`);
    });
  }, []);

  // Export all current materials across every segment row into a chosen folder, named by row index (1.mp4, 2.mp4 ...)
  const handleExportAllCurrent = async () => {
    const items = [];
    const getLocalPathFromMaybeFileUrl = (value = '') => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^file:\/\//i.test(raw)) {
        try { return decodeURIComponent(new URL(raw).pathname); } catch (_) { return raw.replace(/^file:\/\/+/, '/'); }
      }
      return raw;
    };

    segments.forEach((row, idx) => {
      const isVid = row.type === 'video';
      const cur = isVid ? row.currentMaterialVideo : row.currentMaterialImage;
      const source = cur?.localPath || cur?.sourceUrl || cur?.thumbnail || '';
      const localPath = cur?.localPath || (/^file:\/\//i.test(source) ? getLocalPathFromMaybeFileUrl(source) : '');
      const remoteUrl = /^https?:\/\//i.test(source) ? source : '';
      if (!localPath && !remoteUrl) return;

      const cleanSource = (localPath || remoteUrl).split('?')[0];
      const extMatch = cleanSource.match(/\.(\w{2,5})$/);
      const ext = extMatch ? extMatch[1] : (isVid ? 'mp4' : 'png');
      items.push({
        url: remoteUrl,
        localPath,
        index: row.id || idx + 1,
        name: makeExportBaseName(row, idx + 1, isVid),
        ext,
      });
    });

    if (items.length === 0) {
      alert('当前没有可导出的素材，请先生成或选择画面。');
      return;
    }

    // Desktop (Electron): download into a chosen folder, named strictly by sequence number
    if (window.electronAPI && window.electronAPI.exportVideos) {
      const res = await window.electronAPI.exportVideos({ items });
      if (res?.canceled) return;
      if (res?.ok) {
        const failed = (res.results || []).filter(r => !r.ok);
        alert(`导出完成：成功 ${res.okCount}/${res.total} 个，已保存到\n${res.targetDir}` + (failed.length ? `\n失败序号：${failed.map(f => f.index).join(', ')}` : ''));
      } else {
        alert(`导出失败：${res?.error || '未知错误'}`);
      }
      return;
    }

    // Browser fallback: trigger sequential downloads named by index
    for (const item of items) {
      const a = document.createElement('a');
      a.href = toDownloadUrl(item.url, `${item.name || item.index}.${item.ext}`);
      a.download = `${item.name || item.index}.${item.ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  const handleClearAllMaterials = () => {
    const hasAnyMaterial = segments.some((row) => (
      row.currentMaterialVideo?.thumbnail
      || row.currentMaterialImage?.thumbnail
      || (row.materialsVideo || []).length > 0
      || (row.materialsImage || []).length > 0
    ));

    if (!hasAnyMaterial) {
      alert('当前没有可清空的素材。');
      return;
    }

    if (!confirm('确定要清空所有分镜的当前素材和可选素材吗？')) return;

    setSegments(prev => prev.map(seg => ({
      ...seg,
      isLocked: false,
      currentMaterialVideo: {
        id: 0,
        name: '暂无画面',
        thumbnail: '',
        mediaType: 'video',
        isPlaying: false,
        fps: null,
        duration: null,
      },
      materialsVideo: [],
      currentMaterialImage: {
        id: 0,
        name: '暂无画面',
        thumbnail: '',
        mediaType: 'image',
        fps: null,
        duration: null,
      },
      materialsImage: [],
    })));
  };
  
  // Simulated files chosen for batch actions
  const [batchFiles, setBatchFiles] = useState([]);

  // Simulated running background tasks (format conversions or AI processing)
  const [batchTasks, setBatchTasks] = useState([]);

  // Handler: Batch select files or directory
  const handleSelectBatchFolder = async () => {
    if (window.electronAPI) {
      const selected = await window.electronAPI.selectDirectory();
      if (selected) {
        alert(`成功扫描到目录: ${selected}\n已加载 5 个新素材到待处理列表。`);
      }
    } else {
      alert('已扫描到本地图片/视频素材，并自动加载到批量处理列表！');
    }
  };

  // Handler: Batch Import Files to segments materials list
  const handleRunBatchImport = () => {
    let importedVideoCount = 0;
    let importedImageCount = 0;

    setSegments(prev => prev.map(seg => {
      const isVid = seg.type === 'video';
      const filesToImport = batchFiles.filter(f => isVid ? f.type === 'video' : f.type === 'image');
      
      const newMaterials = filesToImport.map((f, i) => {
        if (isVid) importedVideoCount++;
        else importedImageCount++;
        
        return {
          id: Date.now() + i,
          name: f.name.split('.')[0],
          thumbnail: isVid ? 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&q=80&w=120' : 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&q=80&w=120',
          mediaType: isVid ? 'video' : 'image',
          status: 'new',
          textStatus: isVid ? '批导' : '批画'
        };
      });

      if (isVid) {
        return { ...seg, materialsVideo: [...newMaterials, ...seg.materialsVideo] };
      } else {
        return { ...seg, materialsImage: [...newMaterials, ...seg.materialsImage] };
      }
    }));

    alert(`批量导入成功！\n已为视频行分镜追加 ${importedVideoCount} 个候选帧；\n已为图片行分镜追加 ${importedImageCount} 张候选图！`);
  };

  // Handler: Batch Convert Images format / resolution
  const handleRunBatchConvert = () => {
    const taskId = `t-${Date.now()}`;
    const newTask = {
      id: taskId,
      name: `批量转换图片格式 (${conversionResolution} ${conversionFormat})`,
      type: 'convert',
      progress: 0,
      status: 'processing',
      time: '剩余 8s'
    };

    setBatchTasks(prev => [newTask, ...prev]);
    setBatchTab('tasks');

    // Simulate task running progress
    let currentProgress = 0;
    const interval = setInterval(() => {
      currentProgress += 20;
      setBatchTasks(prev => prev.map(task => {
        if (task.id === taskId) {
          if (currentProgress >= 100) {
            clearInterval(interval);
            return { ...task, progress: 100, status: 'completed', time: '已完成' };
          }
          return { ...task, progress: currentProgress, time: `剩余 ${Math.ceil((100 - currentProgress) / 10)}s` };
        }
        return task;
      }));
    }, 1500);
  };

  const createSegmentRow = (id, text = '') => ({
    id,
    type: 'video',
    referenceImage: null,
    text,
    model: globalModel,
    aspectRatio: globalAspectRatio,
    duration: globalDuration,
    quality: globalResolution,
    generating: false,
    isLocked: false,
    associatedCharacters: [],
    currentMaterialVideo: {
      id: 0,
      name: '暂无画面',
      thumbnail: '',
      mediaType: 'video',
      isPlaying: false,
      fps: null,
      duration: null
    },
    materialsVideo: [],
    currentMaterialImage: {
      id: 0,
      name: '暂无画面',
      thumbnail: '',
      mediaType: 'image',
      fps: null,
      duration: null
    },
    materialsImage: []
  });

  // Handler: Batch apply local images as reference image (垫图) sequentially
  const handleRunBatchReferenceImage = async () => {
    if (segments.length === 0) {
      alert('请先添加分镜行，再批量加垫图！');
      return;
    }

    let filePaths = await selectLocalImageFiles();
    if (!filePaths || filePaths.length === 0) return;

    filePaths = sortFilePathsByName(filePaths.filter(isImageFilePath));

    setSegments(prev => prev.map((seg, index) => {
      if (index < filePaths.length) {
        return { ...seg, referenceImage: makeLocalReferenceImage(filePaths[index]), referenceImagePath: filePaths[index] };
      }
      return seg;
    }));

    const applied = Math.min(filePaths.length, segments.length);
    alert(`批量垫图完成！已为前 ${applied} 行分镜分配垫图。\n选择了 ${filePaths.length} 张图片，当前共 ${segments.length} 行分镜。`);
  };

  const openBatchPromptModal = () => {
    setBatchPromptText(segments.map(seg => promptDraftsRef.current[seg.id] ?? seg.text ?? '').join('\n'));
    setBatchPromptMode('replace');
    setShowBatchPromptModal(true);
  };

  const parseSceneDuration = (block = '') => {
    const header = String(block || '').split('\n').find(line => /镜头\s*\d+/i.test(line)) || '';
    const match = header.match(/[\[/【]\s*镜头\s*\d+\s*\/\s*(\d+(?:\.\d+)?)\s*s?\s*[\]】]/i);
    if (!match) return '';
    return formatDurationLabel(parseDurationSeconds(match[1], 5));
  };

  const normalizeImportedShotBlock = (block = '') => String(block || '')
    .replace(/^\s*={3,}\s*/g, '')
    .replace(/\n\s*={3,}\s*$/g, '')
    .trim();

  const splitPromptByShotHeaders = (raw = '') => {
    const source = String(raw || '');
    const shotHeaderRegex = /(?:^|\n)\s*(?:\d+\s*[.．、]\s*)?(?:#{1,6}\s*)?[^\n]*?[\[【]\s*镜头\s*\d+\s*\/\s*\d+(?:\.\d+)?\s*s?\s*[\]】][^\n]*/g;
    const matches = [...source.matchAll(shotHeaderRegex)];
    if (matches.length === 0) return [];

    return matches.map((match, index) => {
      const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
      const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
      return normalizeImportedShotBlock(source.slice(start, end));
    }).filter(Boolean);
  };

  const parseBatchPromptBlocks = (text = '') => {
    const raw = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!raw) return [];

    const shotBlocks = splitPromptByShotHeaders(raw);
    if (shotBlocks.length > 0) {
      return shotBlocks.map(block => ({ text: block, duration: parseSceneDuration(block) })).filter(item => item.text);
    }

    const numberedBlockRegex = /(?:^|\n)\s*(?:第\s*)?(\d{1,4})(?:\s*[.．](?!\d)|\s*[、:：）)]|\s*段[：:]?)\s*\n?/g;
    const matches = [...raw.matchAll(numberedBlockRegex)];
    if (matches.length > 0) {
      return matches.map((match, index) => {
        const contentStart = match.index + match[0].length;
        const contentEnd = index + 1 < matches.length ? matches[index + 1].index : raw.length;
        return { text: raw.slice(contentStart, contentEnd).trim(), duration: '' };
      }).filter(item => item.text);
    }

    return raw
      .split(/\n{2,}/)
      .map(block => block.trim())
      .filter(Boolean)
      .flatMap(block => block.includes('\n')
        ? block.split('\n').map(line => line.trim()).filter(Boolean).map(line => ({ text: line, duration: '' }))
        : [{ text: block, duration: '' }]);
  };

  const applyBatchPrompts = () => {
    const promptBlocks = parseBatchPromptBlocks(batchPromptText);
    if (promptBlocks.length === 0) {
      alert('请先输入要批量添加的提示词。支持 1.、2.、3. 分段，也支持“## 标题 - [镜头1 / 15.0s]”格式。');
      return;
    }

    setSegments(prev => {
      const nextSegments = [...prev];
      let nextId = nextSegments.length > 0 ? Math.max(...nextSegments.map(s => Number(s.id) || 0)) + 1 : 1;
      while (nextSegments.length < promptBlocks.length) {
        nextSegments.push(createSegmentRow(nextId++, ''));
      }
      return nextSegments.map((seg, index) => {
        if (index >= promptBlocks.length) return seg;
        const promptBlock = promptBlocks[index];
        const currentText = promptDraftsRef.current[seg.id] ?? seg.text ?? '';
        const nextText = batchPromptMode === 'append' && currentText.trim()
          ? `${currentText.trim()}\n${promptBlock.text}`
          : promptBlock.text;
        promptDraftsRef.current[seg.id] = nextText;
        const textarea = promptTextareaRefs.current[seg.id];
        if (textarea) {
          textarea.value = nextText;
          resizePromptTextarea(textarea);
        }
        return { ...seg, text: nextText, ...(promptBlock.duration ? { duration: promptBlock.duration } : {}) };
      });
    });

    setShowBatchPromptModal(false);
    alert(`批量提示词已应用：${promptBlocks.length} 条。`);
  };

  const importAssetImages = async (assetType = activeAssetSubTab) => {
    const typeLabel = assetType === 'character' ? '角色' : assetType === 'scene' ? '场景' : '物品';
    const selected = await selectLocalImageDirectory();
    if (selected?.canceled) return;
    let filePaths = selected?.filePaths || [];
    if (!filePaths.length) {
      alert(`所选文件夹中没有可导入的图片文件。`);
      return;
    }

    filePaths = sortFilePathsByName(filePaths.filter(isImageFilePath));
    if (filePaths.length === 0) {
      alert('没有选择有效图片文件。');
      return;
    }

    const makeAssets = (existing = []) => {
      const existingNames = new Set(existing.map(asset => String(asset.name || '').trim()).filter(Boolean));
      const imported = [];
      filePaths.forEach((filePath, index) => {
        const rawBaseName = getFileStem(filePath) || `${typeLabel}${index + 1}`;
        const baseName = cleanAssetName(rawBaseName, assetType === 'scene' ? '$' : assetType === 'item' ? '#' : '@') || `${typeLabel}${index + 1}`;
        let name = baseName;
        let suffix = 2;
        while (existingNames.has(name)) {
          name = `${baseName}-${suffix++}`;
        }
        existingNames.add(name);
        const common = {
          id: `${assetType}-${Date.now()}-${index}`,
          name,
          role: typeLabel,
          avatar: makeLocalFileUrl(filePath),
          avatarPath: filePath,
        };
        imported.push(common);
      });
      return imported;
    };

    if (assetType === 'character') {
      setCharacterAssets(prev => [...prev, ...makeAssets(prev)]);
    } else if (assetType === 'scene') {
      setSceneAssets(prev => [...prev, ...makeAssets(prev)]);
    } else {
      setItemAssets(prev => [...prev, ...makeAssets(prev)]);
    }
    setActiveAssetSubTab(assetType);
    alert(`已从文件夹导入 ${filePaths.length} 个${typeLabel}，名称已使用图片文件名并自动去除编号/触发符前缀。`);
  };

  const [segments, setSegments] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const loadProjectPayload = async () => {
      isLoadingProjectRef.current = true;
      try {
        const res = await fetch(`${WIZSTAR_API}/projects/${encodeURIComponent(draftId)}/payload`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const normalizeSegments = (items = []) => items.map(seg => {
          const displayUrl = getReferenceDisplayUrl(seg);
          const localPath = getReferenceLocalPath(seg);
          const remoteUrl = getReferenceRemoteUrl(seg);
          return {
            ...seg,
            associatedCharacters: Array.isArray(seg.associatedCharacters) ? seg.associatedCharacters : [],
            referenceImage: seg.referenceImage && typeof seg.referenceImage === 'object'
              ? seg.referenceImage
              : (localPath ? makeLocalReferenceImage(localPath) : (remoteUrl ? makeRemoteReferenceImage(remoteUrl) : displayUrl)),
            referenceImagePath: localPath,
            materialsVideo: (seg.materialsVideo || []).map(m => ({ ...m, mediaType: m.mediaType || (isVideoUrl(m.thumbnail) ? 'video' : 'image') })),
            materialsImage: (seg.materialsImage || []).map(m => ({ ...m, mediaType: m.mediaType || (isVideoUrl(m.thumbnail) ? 'video' : 'image') })),
            currentMaterialVideo: seg.currentMaterialVideo ? { ...seg.currentMaterialVideo, mediaType: seg.currentMaterialVideo.mediaType || (isVideoUrl(seg.currentMaterialVideo.thumbnail) ? 'video' : 'image') } : seg.currentMaterialVideo,
            currentMaterialImage: seg.currentMaterialImage ? { ...seg.currentMaterialImage, mediaType: seg.currentMaterialImage.mediaType || (isVideoUrl(seg.currentMaterialImage.thumbnail) ? 'video' : 'image') } : seg.currentMaterialImage,
          };
        });
      const loadedSegments = normalizeSegments(data.data?.segments || []);
      const loadedChars = data.data?.character_assets || [];
        setSegments(loadedSegments);
        setCharacterAssets(loadedChars);
        localStorage.setItem(STORAGE_KEY_SEGMENTS, JSON.stringify(loadedSegments));
        localStorage.setItem(STORAGE_KEY_CHARS, JSON.stringify(loadedChars));
      } catch (e) {
        console.warn('读取后端项目内容失败，临时回退到浏览器本地缓存:', e);
        if (cancelled) return;
        try {
          const rawSegments = localStorage.getItem(STORAGE_KEY_SEGMENTS);
          const rawChars = localStorage.getItem(STORAGE_KEY_CHARS);
          setSegments(rawSegments ? JSON.parse(rawSegments) : []);
          setCharacterAssets(rawChars ? JSON.parse(rawChars) : []);
        } catch {
          setSegments([]);
          setCharacterAssets([]);
        }
      } finally {
        setTimeout(() => { isLoadingProjectRef.current = false; }, 0);
      }
    };
    loadProjectPayload();
    return () => { cancelled = true; };
  }, [draftId, STORAGE_KEY_SEGMENTS, STORAGE_KEY_CHARS, WIZSTAR_API]);

  // Auto-save segments and characterAssets to backend SQLite, with localStorage as a fallback cache
  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    const toSave = segments.map(s => ({
      ...s,
      generating: false,
      generateStatus: null,
      generateProgress: null,
      queuePosition: null,
    }));
    const persistKey = JSON.stringify({ segments: toSave, character_assets: characterAssets });
    if (persistKey === lastPersistKeyRef.current) return;
    lastPersistKeyRef.current = persistKey;
    try {
      localStorage.setItem(STORAGE_KEY_SEGMENTS, JSON.stringify(toSave));
    } catch (e) { console.warn('Failed to save segments cache:', e); }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${WIZSTAR_API}/projects/${encodeURIComponent(draftId)}/payload`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: toSave, character_assets: characterAssets }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onProjectChanged?.();
      } catch (e) {
        console.warn('Failed to save project payload:', e);
      }
    }, 1200);

    return () => clearTimeout(timer);
  }, [segments, characterAssets, draftId, STORAGE_KEY_SEGMENTS, WIZSTAR_API, onProjectChanged]);

  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    try {
      localStorage.setItem(STORAGE_KEY_CHARS, JSON.stringify(characterAssets));
    } catch (e) { console.warn('Failed to save characterAssets cache:', e); }
  }, [characterAssets, STORAGE_KEY_CHARS]);

  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    try {
      localStorage.setItem(STORAGE_KEY_SCENES, JSON.stringify(sceneAssets));
    } catch (e) { console.warn('Failed to save sceneAssets cache:', e); }
  }, [sceneAssets, STORAGE_KEY_SCENES]);

  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    try {
      localStorage.setItem(STORAGE_KEY_ITEMS, JSON.stringify(itemAssets));
    } catch (e) { console.warn('Failed to save itemAssets cache:', e); }
  }, [itemAssets, STORAGE_KEY_ITEMS]);

  // Reload scene/item assets from local cache when switching drafts
  useEffect(() => {
    try {
      const rawScenes = localStorage.getItem(STORAGE_KEY_SCENES);
      const rawItems = localStorage.getItem(STORAGE_KEY_ITEMS);
      const nextScenes = rawScenes ? JSON.parse(rawScenes) : [];
      const nextItems = rawItems ? JSON.parse(rawItems) : [];
      setSceneAssets(normalizeAssetNames(nextScenes, '$'));
      setItemAssets(normalizeAssetNames(nextItems, '#'));
    } catch {
      setSceneAssets([]);
      setItemAssets([]);
    }
  }, [STORAGE_KEY_SCENES, STORAGE_KEY_ITEMS]);

  // Persist global generation settings across all projects
  useEffect(() => {
    const settings = {
      model: globalModel,
      aspectRatio: globalAspectRatio,
      duration: globalDuration,
      resolution: globalResolution,
      generateChannel,
    };
    try {
      localStorage.setItem(GLOBAL_GENERATION_SETTINGS_KEY, JSON.stringify(settings));
      localStorage.setItem('maocanju_generate_channel', generateChannel);
    } catch (e) {
      console.warn('Failed to save global generation settings:', e);
    }
  }, [globalModel, globalAspectRatio, globalDuration, globalResolution, generateChannel]);

  const updateGlobalAspectRatio = (aspectRatio) => {
    setGlobalAspectRatio(aspectRatio);
    setSegments(prev => prev.map(seg => ({ ...seg, aspectRatio })));
  };

  const updateGlobalDuration = (duration) => {
    setGlobalDuration(duration);
    setSegments(prev => prev.map(seg => ({ ...seg, duration })));
  };

  const updateGlobalResolution = (quality) => {
    setGlobalResolution(quality);
    setSegments(prev => prev.map(seg => ({ ...seg, quality })));
  };

  const selectGenerationModel = (modelName, channel) => {
    const nextChannel = channel === 'quickframe' ? 'wizstar' : channel;
    const nextType = getModelMediaType(modelName);
    setGlobalModel(modelName);
    setGenerateChannel(nextChannel);
    setModelPopoverTab(nextType);
    setSegments(prev => prev.map(seg => ({
      ...seg,
      model: modelName,
      type: nextType,
      aspectRatio: globalAspectRatio,
      duration: globalDuration,
      quality: globalResolution,
    })));
    setActivePopover(null);
  };

  // Optimize Prompt using mock AI
  const handleInference = (id) => {
    alert(`第 ${id} 行描述词优化成功！已注入电影级镜头参数。`);
  };

  // Generate / Render Material for specific row — calls Wizstar API

  // Register tasks globally; one lightweight scheduler polls them in batches, even if the current project is closed/switched.
  const registerGenerationTask = useCallback((segId, taskId, channel = 'wizstar', mediaType = 'video', meta = {}) => {
    if (!taskId) return;
    const now = Date.now();
    const registry = readGenerationTaskRegistry();
    const nextTask = {
      draftId,
      segId,
      taskId,
      channel,
      mediaType,
      status: meta.status || 'processing',
      progress: typeof meta.progress === 'number' ? meta.progress : 0,
      queuePosition: meta.queuePosition ?? null,
      accountId: meta.accountId || 0,
      accountName: meta.accountName || '',
      conversationId: meta.conversationId || '',
      createdAt: now,
      updatedAt: now,
    };
    const exists = registry.some(t => t.taskId === taskId);
    writeGenerationTaskRegistry(exists
      ? registry.map(t => t.taskId === taskId ? {
        ...t,
        ...nextTask,
        accountId: nextTask.accountId || t.accountId || 0,
        accountName: nextTask.accountName || t.accountName || '',
        conversationId: nextTask.conversationId || t.conversationId || '',
        createdAt: t.createdAt || now,
      } : t)
      : [...registry, nextTask]);
    startGlobalGenerationPolling();
  }, [draftId]);
  useEffect(() => {
    startGlobalGenerationPolling();
  }, []);

  // Keep only the currently visible project's rows in sync. Polling itself is global and survives project close/switch.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const registry = readGenerationTaskRegistry();
      const currentTasks = registry.filter(t => t.draftId === draftId);
      if (currentTasks.length === 0) return;

      const tasksBySegId = new Map();
      currentTasks.forEach(task => {
        const list = tasksBySegId.get(task.segId) || [];
        list.push(task);
        tasksBySegId.set(task.segId, list);
      });
      const doneIds = new Set();
      let changed = false;

      setSegments(prev => {
        const next = prev.map(seg => {
          const tasks = tasksBySegId.get(seg.id) || [];
          if (tasks.length === 0) return seg;

          let nextSeg = seg;
          let rowChanged = false;

          tasks.forEach(task => {
            const completedMediaUrl = task.mediaUrl || task.imageUrl || task.videoUrl || task.cdnUrl || task.downloadUrl || '';
            const completedLocalPath = task.localPath || localFilePathFromUrl(completedMediaUrl);
            if (task.status === 'completed' && (completedMediaUrl || completedLocalPath)) {
              doneIds.add(task.taskId);
              rowChanged = true;
              const localPath = completedLocalPath;
              const sourceUrl = task.videoUrl || task.downloadUrl || task.cdnUrl || task.mediaUrl || completedMediaUrl;
              const playableUrl = localPath ? toLocalVideoUrl(localPath) : toPlayableUrl(sourceUrl || completedMediaUrl);
              const resultMediaType = task.mediaType || (isVideoUrl(playableUrl) ? 'video' : 'image');
              const isVid = resultMediaType === 'video';
              const list = isVid ? nextSeg.materialsVideo : nextSeg.materialsImage;
              const normalizedMediaUrl = (localPath || sourceUrl || playableUrl).split('?')[0];
              const existing = list.find(m => ((m.localPath || m.sourceUrl || m.thumbnail || '').split('?')[0]) === normalizedMediaUrl);

              if (existing) {
                nextSeg = {
                  ...nextSeg,
                  type: isVid ? 'video' : 'image',
                  generationError: '',
                  ...(isVid
                    ? { currentMaterialVideo: nextSeg.isLocked ? nextSeg.currentMaterialVideo : existing }
                    : { currentMaterialImage: nextSeg.isLocked ? nextSeg.currentMaterialImage : existing }),
                };
                return;
              }

              const newMatId = Math.max(...list.map(m => m.id), 0) + 1;
              const matName = `${task.segId}-${newMatId}`;
              if (isVid) {
                const newMat = { id: newMatId, name: matName, thumbnail: playableUrl, sourceUrl, localPath, remoteUrl: sourceUrl, mediaType: 'video', status: 'new', textStatus: localPath ? '本地' : '新' };
                nextSeg = {
                  ...nextSeg,
                  type: 'video',
                  generationError: '',
                  materialsVideo: [newMat, ...nextSeg.materialsVideo],
                  currentMaterialVideo: nextSeg.isLocked ? nextSeg.currentMaterialVideo : {
                    id: newMatId, name: matName, thumbnail: playableUrl, sourceUrl, localPath, remoteUrl: sourceUrl, mediaType: 'video', isPlaying: false, fps: 25, duration: '00:05'
                  }
                };
                return;
              }

              const newMat = { id: newMatId, name: matName, thumbnail: playableUrl, sourceUrl, localPath, remoteUrl: sourceUrl, mediaType: 'image', status: 'new', textStatus: '图' };
              nextSeg = {
                ...nextSeg,
                type: 'image',
                generationError: '',
                materialsImage: [newMat, ...nextSeg.materialsImage],
                currentMaterialImage: nextSeg.isLocked ? nextSeg.currentMaterialImage : {
                  id: newMatId, name: matName, thumbnail: playableUrl, sourceUrl, localPath, remoteUrl: sourceUrl, mediaType: 'image', fps: null, duration: '静态图片'
                }
              };
              return;
            }

            if (task.status === 'failed') {
              doneIds.add(task.taskId);
              rowChanged = true;
              nextSeg = {
                ...nextSeg,
                generationError: task.error || '生成任务失败，请检查账号、积分、模型或参考图后重试。',
                lastFailedTaskId: task.taskId,
                lastFailedChannel: task.channel,
                lastConversationId: task.conversationId || nextSeg.pendingConversationId || '',
              };
            }
          });

          const activeTasks = tasks.filter(task => !doneIds.has(task.taskId));
          if (activeTasks.length > 0) {
            const displayTask = activeTasks[activeTasks.length - 1];
            const nextStatus = ['pending', 'running', 'processing'].includes(displayTask.status) ? 'processing' : (displayTask.status || 'processing');
            const nextProgress = typeof displayTask.progress === 'number' ? displayTask.progress : nextSeg.generateProgress;
            rowChanged = true;
            nextSeg = {
              ...nextSeg,
              generating: true,
              pendingTaskId: displayTask.taskId,
              pendingTaskIds: activeTasks.map(task => task.taskId),
              pendingChannel: displayTask.channel,
              pendingAccountId: displayTask.accountId || nextSeg.pendingAccountId || 0,
              pendingAccountName: displayTask.accountName || nextSeg.pendingAccountName || '',
              pendingConversationId: displayTask.conversationId || nextSeg.pendingConversationId || '',
              generateStatus: nextStatus,
              queuePosition: displayTask.queuePosition,
              generateProgress: nextProgress,
              activeTaskCount: activeTasks.length,
            };
          } else if (rowChanged || nextSeg.generating || nextSeg.pendingTaskId) {
            nextSeg = {
              ...nextSeg,
              generating: false,
              pendingTaskId: null,
              pendingTaskIds: [],
              pendingAccountId: 0,
              pendingAccountName: '',
              pendingConversationId: '',
              generateStatus: null,
              queuePosition: null,
              generateProgress: null,
              activeTaskCount: 0,
            };
          }

          if (rowChanged) changed = true;
          return rowChanged ? nextSeg : seg;
        });
        return changed ? next : prev;
      });

      if (doneIds.size > 0) {
        writeGenerationTaskRegistry(readGenerationTaskRegistry().filter(t => !doneIds.has(t.taskId)));
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [draftId]);

  // After project payload loads, register persisted pending tasks instead of spawning per-task loops.
  useEffect(() => {
    if (isLoadingProjectRef.current) return;
    segments.forEach(seg => {
      const taskIds = [...new Set([seg.pendingTaskId, ...(seg.pendingTaskIds || [])].filter(Boolean))];
      taskIds.forEach(taskId => {
        registerGenerationTask(seg.id, taskId, seg.pendingChannel || 'wizstar', seg.type === 'image' ? 'image' : 'video');
      });
    });
  }, [segments, registerGenerationTask]); // eslint-disable-line react-hooks/exhaustive-deps

  const uploadImageRefForWizstar = async (imageRef, account) => {
    if (!imageRef) return '';
    if (imageRef.image) return imageRef.image;
    if (!account) {
      throw new Error('本地/角色图片需要先上传：当前没有可用的账号用于上传。请先在账号库注册一个账号。');
    }
    const uploadBody = { account_id: account.id };
    if (imageRef.file_path) uploadBody.file_path = imageRef.file_path;
    if (imageRef.data_url) uploadBody.data_url = imageRef.data_url;
    const uploadRes = await fetch(`${WIZSTAR_API}/tasks/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadBody),
    });
    if (!uploadRes.ok) {
      let uploadErr = '图片上传失败';
      try { const e = await uploadRes.json(); uploadErr = e.detail || uploadErr; } catch (_) {}
      throw new Error(uploadErr);
    }
    const uploadData = await uploadRes.json();
    return uploadData.data?.url || '';
  };

  // Resolve a usable image URL for the given segment.
  // Reuses the Wizstar S3 upload to turn a local file into a remote URL when needed.
  // `account` is required for local upload.
  const resolveImageUrl = async (seg, id, account, promptText = '') => {
    const localImagePath = getReferenceLocalPath(seg);
    const remoteImageUrl = getReferenceRemoteUrl(seg);
    if (remoteImageUrl) return remoteImageUrl;
    if (localImagePath) {
      const picUrl = await uploadImageRefForWizstar({ file_path: localImagePath }, account);
      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        referenceImage: { ...(s.referenceImage && typeof s.referenceImage === 'object' ? s.referenceImage : makeLocalReferenceImage(localImagePath)), uploadUrl: picUrl }
      } : s));
      return picUrl;
    }
    const roleImageRef = getSegmentCharacterImageRef(seg, promptText);
    if (roleImageRef) {
      const picUrl = await uploadImageRefForWizstar(roleImageRef, account);
      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        referenceImage: {
          source: 'role',
          displayUrl: roleImageRef.image || roleImageRef.data_url || (roleImageRef.file_path ? makeLocalFileUrl(roleImageRef.file_path) : ''),
          localPath: roleImageRef.file_path || '',
          remoteUrl: roleImageRef.image || '',
          uploadUrl: picUrl,
        },
        referenceImagePath: roleImageRef.file_path || s.referenceImagePath || '',
      } : s));
      return picUrl;
    }
    if (getReferenceDisplayUrl(seg)?.startsWith('blob:')) {
      throw new Error('浏览器拖入的图片缺少本地路径，无法上传生成。请在桌面客户端中点击“垫图”选择文件。');
    }
    return '';
  };

  const hasActiveGenerationTask = (seg) => !!(seg?.generating || seg?.pendingTaskId || (seg?.pendingTaskIds || []).length > 0);

  const resetRowGenerationState = (id, removeRegisteredTask = false) => {
    const currentSeg = segments.find(seg => seg.id === id);
    const taskIdsToRemove = [currentSeg?.pendingTaskId, ...(currentSeg?.pendingTaskIds || [])].filter(Boolean);
    setSegments(prev => prev.map(seg => {
      if (seg.id !== id) return seg;
      return {
        ...seg,
        generating: false,
        pendingTaskId: null,
        pendingTaskIds: [],
        pendingChannel: null,
        pendingAccountId: 0,
        pendingAccountName: '',
        generateStatus: null,
        generationError: '',
        queuePosition: null,
        generateProgress: null,
        activeTaskCount: 0,
      };
    }));
    if (removeRegisteredTask && taskIdsToRemove.length > 0) {
      const removeSet = new Set(taskIdsToRemove);
      writeGenerationTaskRegistry(readGenerationTaskRegistry().filter(t => !removeSet.has(t.taskId)));
    }
  };

  const cancelRowGeneration = (id) => {
    if (!confirm(`确定清空第 ${id} 行当前等待中的生成任务吗？清空后仍可继续点击生成。`)) return;
    resetRowGenerationState(id, true);
  };

  const handleGenerate = async (id, options = {}) => {
    const silent = !!options.silent;
    setSegments(prev => prev.map(seg => seg.id === id ? {
      ...seg,
      generating: true,
      generateStatus: 'pending',
      generationError: '',
      activeTaskCount: Math.max(1, (seg.activeTaskCount || 0) + 1),
    } : seg));

    if (generateChannel === 'pixmax') {
      return handleGeneratePixmax(id, options);
    }
    if (generateChannel === 'oiioii') {
      return handleGenerateOiiOii(id, options);
    }
    if (generateChannel === 'chatgpt2api') {
      return handleGenerateChatGPT2API(id, options);
    }
    if (generateChannel === 'dola') {
      return handleGenerateDola(id, options);
    }

    try {
      const accRes = await fetch(`${WIZSTAR_API}/accounts`);
      const accData = await accRes.json();
      const accounts = (accData.data || []).filter(a => a.status !== 'forbidden');
      const availableAccounts = accounts.filter(a => (a.active_task_count || 0) < (a.max_concurrency || 1));
      if (accounts.length === 0) {
        alert('没有可用的渠道一账号：账号库为空或账号都已被平台禁用，请注册/切换账号');
        resetRowGenerationState(id);
        return false;
      }
      if (availableAccounts.length === 0) {
        alert('渠道一账号并发已满：请等待当前任务完成，或在账号库选中账号后调高并发。');
        resetRowGenerationState(id);
        return false;
      }
      const eligibleAccounts = availableAccounts.filter(a => (a.points_balance || 0) > 0);
      const rotationPool = eligibleAccounts.length > 0 ? eligibleAccounts : availableAccounts;
      const cursor = wizstarAccountCursorRef.current % rotationPool.length;
      const account = rotationPool[cursor];
      wizstarAccountCursorRef.current = (cursor + 1) % rotationPool.length;

      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const prompt = promptText;
      const modelMap = { 'Seedance 2.0': 'seedance2.0', 'Seedance 1.5': 'seedance1.5', 'Kling': 'kling' };
      const ratioMap = { '16:9': '16:9', '9:16': '9:16', '1:1': '1:1' };
      const durationSec = resolveDurationSeconds(seg?.duration, globalDuration, 5);

      const picUrl = await resolveImageUrl(seg, id, account, promptText);

      const taskType = picUrl ? 2 : 1;
      const body = {
        account_id: account.id,
        task_type: taskType,
        prompt,
        model: modelMap[seg?.model || globalModel] || 'seedance2.0',
        video_ratio: ratioMap[seg?.aspectRatio || globalAspectRatio] || '16:9',
        video_duration: durationSec,
        video_num: 1,
      };
      if (picUrl) {
        body.pic_url = picUrl;
      }

      const createRes = await fetch(`${WIZSTAR_API}/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try {
          const err = await createRes.json();
          errMsg = err.detail || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const taskId = taskData.data?.task_id;
      if (!taskId) throw new Error('渠道一未返回 task_id');
      registerGenerationTask(id, taskId, 'wizstar', 'video');

      // Save taskId to segment so it persists across project close/switch; global scheduler continues polling.
      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingChannel: 'wizstar',
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[wizstar] generate failed:', e);
      const msg = e.message || '';
      const friendlyMsg = msg.toLowerCase().includes('user forbidden')
        ? '当前渠道一账号已被平台禁用，已自动标记为不可用，请换账号后重试'
        : msg;
      if (!silent) alert(`生成失败: ${friendlyMsg}`);
      resetRowGenerationState(id);
      return false;
    }
  };

  const handleStartAllTasks = async () => {
    if (batchStarting) return;

    const targetMediaType = getModelMediaType(globalModel);
    const targetMediaLabel = targetMediaType === 'image' ? '生图' : '视频生成';
    const candidates = segments.filter(seg => {
      const promptText = (promptDraftsRef.current[seg.id] ?? seg.text ?? '').trim();
      return seg.type === targetMediaType && promptText && !hasActiveGenerationTask(seg);
    });

    if (candidates.length === 0) {
      alert(`没有可一键发送的${targetMediaLabel}任务：请先切换到${targetMediaType === 'image' ? '图片' : '视频'}行、填写分镜提示词，并确认没有正在生成/等待中的任务。`);
      return;
    }

    const skippedCount = segments.filter(seg => seg.type !== targetMediaType).length;
    const shouldStart = confirm(`将按当前通道「${getChannelLabel(generateChannel)}」顺序发送 ${candidates.length} 个${targetMediaLabel}任务${skippedCount > 0 ? `，自动跳过 ${skippedCount} 个非${targetMediaType === 'image' ? '图片' : '视频'}行` : ''}。是否继续？`);
    if (!shouldStart) return;

    setBatchStarting(true);
    try {
      const results = await Promise.all(candidates.map(seg => handleGenerate(seg.id, { silent: true })));
      const started = results.filter(Boolean).length;
      const failed = candidates.length - started;
      alert(`一键发送完成：已并行提交 ${started} 个${targetMediaLabel}任务${failed > 0 ? `，失败 ${failed} 个` : ''}。`);
    } finally {
      setBatchStarting(false);
    }
  };

  const getChannelLabel = (channel) => ({
    wizstar: '渠道一账号池',
    pixmax: '渠道二',
    oiioii: '渠道四',
    chatgpt2api: '渠道五',
    dola: '渠道六 Dola',
  }[channel] || '当前通道');

  const handleGenerateDola = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      if (seg?.type === 'image') {
        alert('渠道六 Dola 是视频生成通道，请先切换该分镜为「视频」。');
        resetRowGenerationState(id);
        return false;
      }

      const dolaModelMap = {
        '渠道六 Seedance 2.0': 'seedance-2.0',
        '渠道六 Seedance 1.5': 'seedance-1.5',
        '渠道六 Seedance Lite': 'seedance-lite',
      };
      const selectedModelName = dolaModelMap[seg?.model] ? seg.model : (dolaModelMap[globalModel] ? globalModel : '渠道六 Seedance 2.0');
      const model = dolaModelMap[selectedModelName] || 'seedance-2.0';
      const ratio = ['16:9', '9:16', '1:1'].includes(seg?.aspectRatio || globalAspectRatio)
        ? (seg?.aspectRatio || globalAspectRatio)
        : '16:9';
      const durationSec = resolveDurationSeconds(seg?.duration, globalDuration, 5);

      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const referenceImages = [
        ...getSegmentCharacterImageRefs(seg, promptText),
        ...getSegmentSceneImageRefs(promptText),
      ].map(imageRefToReference).filter(Boolean);

      const body = {
        prompt: promptText,
        model,
        ratio,
        duration: durationSec,
        reference_images: referenceImages,
      };
      if (localImagePath) body.image_path = localImagePath;
      if (remoteImageUrl) body.image_url = remoteImageUrl;

      const createRes = await fetch(`${WIZSTAR_API}/dola/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const payload = taskData.data || {};
      const taskId = payload.task_id;
      if (!taskId) throw new Error('渠道六未返回 task_id');
      const accountId = payload.account_id || 0;
      const accountName = payload.account_name || (accountId ? `Dola账号 #${accountId}` : '');
      registerGenerationTask(id, taskId, 'dola', 'video', {
        accountId,
        accountName,
        conversationId: payload.conversation_id || '',
        status: payload.status || 'processing',
        progress: typeof payload.progress === 'number' ? payload.progress : 0,
      });

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        type: 'video',
        model: selectedModelName,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingChannel: 'dola',
        pendingAccountId: accountId,
        pendingAccountName: accountName,
        pendingConversationId: payload.conversation_id || '',
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[dola] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      resetRowGenerationState(id);
      return false;
    }
  };

  const handleOpenDolaAccountBrowser = async (row) => {
    const accountId = row?.pendingAccountId || 0;
    if (!accountId) {
      alert('这个渠道六任务还没有拿到账号信息，请等状态刷新后再点。');
      return;
    }
    const taskId = row?.pendingTaskId || (row?.pendingTaskIds || [])[0] || row?.lastFailedTaskId || '';
    const conversationId = row?.pendingConversationId || row?.lastConversationId || '';
    try {
      const res = await fetch(`${WIZSTAR_API}/dola/accounts/${accountId}/open-browser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, conversation_id: conversationId }),
      });
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try { const err = await res.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }
    } catch (e) {
      alert(`打开渠道六账号浏览器失败: ${e.message || e}`);
    }
  };

  const handleCollectDolaTask = async (row) => {
    const taskId = row?.pendingTaskId || (row?.pendingTaskIds || [])[0] || row?.lastFailedTaskId;
    const conversationId = row?.pendingConversationId || row?.lastConversationId || '';
    if (!taskId && !conversationId) {
      alert('该行没有可采集的渠道六任务。');
      return;
    }
    if (!conversationId) {
      alert('这个任务还没有拿到 conversation_id，无法直接采集。请先打开对应渠道六账号浏览器，确认 Dola 页面里该任务是否还在生成或已有结果。');
      if (row?.pendingAccountId) handleOpenDolaAccountBrowser(row);
      return;
    }
    try {
      setSegments(prev => prev.map(seg => seg.id === row.id ? {
        ...seg,
        generating: true,
        generateStatus: 'collecting',
        generationError: '',
        pendingConversationId: conversationId,
      } : seg));
      const url = taskId
        ? `${WIZSTAR_API}/dola/tasks/${encodeURIComponent(taskId)}/collect`
        : `${WIZSTAR_API}/dola/tasks/collect`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          account_id: row.pendingAccountId || 0,
        }),
      });
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try { const err = await res.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }
      const data = await res.json();
      const payload = data.data || {};
      registerGenerationTask(row.id, payload.task_id || taskId, 'dola', 'video', {
        accountId: row.pendingAccountId || payload.account_id || 0,
        accountName: row.pendingAccountName || payload.account_name || '',
        conversationId,
        status: payload.status || 'collecting',
        progress: typeof payload.progress === 'number' ? payload.progress : 20,
      });
    } catch (e) {
      setSegments(prev => prev.map(seg => seg.id === row.id ? {
        ...seg,
        generating: false,
        generationError: e.message || String(e),
      } : seg));
      alert(`手动采集失败: ${e.message || e}`);
    }
  };

  const handleGeneratePixmax = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const roleImageRefs = getSegmentCharacterImageRefs(seg, promptText);
      const roleAliases = getSegmentCharacterAliases(seg, promptText);
      const sceneImageRefs = getSegmentSceneImageRefs(promptText);

      if (!localImagePath && !remoteImageUrl && roleImageRefs.length === 0 && sceneImageRefs.length === 0) {
        alert('渠道二为图生视频通道，必须提供至少 1 张输入图片。请为该分镜设置「垫图」，或在描述词中插入带图片的 @角色 / $场景。');
        resetRowGenerationState(id);
        return false;
      }

      const pixmaxModelMap = {
        '渠道二 标准': 'pixdance-2-fast',
        '渠道二 高质量': 'pixdance-2',
      };
      const model = pixmaxModelMap[seg?.model || globalModel] || 'pixdance-2-fast';

      const durationSec = resolveDurationSeconds(seg?.duration, globalDuration, 5);
      const aspectRatio = ['16:9', '9:16', '1:1'].includes(seg?.aspectRatio || globalAspectRatio)
        ? (seg?.aspectRatio || globalAspectRatio) : '16:9';

      const body = {
        prompt: promptText,
        model,
        duration: durationSec,
        aspect_ratio: aspectRatio,
      };

      const imageInputs = [];
      if (localImagePath) {
        imageInputs.push({ file_path: localImagePath });
      } else if (remoteImageUrl) {
        imageInputs.push({ url: remoteImageUrl });
      }
      [...roleImageRefs, ...sceneImageRefs].forEach(ref => {
        const input = imageRefToInput(ref);
        if (input) imageInputs.push(input);
      });
      if (imageInputs.length > 0) {
        body.image_inputs = imageInputs;
      }
      const canAttachAliases = roleAliases.length > 0 && imageInputs.length === roleAliases.length;
      if (canAttachAliases) {
        body.aliases = roleAliases;
      }

      const createRes = await fetch(`${WIZSTAR_API}/pixmax/tasks/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const taskId = taskData.data?.task_id;
      if (!taskId) throw new Error('渠道二未返回 task_id');
      registerGenerationTask(id, taskId, 'pixmax', 'video');

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingChannel: 'pixmax',
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[pixmax] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      resetRowGenerationState(id);
      return false;
    }
  };

  const handleGenerateChatGPT2API = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const isImageRow = seg?.type === 'image';
      if (!isImageRow) {
        alert('渠道五 GPT-Image2 是生图通道，请先切换该分镜为「图片」。');
        resetRowGenerationState(id);
        return false;
      }

      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const currentImageUrl = seg?.currentMaterialImage && !isVideoUrl(seg.currentMaterialImage.thumbnail)
        ? (seg.currentMaterialImage.sourceUrl || seg.currentMaterialImage.remoteUrl || seg.currentMaterialImage.thumbnail || '')
        : '';
      const referenceImageUrl = remoteImageUrl || (/^https?:\/\//i.test(currentImageUrl) ? currentImageUrl : '');
      const aspectRatio = ['16:9', '9:16', '1:1', '4:3', '3:4'].includes(seg?.aspectRatio || globalAspectRatio)
        ? (seg?.aspectRatio || globalAspectRatio)
        : '16:9';
      const chatgpt2apiSizeMap = {
        '1:1': '1024x1024',
        '16:9': '1536x1024',
        '4:3': '1536x1024',
        '9:16': '1024x1536',
        '3:4': '1024x1536',
      };
      const imageSize = chatgpt2apiSizeMap[aspectRatio] || 'auto';

      const imageResolution = ['2K', '4K'].includes(seg?.quality || globalResolution)
        ? (seg?.quality || globalResolution)
        : '2K';

      const body = {
        prompt: promptText,
        model: 'gpt-image-2',
        size: imageSize,
        resolution: imageResolution,
      };
      if (localImagePath) body.image_path = localImagePath;
      if (referenceImageUrl) body.image_url = referenceImageUrl;
      const referenceImages = [
        ...getSegmentCharacterImageRefs(seg, promptText),
        ...getSegmentSceneImageRefs(promptText),
      ].map(imageRefToReference).filter(Boolean);
      if (referenceImages.length > 0) body.reference_images = referenceImages;

      const createRes = await fetch(`${WIZSTAR_API}/chatgpt2api/images/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const taskId = taskData.data?.task_id;
      if (!taskId) throw new Error('渠道五未返回 task_id');
      registerGenerationTask(id, taskId, 'chatgpt2api', 'image');

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingChannel: 'chatgpt2api',
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[chatgpt2api] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      resetRowGenerationState(id);
      return false;
    }
  };

  const handleGenerateOiiOii = async (id, options = {}) => {
    const silent = !!options.silent;
    try {
      const seg = segments.find(s => s.id === id);
      const promptText = buildPromptWithSuffix(promptDraftsRef.current[id] ?? seg?.text);

      if (!promptText || promptText.trim().length === 0) {
        alert('请先填写该分镜的描述词再生成');
        resetRowGenerationState(id);
        return false;
      }

      const isImageRow = seg?.type === 'image';
      const localImagePath = getReferenceLocalPath(seg);
      const remoteImageUrl = getReferenceRemoteUrl(seg);
      const currentImageUrl = '';
      const referenceImageUrl = remoteImageUrl || (/^https?:\/\//i.test(currentImageUrl) ? currentImageUrl : '');

      const oiiVideoModelMap = {
        '渠道四 Gemini': 'gemini',
        '渠道四 Grok': 'grok',
      };
      const oiiImageModelMap = {
        '渠道四 GPT-Image2': 'gpt-image2',
        '渠道四 Nano Pro': 'nano-pro',
        '渠道四 Nano 2': 'nano2',
        '渠道四 Seedream 5.0': 'seedream5',
        '渠道四 Seedream 4.5': 'seedream45',
        '渠道四 Midjourney niji7': 'midjourney-niji7',
        '渠道四 Midjourney niji6': 'midjourney-niji6',
        '渠道四 NovelAI': 'novelai',
        '渠道四 GPT-4o': 'gpt4o',
      };
      const modelMap = isImageRow ? oiiImageModelMap : oiiVideoModelMap;
      const fallbackModelName = isImageRow ? '渠道四 GPT-Image2' : '渠道四 Gemini';
      const selectedModelName = modelMap[globalModel]
        ? globalModel
        : (modelMap[seg?.model] ? seg.model : fallbackModelName);
      const model = modelMap[selectedModelName] || modelMap[fallbackModelName];

      const durationSec = resolveDurationSeconds(seg?.duration, globalDuration, 10);
      const aspectRatio = ['16:9', '9:16', '1:1'].includes(seg?.aspectRatio || globalAspectRatio)
        ? (seg?.aspectRatio || globalAspectRatio) : '16:9';

      const imageResolution = ['2K', '4K'].includes(seg?.quality || globalResolution)
        ? (seg?.quality || globalResolution)
        : '2K';

      const oiiPromptText = convertSceneMentionsForOiiOii(promptText);
      const body = {
        prompt: oiiPromptText,
        model,
        aspect_ratio: aspectRatio,
        resolution: isImageRow ? imageResolution : '720p',
      };

      if (!isImageRow) {
        body.duration = durationSec;
      }

      const isGptImage2OiiImage = isImageRow && model === 'gpt-image2';
      if (!isGptImage2OiiImage && localImagePath) {
        body.image_path = localImagePath;
      }
      if (!isGptImage2OiiImage && referenceImageUrl) {
        body.image_url = referenceImageUrl;
      }

      const roleImageRefs = getSegmentCharacterImageRefs(seg, promptText);
      const sceneImageRefs = getSegmentSceneImageRefs(promptText);
      const referenceImages = [];
      [...roleImageRefs, ...sceneImageRefs].forEach(ref => {
        const imageRef = imageRefToReference(ref);
        if (imageRef) referenceImages.push(imageRef);
      });
      if (referenceImages.length > 0) {
        body.reference_images = referenceImages;
      }

      if (!isGptImage2OiiImage && isImageRow && (localImagePath || referenceImageUrl || referenceImages.length > 0)) {
        body.image_to_image = true;
      }

      const createRes = await fetch(`${WIZSTAR_API}${isImageRow ? '/oiioii/images/create' : '/oiioii/tasks/create'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!createRes.ok) {
        let errMsg = `HTTP ${createRes.status}`;
        try { const err = await createRes.json(); errMsg = err.detail || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const taskData = await createRes.json();
      const taskId = taskData.data?.task_id;
      if (!taskId) throw new Error('渠道四未返回 task_id');
      registerGenerationTask(id, taskId, 'oiioii', isImageRow ? 'image' : 'video');

      setSegments(prev => prev.map(s => s.id === id ? {
        ...s,
        pendingTaskId: taskId,
        pendingTaskIds: [...new Set([...(s.pendingTaskIds || []), taskId])],
        pendingChannel: 'oiioii',
        generating: true,
        generateStatus: 'processing',
        activeTaskCount: Math.max(1, [...new Set([...(s.pendingTaskIds || []), taskId])].length),
      } : s));
      return true;
    } catch (e) {
      console.error('[oiioii] generate failed:', e);
      if (!silent) alert(`生成失败: ${e.message || e}`);
      resetRowGenerationState(id);
      return false;
    }
  };

  // Toggle active/play state of current material in a row
  const togglePlayCurrent = (id) => {
    setSegments(prev => prev.map(seg => {
      if (seg.id === id && seg.type === 'video') {
        return {
          ...seg,
          currentMaterialVideo: {
            ...seg.currentMaterialVideo,
            isPlaying: !seg.currentMaterialVideo.isPlaying
          }
        };
      }
      return seg;
    }));
  };

  // Toggle lock state of current material in a row
  const toggleLockRowMaterial = (id) => {
    setSegments(prev => prev.map(seg => {
      if (seg.id === id) {
        return {
          ...seg,
          isLocked: !seg.isLocked
        };
      }
      return seg;
    }));
  };

  // Select material from candidates list for specific row
  const handleSelectCandidateMaterial = (rowId, material) => {
    const row = segments.find(s => s.id === rowId);
    if (row && row.isLocked) {
      alert(`第 ${rowId} 行的画面已被锁定，请先解锁当前素材！`);
      return;
    }

    setSegments(prev => prev.map(seg => {
      if (seg.id === rowId) {
        if (seg.type === 'video') {
          return {
            ...seg,
            currentMaterialVideo: {
              id: material.id,
              name: `${material.name} - 备份`,
              thumbnail: material.thumbnail.replace('&w=120', '&w=500'),
              sourceUrl: material.sourceUrl || material.thumbnail,
              mediaType: material.mediaType || (isVideoUrl(material.thumbnail) ? 'video' : 'image'),
              isPlaying: false,
              fps: 25,
              duration: material.duration || (material.mediaType === 'video' || isVideoUrl(material.thumbnail) ? '00:05' : '00:04')
            }
          };
        } else {
          return {
            ...seg,
            currentMaterialImage: {
              id: material.id,
              name: `${material.name} - 原画`,
              thumbnail: material.thumbnail.replace('&w=120', '&w=500'),
              sourceUrl: material.sourceUrl || material.thumbnail,
              mediaType: material.mediaType || (isVideoUrl(material.thumbnail) ? 'video' : 'image'),
              fps: null,
              duration: material.mediaType === 'video' || isVideoUrl(material.thumbnail) ? '00:05' : '静态图片'
            }
          };
        }
      }
      return seg;
    }));
  };

  const handleRenameCurrentMaterial = (rowId) => {
    const row = segments.find(s => s.id === rowId);
    if (!row) return;
    const isVid = row.type === 'video';
    const current = isVid ? row.currentMaterialVideo : row.currentMaterialImage;
    if (!current || !current.id) {
      alert('当前没有可重命名的素材。');
      return;
    }

    const nextName = prompt('请输入新的素材名称：', current.name || '');
    if (!nextName || !nextName.trim()) return;
    const cleanName = nextName.trim();

    setSegments(prev => prev.map(seg => {
      if (seg.id !== rowId) return seg;
      if (isVid) {
        return {
          ...seg,
          currentMaterialVideo: { ...seg.currentMaterialVideo, name: cleanName },
          materialsVideo: (seg.materialsVideo || []).map(mat => mat.id === current.id ? { ...mat, name: cleanName } : mat),
        };
      }
      return {
        ...seg,
        currentMaterialImage: { ...seg.currentMaterialImage, name: cleanName },
        materialsImage: (seg.materialsImage || []).map(mat => mat.id === current.id ? { ...mat, name: cleanName } : mat),
      };
    }));
  };

  // Clear current active preview frame
  const handleClearCurrent = (id) => {
    if (confirm('确定要清除这行分镜的当前预览画面吗？')) {
      setSegments(prev => prev.map(seg => {
        if (seg.id === id) {
          const isVid = seg.type === 'video';
          const emptyMat = {
            id: 0,
            name: '暂无画面',
            thumbnail: '',
            mediaType: isVid ? 'video' : 'image',
            isPlaying: false,
            fps: null,
            duration: null
          };
          return isVid 
            ? { ...seg, currentMaterialVideo: emptyMat }
            : { ...seg, currentMaterialImage: emptyMat };
        }
        return seg;
      }));
    }
  };

  // Delete a specific candidate material frame
  const handleDeleteCandidate = (rowId, materialId) => {
    if (confirm('确定要删除这个备选帧吗？')) {
      setSegments(prev => prev.map(seg => {
        if (seg.id === rowId) {
          const isVid = seg.type === 'video';
          if (isVid) {
            const updatedMaterials = seg.materialsVideo.filter(m => m.id !== materialId);
            const currentSelected = seg.currentMaterialVideo;
            const isDeletingSelected = currentSelected.id === materialId;
            const fallbackMat = updatedMaterials[0] || { id: 0, name: '暂无画面', thumbnail: '', mediaType: 'video' };
            
            return {
              ...seg,
              materialsVideo: updatedMaterials,
              currentMaterialVideo: isDeletingSelected ? {
                id: fallbackMat.id,
                name: fallbackMat.name,
                thumbnail: fallbackMat.thumbnail ? fallbackMat.thumbnail.replace('&w=120', '&w=500') : '',
                sourceUrl: fallbackMat.sourceUrl || fallbackMat.thumbnail || '',
                mediaType: fallbackMat.mediaType || (isVideoUrl(fallbackMat.thumbnail) ? 'video' : 'image'),
                isPlaying: false,
                fps: 25,
                duration: fallbackMat.duration || (fallbackMat.mediaType === 'video' || isVideoUrl(fallbackMat.thumbnail) ? '00:05' : '00:04')
              } : currentSelected
            };
          } else {
            const updatedMaterials = seg.materialsImage.filter(m => m.id !== materialId);
            const currentSelected = seg.currentMaterialImage;
            const isDeletingSelected = currentSelected.id === materialId;
            const fallbackMat = updatedMaterials[0] || { id: 0, name: '暂无画面', thumbnail: '', mediaType: 'image' };

            return {
              ...seg,
              materialsImage: updatedMaterials,
              currentMaterialImage: isDeletingSelected ? {
                id: fallbackMat.id,
                name: fallbackMat.name,
                thumbnail: fallbackMat.thumbnail ? fallbackMat.thumbnail.replace('&w=120', '&w=500') : '',
                sourceUrl: fallbackMat.sourceUrl || fallbackMat.thumbnail || '',
                mediaType: fallbackMat.mediaType || (isVideoUrl(fallbackMat.thumbnail) ? 'video' : 'image'),
                fps: null,
                duration: fallbackMat.mediaType === 'video' || isVideoUrl(fallbackMat.thumbnail) ? '00:05' : '静态图片'
              } : currentSelected
            };
          }
        }
        return seg;
      }));
    }
  };

  // Update prompt text inside a row
  const commitPromptDraft = (id, text = promptDraftsRef.current[id]) => {
    if (typeof text !== 'string') return;
    setSegments(prev => prev.map(seg => seg.id === id && seg.text !== text ? { ...seg, text } : seg));
  };

  const startEditingPrompt = (row) => {
    promptDraftsRef.current[row.id] = row.text || '';
    setEditingRowId(row.id);
    resizePromptTextareaById(row.id);
  };

  const resetAtState = () => {
    setAtState({
      rowId: null,
      isOpen: false,
      trigger: '@',
      query: '',
      cursorPos: 0,
    });
  };

  // Resolve the asset list backing a given trigger symbol
  const getAssetsForTrigger = (trigger) => {
    const type = TRIGGERS[trigger]?.type;
    if (type === 'scene') return sceneAssets;
    if (type === 'item') return itemAssets;
    return characterAssets;
  };

  // Handle live textarea change with '@' / '$' / '#' autocomplete detection
  const handleTextareaChange = (rowId, text, e) => {
    promptDraftsRef.current[rowId] = text;
    resizePromptTextarea(e.target);

    const selectionStart = e.target.selectionStart;
    const textBeforeCursor = text.substring(0, selectionStart);

    // 找到光标前最近的一个触发符（@ / $ / #）
    let trigger = null;
    let triggerIdx = -1;
    Object.keys(TRIGGERS).forEach((sym) => {
      const idx = textBeforeCursor.lastIndexOf(sym);
      if (idx > triggerIdx) {
        triggerIdx = idx;
        trigger = sym;
      }
    });

    if (trigger && triggerIdx !== -1) {
      const query = textBeforeCursor.substring(triggerIdx + 1);
      if (!query.includes(' ') && query.length < 15) {
        setAtState({
          rowId,
          isOpen: true,
          trigger,
          query,
          cursorPos: selectionStart,
        });

        const matches = getAssetsForTrigger(trigger).filter(asset =>
          asset.name.toLowerCase().includes(query.toLowerCase())
        );
        if (matches.length > 0) {
          setHoveredCharId(matches[0].id);
        }
        return;
      }
    }

    setAtState({
      rowId: null,
      isOpen: false,
      trigger: '@',
      query: '',
      cursorPos: 0,
    });
  };

  // Complete asset selection from dropdown and auto-populate row tags
  const handleSelectCharacterFromDropdown = (rowId, assetName, trigger = '@') => {
    setSegments(prev => prev.map(seg => {
      if (seg.id === rowId) {
        const text = promptDraftsRef.current[rowId] ?? seg.text;
        const cursorPos = atState.cursorPos;
        const textBeforeCursor = text.substring(0, cursorPos);
        const textAfterCursor = text.substring(cursorPos);
        const triggerIdx = textBeforeCursor.lastIndexOf(trigger);

        if (triggerIdx !== -1) {
          // Replace "<trigger>query" with "（<trigger>${assetName}）"
          const newTextBefore = textBeforeCursor.substring(0, triggerIdx) + `（${trigger}${assetName}）`;
          const newText = newTextBefore + textAfterCursor;
          promptDraftsRef.current[rowId] = newText;
          const textarea = promptTextareaRefs.current[rowId];
          if (textarea) {
            textarea.value = newText;
            resizePromptTextarea(textarea);
            requestAnimationFrame(() => {
              try { textarea.setSelectionRange(newTextBefore.length, newTextBefore.length); } catch (_) {}
            });
          }

          // 角色才维护 associatedCharacters（场景/物品仅做文本标签）
          if (trigger === '@') {
            const fullChar = characterAssets.find(c => c.name === assetName);
            return {
              ...seg,
              text: newText,
              associatedCharacters: seg.associatedCharacters.some(c => c.name === assetName)
                ? seg.associatedCharacters
                : [
                    ...seg.associatedCharacters,
                    {
                      name: assetName,
                      avatar: fullChar ? fullChar.avatar : 'https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=80',
                      avatarPath: fullChar?.avatarPath || '',
                      role: fullChar?.role || '',
                      val: 1
                    }
                  ]
            };
          }

          return { ...seg, text: newText };
        }
      }
      return seg;
    }));

    // Close autocomplete dropdown
    setAtState({
      rowId: null,
      isOpen: false,
      trigger: '@',
      query: '',
      cursorPos: 0,
    });
  };

  // Backspace deletes a whole （@角色）/（$场景）/（#物品）token as if it were a chip
  const handleTextareaKeyDown = (rowId, e) => {
    if (e.key !== 'Backspace') return;
    const el = e.target;
    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    if (selStart !== selEnd || selStart === 0) return; // only when nothing selected and caret not at start

    const text = el.value;
    const before = text.substring(0, selStart);
    // 光标前是否紧贴一个 token 结尾的右括号
    const m = before.match(/[（(]([@$#])([^）)]+)[）)]$/);
    if (!m) return; // 普通字符，走默认删除

    e.preventDefault();
    const tokenStart = selStart - m[0].length;
    const newText = text.substring(0, tokenStart) + text.substring(selStart);
    const removedTrigger = m[1];
    const removedName = m[2];

    promptDraftsRef.current[rowId] = newText;
    setSegments(prev => prev.map(seg => {
      if (seg.id !== rowId) return seg;
      const next = { ...seg, text: newText };
      // 删的是角色 token，且文本里不再出现该角色，则同步移除关联
      if (removedTrigger === '@' && Array.isArray(seg.associatedCharacters)) {
        const stillReferenced = newText.includes(`（@${removedName}）`) || newText.includes(`(@${removedName})`);
        if (!stillReferenced) {
          next.associatedCharacters = seg.associatedCharacters.filter(c => c.name !== removedName);
        }
      }
      return next;
    }));

    // 还原光标到 token 起点
    requestAnimationFrame(() => {
      try { el.setSelectionRange(tokenStart, tokenStart); } catch (_) {}
    });
  };

  // Add new row/segment
  const handleAddNewSegmentRow = () => {
    const newId = segments.length > 0 ? Math.max(...segments.map(s => s.id)) + 1 : 1;
    setSegments([...segments, createSegmentRow(newId)]);
  };

  // Delete a row/segment
  const handleDeleteSegmentRow = (id, e) => {
    e.stopPropagation();
    if (segments.length <= 1) {
      alert('至少需要保留一行分镜进行视频生成！');
      return;
    }
    if (confirm(`确定删除第 ${id} 行分镜及所有对应素材吗？`)) {
      setSegments(segments.filter(s => s.id !== id));
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/20">
      {showBatchPromptModal && (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-2xl bg-[#1a1b1f] border border-dark-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-dark-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-extrabold text-white">批量添加提示词</h3>
                <p className="text-[10px] text-dark-muted mt-1">支持分镜长提示词：按“1.## 标题 - [镜头1 / 15.0s]”或“## 标题 - [镜头1 / 15.0s]”切分；时间轴 0.0s-1.8s 不会被拆开。</p>
              </div>
              <button
                type="button"
                onClick={() => setShowBatchPromptModal(false)}
                className="p-1.5 rounded-lg text-dark-muted hover:text-white hover:bg-dark-card transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setBatchPromptMode('replace')}
                  className={`px-3 py-1.5 rounded-lg border font-bold transition-all ${batchPromptMode === 'replace' ? 'bg-brand text-black border-brand' : 'bg-dark-input border-dark-border text-dark-muted hover:text-white'}`}
                >
                  覆盖对应行
                </button>
                <button
                  type="button"
                  onClick={() => setBatchPromptMode('append')}
                  className={`px-3 py-1.5 rounded-lg border font-bold transition-all ${batchPromptMode === 'append' ? 'bg-brand text-black border-brand' : 'bg-dark-input border-dark-border text-dark-muted hover:text-white'}`}
                >
                  追加到对应行
                </button>
                <span className="text-[10px] text-dark-subtle ml-auto">当前 {segments.length} 行</span>
              </div>

              <textarea
                value={batchPromptText}
                onChange={(e) => setBatchPromptText(e.target.value)}
                placeholder={'示例：\n1.## 海城大学咖啡厅 - [镜头1 / 15.0s]\n**【第一部分：视觉与技术参数设定】**\n0.0s-1.8s：\n运镜：中景平视 + 手持呼吸感镜头。\n\n===\n\n2.## 海城大学咖啡厅 - [镜头2 / 15.0s]\n**【第一部分：视觉与技术参数设定】**\n0.0s-2.0s：\n画面：继续下一段分镜。'}
                className="w-full h-72 bg-dark-bg border border-dark-border rounded-xl p-3 text-xs text-white placeholder:text-dark-subtle focus:outline-none focus:border-brand/60 resize-none leading-relaxed"
              />

              <div className="flex items-center justify-between gap-3 pt-2">
                <span className="text-[10px] text-dark-muted">
                  已识别 {parseBatchPromptBlocks(batchPromptText).length} 条提示词
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowBatchPromptModal(false)}
                    className="px-4 py-2 rounded-lg bg-dark-input border border-dark-border text-dark-muted hover:text-white hover:border-dark-subtle text-xs font-bold transition-all"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={applyBatchPrompts}
                    className="px-5 py-2 rounded-lg bg-brand hover:bg-brand-dark text-black text-xs font-extrabold transition-all"
                  >
                    应用到分镜
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* 1. Page Header (Sub indicator) */}
      <div className="h-11 border-b border-dark-border px-6 flex items-center justify-between shrink-0 bg-dark-bg/60">
        <div className="flex items-center space-x-3.5">
          {onBack && (
            <button 
              type="button"
              onClick={onBack}
              className="flex items-center space-x-1.5 px-2.5 py-1 border border-dark-border hover:border-brand/40 bg-dark-card hover:bg-dark-cardHover text-[10px] font-bold text-dark-muted hover:text-white rounded-lg transition-all"
            >
              <span>◀ 返回项目列表</span>
            </button>
          )}
          <span className="text-xs text-dark-subtle">|</span>
          <span className="text-xs text-dark-muted">正在编辑项目:</span>
          <span className="text-xs font-bold text-brand">{activeDraft?.title || '5月2日项目'}</span>
          <span className="text-[10px] bg-dark-border/60 text-dark-muted border border-dark-border px-2 py-0.5 rounded-full">
            共 {segments.length} 个分镜行
          </span>
        </div>
        <div className="flex items-center space-x-3 text-[11px] text-dark-muted">
          <span>{getModelMediaType(globalModel) === 'image' ? `图片分辨率: ${globalResolution}` : `视频参数: ${globalAspectRatio} · ${globalDuration}`}</span>
          <span>GPU渲染加速: 开启</span>
          <button 
            type="button"
            onClick={handleStartAllTasks}
            disabled={batchStarting}
            className={`flex items-center space-x-1 px-3 py-1 rounded font-extrabold text-[10px] transition-all ${batchStarting ? 'bg-dark-input border border-dark-border text-dark-subtle cursor-not-allowed' : 'bg-brand hover:bg-brand-dark border border-brand text-black shadow-[0_0_14px_rgba(16,185,129,0.25)]'}`}
            title={getModelMediaType(globalModel) === 'image' ? '一键发送所有已填写提示词、且未在生成中的图片分镜生图任务' : '一键发送所有已填写提示词、且未在生成中的视频分镜任务'}
          >
            {batchStarting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            <span>{batchStarting ? '任务发送中' : (getModelMediaType(globalModel) === 'image' ? '一键发送生图' : '一键发送任务')}</span>
          </button>
          <button 
            type="button"
            onClick={openBatchPromptModal}
            className="flex items-center space-x-1 px-2.5 py-1 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/40 hover:border-blue-500 rounded text-blue-300 font-bold text-[10px] transition-all"
          >
            <Layers className="w-3 h-3" />
            <span>批量提示词</span>
          </button>
          <button 
            onClick={handleRunBatchReferenceImage}
            className="flex items-center space-x-1 px-2.5 py-1 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/40 hover:border-purple-500 rounded text-purple-400 font-bold text-[10px] transition-all"
          >
            <FileImage className="w-3 h-3" />
            <span>批量加垫图</span>
          </button>
          <button 
            onClick={handleAddNewSegmentRow}
            className="flex items-center space-x-1 px-2.5 py-1 bg-brand/10 hover:bg-brand/20 border border-brand/40 hover:border-brand rounded text-brand font-bold text-[10px] transition-all"
          >
            <Plus className="w-3 h-3" />
            <span>新增分镜行</span>
          </button>
        </div>
      </div>

      {/* Global Top Control Deck matching Second Screenshot */}
      <div className="bg-dark-sidebar/25 border-b border-dark-border px-6 py-3.5 grid grid-cols-3 gap-4.5 shrink-0 select-none text-xs">
        
        {/* PANEL 1: 全局配置 */}
        <div className="bg-dark-card/45 border border-dark-border p-3 rounded-xl flex flex-col justify-between relative">
          <div className="flex justify-between items-center text-[10px] text-dark-muted font-bold tracking-wider uppercase mb-1.5 shrink-0">
            <span>全局配置</span>
            <div className="flex items-center gap-1.5 normal-case">
              <span className="text-[8px] text-dark-subtle">通道</span>
              <div className="flex bg-dark-input border border-dark-border rounded-md overflow-hidden">
                <button
                  type="button"
                  onClick={() => selectGenerationModel('Seedance 2.0', 'wizstar')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'wizstar' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道一账号池通道"
                >账号池</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道二 标准', 'pixmax')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'pixmax' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道二（Pixmax · 图生视频）"
                >渠道二</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道四 Gemini', 'oiioii')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'oiioii' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道四（OiiOii · 多模型视频生成）"
                >渠道四</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道五 GPT-Image2', 'chatgpt2api')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'chatgpt2api' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道五（ChatGPT2API · GPT-Image2 生图）"
                >渠道五</button>
                <button
                  type="button"
                  onClick={() => selectGenerationModel('渠道六 Seedance 2.0', 'dola')}
                  className={`px-1.5 py-0.5 text-[8px] font-bold transition-all ${generateChannel === 'dola' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                  title="渠道六（Dola · Seedance 视频生成）"
                >渠道六</button>
              </div>
            </div>
          </div>
          {generateChannel === 'pixmax' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-[8px] text-amber-300 leading-snug">
              渠道二图生视频：需先在「设置 → 渠道二」配置 API Key，并为分镜设置「垫图」（图片 URL 或本地文件）。
            </div>
          )}
          {generateChannel === 'oiioii' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/30 text-[8px] text-purple-300 leading-snug">
              渠道四多模型视频：需先在「设置 → 渠道四」配置代理并注册账号。支持 Gemini、Seedance、Sora2 等模型，可带参考图。
            </div>
          )}
          {generateChannel === 'chatgpt2api' && (
            <div className="mb-1.5 px-2 py-1 rounded-md bg-sky-500/10 border border-sky-500/30 text-[8px] text-sky-300 leading-snug">
              渠道五 GPT-Image2 生图：需先在「设置 → 渠道五」配置 API Key。支持文生图，也可用垫图做图生图。
            </div>
          )}
          <div className="grid grid-cols-4 gap-1.5 flex-1 items-stretch">
            {/* Tile 1: 选择模型 dropdown trigger */}
            <div 
              onClick={() => setActivePopover(activePopover === 'model' ? null : 'model')}
              className={`bg-dark-input hover:bg-dark-bg border p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all ${
                activePopover === 'model' ? 'border-brand shadow-[0_0_8px_rgba(16,185,129,0.25)]' : 'border-dark-border hover:border-brand/40'
              }`}
            >
              <span className="text-[10px] font-bold text-brand leading-none mb-1 block">{getModelLabel(globalModel)}</span>
              <span className="text-[8px] text-white truncate max-w-full block scale-90">{globalModel}</span>
            </div>
            
            {/* Tile 2: 生成参数 */}
            <div 
              onClick={() => setActivePopover(activePopover === 'params' ? null : 'params')}
              className={`bg-dark-input hover:bg-dark-bg border p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all ${
                activePopover === 'params' ? 'border-brand shadow-[0_0_8px_rgba(16,185,129,0.25)]' : 'border-dark-border hover:border-brand/40'
              }`}
            >
              <span className="text-[9px] font-extrabold text-white leading-none block">{globalAspectRatio}</span>
              <span className="text-[8px] text-dark-muted mt-0.5 scale-90 block">{globalDuration}</span>
              <span className="text-[7px] text-dark-subtle block scale-75 mt-0.5">生成参数</span>
            </div>

            {/* Tile 3: 提示词后缀 */}
            <div 
              onClick={() => setActivePopover(activePopover === 'suffix' ? null : 'suffix')}
              className={`bg-dark-input hover:bg-dark-bg border p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all relative ${
                activePopover === 'suffix' ? 'border-brand shadow-[0_0_8px_rgba(16,185,129,0.25)]' : 'border-dark-border hover:border-brand/40'
              }`}
            >
              <span className="absolute -top-1 -right-1 text-[7px] bg-dark-border text-dark-muted px-1 rounded border border-white/5 scale-75">预设</span>
              <Sparkles className="w-3.5 h-3.5 mx-auto text-brand mb-0.5" />
              <span className="text-[8px] text-white truncate">{selectedPromptSuffix.name}</span>
            </div>

            {/* Tile 4: 添加音频 */}
            <div 
              onClick={() => alert('选择本地音频背景乐')}
              className="bg-dark-input hover:bg-dark-bg border border-dark-border hover:border-brand/40 p-1.5 rounded-lg text-center flex flex-col justify-center cursor-pointer transition-all relative"
            >
              <span className="absolute -top-1 -right-1 text-[7px] bg-dark-border text-dark-muted px-1 rounded border border-white/5 scale-75">未添加</span>
              <span className="text-[9px] font-bold text-dark-muted mb-0.5">🎵</span>
              <span className="text-[8px] text-dark-muted truncate">添加音频</span>
            </div>
          </div>

          {/* POPOVER 1: 选择模型 Modal matching Image 2 */}
          {activePopover === 'model' && (
            <div className="absolute top-[102%] left-0 w-[310px] bg-[#1a1b1f] border border-dark-border p-4 rounded-xl shadow-[0_12px_30px_rgba(0,0,0,0.6)] z-50 text-xs text-dark-text animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="flex justify-between items-center pb-2 border-b border-dark-border/40 mb-3.5">
                <span className="font-extrabold text-white text-[13px] tracking-wide">选择模型</span>
                <div className="flex space-x-2.5 text-dark-subtle">
                  <button onClick={() => alert('刷新模型列表中...')} className="hover:text-white text-sm" title="刷新">↻</button>
                  <button onClick={() => setActivePopover(null)} className="hover:text-white text-sm font-bold" title="关闭">✕</button>
                </div>
              </div>
              <div className="flex rounded-lg bg-dark-input border border-dark-border p-0.5 mb-3">
                <button
                  type="button"
                  onClick={() => setModelPopoverTab('video')}
                  className={`flex-1 py-1.5 rounded-md text-[10px] font-extrabold transition-all ${modelPopoverTab === 'video' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                >
                  视频模型
                </button>
                <button
                  type="button"
                  onClick={() => setModelPopoverTab('image')}
                  className={`flex-1 py-1.5 rounded-md text-[10px] font-extrabold transition-all ${modelPopoverTab === 'image' ? 'bg-brand text-black' : 'text-dark-muted hover:text-white'}`}
                >
                  图片模型
                </button>
              </div>
              
              <div className="space-y-4">
                {modelPopoverTab === 'video' && <>
                {/* Category 2: 视频模型 */}
                <div>
                  <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">视频模型</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {['Seedance 2.0', 'Seedance 1.5', 'Kling'].map(m => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => selectGenerationModel(m, 'wizstar')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === m 
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]' 
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <div className="absolute top-0.5 right-0.5 flex space-x-0.5 scale-75 origin-top-right text-dark-muted text-[6px]">
                          <span>￥</span>
                          <span>☁</span>
                        </div>
                        <span className="text-[9px] leading-tight mt-1.5 font-semibold text-center">{m}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category 2.5: 渠道二（Pixmax · 图生视频） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道二（图生视频）</p>
                    {generateChannel === 'pixmax' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { name: '渠道二 标准', desc: '账号池 · 图生视频', model: 'pixdance-2-fast' },
                      { name: '渠道二 高质量', desc: '高质量 · 图生视频', model: 'pixdance-2' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'pixmax')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-amber-400 text-[6px] font-bold">PX</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">{p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category 4: 渠道四（OiiOii · 视频模型） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道四（视频模型）</p>
                    {generateChannel === 'oiioii' && [
                      '渠道四 Gemini',
                      '渠道四 Grok',
                    ].includes(globalModel) && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { name: '渠道四 Gemini', desc: 'Gemini Omni' },
                      { name: '渠道四 Grok', desc: 'Grok Imagine' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'oiioii')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-purple-400 text-[6px] font-bold">OI</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name.replace('渠道四 ', '')}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">视频 · {p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category 6: 渠道六（Dola · 视频模型） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">
                      渠道六（Dola 视频）
                    </p>
                    {generateChannel === 'dola' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { name: '渠道六 Seedance 2.0', desc: '默认模型' },
                      { name: '渠道六 Seedance 1.5', desc: '兼容模型' },
                      { name: '渠道六 Seedance Lite', desc: '轻量模型' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'dola')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-orange-300 text-[6px] font-bold">D6</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name.replace('渠道六 ', '')}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">视频 · {p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
                </>}

                {modelPopoverTab === 'image' && <>
                {/* Category 5: ChatGPT2API · GPT-Image2 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道五（GPT-Image2 生图）</p>
                    {generateChannel === 'chatgpt2api' && globalModel === '渠道五 GPT-Image2' && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => selectGenerationModel('渠道五 GPT-Image2', 'chatgpt2api')}
                      className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                        globalModel === '渠道五 GPT-Image2'
                          ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                          : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                      }`}
                    >
                      <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-sky-300 text-[6px] font-bold">G2</span>
                      <span className="text-[9px] leading-tight font-semibold text-center">GPT-Image2</span>
                      <span className="text-[7px] text-dark-muted mt-0.5 scale-90">图片 · 文生图/图生图</span>
                    </button>
                  </div>
                </div>

                {/* Category 5: 渠道四（OiiOii · 图片模型） */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">渠道四（图片模型）</p>
                    {generateChannel === 'oiioii' && [
                      '渠道四 GPT-Image2',
                      '渠道四 Nano Pro',
                      '渠道四 Nano 2',
                      '渠道四 Seedream 5.0',
                      '渠道四 Seedream 4.5',
                      '渠道四 Midjourney niji7',
                      '渠道四 Midjourney niji6',
                      '渠道四 NovelAI',
                      '渠道四 GPT-4o',
                    ].includes(globalModel) && (
                      <span className="text-[8px] text-brand font-bold px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30">当前通道</span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { name: '渠道四 GPT-Image2', desc: '文字控制' },
                      { name: '渠道四 Nano Pro', desc: 'Nano Pro' },
                      { name: '渠道四 Nano 2', desc: 'Nano 2' },
                      { name: '渠道四 Seedream 5.0', desc: 'Seedream 5.0' },
                      { name: '渠道四 Seedream 4.5', desc: 'Seedream 4.5' },
                      { name: '渠道四 Midjourney niji7', desc: '动漫 niji7' },
                      { name: '渠道四 Midjourney niji6', desc: '动漫 niji6' },
                      { name: '渠道四 NovelAI', desc: '插画' },
                      { name: '渠道四 GPT-4o', desc: '理解强' },
                    ].map(p => (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => selectGenerationModel(p.name, 'oiioii')}
                        className={`py-2.5 px-1 rounded-lg border text-center flex flex-col items-center justify-center relative transition-all ${
                          globalModel === p.name
                            ? 'border-brand bg-brand/10 text-brand font-bold shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        <span className="absolute top-0.5 right-0.5 scale-75 origin-top-right text-sky-400 text-[6px] font-bold">OI</span>
                        <span className="text-[9px] leading-tight font-semibold text-center">{p.name.replace('渠道四 ', '')}</span>
                        <span className="text-[7px] text-dark-muted mt-0.5 scale-90">图片 · {p.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
                </>}
              </div>
            </div>
          )}

          {/* POPOVER: 提示词后缀模板 */}
          {activePopover === 'suffix' && (
            <div className="absolute top-[102%] left-[155px] w-[420px] max-h-[78vh] overflow-hidden bg-[#1a1b1f] border border-dark-border p-4 rounded-xl shadow-[0_12px_30px_rgba(0,0,0,0.6)] z-50 text-xs text-dark-text animate-in fade-in slide-in-from-top-2 duration-150 flex flex-col">
              <div className="flex justify-between items-center pb-2 border-b border-dark-border/40 mb-3">
                <div>
                  <span className="font-extrabold text-white text-[13px] tracking-wide">提示词后缀模板</span>
                  <p className="text-[9px] text-dark-muted mt-0.5">选择预设后，生成时会自动追加到每个分镜提示词末尾。</p>
                </div>
                <button onClick={() => setActivePopover(null)} className="text-dark-subtle hover:text-white text-sm font-bold">✕</button>
              </div>

              <div className="grid grid-cols-1 gap-2 overflow-y-auto pr-1 max-h-[42vh]">
                {promptSuffixTemplates.map(tpl => {
                  const isExpanded = expandedPromptSuffixId === tpl.id;
                  const suffixText = tpl.suffix || '不追加任何全局后缀。';
                  const isLongSuffix = suffixText.length > 120;
                  return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      setSelectedPromptSuffixId(tpl.id);
                      localStorage.setItem('maocanju_prompt_suffix_id', tpl.id);
                    }}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      selectedPromptSuffixId === tpl.id
                        ? 'border-brand bg-brand/10 shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                        : 'border-dark-border bg-[#222328] hover:border-dark-subtle hover:bg-dark-card'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-extrabold text-white">{tpl.name}</span>
                      <div className="flex items-center gap-1.5">
                        {tpl.id !== 'none' && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditingPromptSuffixTemplate(tpl);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                startEditingPromptSuffixTemplate(tpl);
                              }
                            }}
                            className="px-1.5 py-0.5 rounded text-[9px] font-bold text-dark-muted hover:text-brand hover:bg-brand/10"
                          >
                            编辑
                          </span>
                        )}
                        {tpl.id !== 'none' && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              deletePromptSuffixTemplate(tpl.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                deletePromptSuffixTemplate(tpl.id);
                              }
                            }}
                            className="px-1.5 py-0.5 rounded text-[9px] font-bold text-dark-muted hover:text-red-300 hover:bg-red-500/10"
                          >
                            删除
                          </span>
                        )}
                        {selectedPromptSuffixId === tpl.id && <Check className="w-3.5 h-3.5 text-brand" />}
                      </div>
                    </div>
                    <p className={`text-[9px] text-dark-muted leading-relaxed mt-1 whitespace-pre-wrap break-words ${isExpanded ? 'max-h-40 overflow-y-auto pr-1' : 'line-clamp-3'}`}>{suffixText}</p>
                    {isLongSuffix && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedPromptSuffixId(isExpanded ? null : tpl.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setExpandedPromptSuffixId(isExpanded ? null : tpl.id);
                          }
                        }}
                        className="inline-flex mt-1 text-[9px] font-bold text-brand hover:text-brand-dark"
                      >
                        {isExpanded ? '收起全文' : '展开全文'}
                      </span>
                    )}
                  </button>
                  );
                })}
              </div>

              {isAddingPromptSuffix ? (
                <div className="mt-3 p-3 rounded-xl border border-brand/40 bg-brand/5 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-extrabold text-white">
                      {editingPromptSuffixId ? '修改后缀模板' : '添加后缀模板'}
                    </span>
                    {editingPromptSuffixId && (
                      <button
                        type="button"
                        onClick={startAddingPromptSuffixTemplate}
                        className="text-[9px] font-bold text-dark-muted hover:text-brand"
                      >
                        改为新增
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={newPromptSuffixName}
                    onChange={(e) => setNewPromptSuffixName(e.target.value)}
                    placeholder="模板名称，例如：中文无水印"
                    className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-[10px] text-white placeholder:text-dark-subtle focus:outline-none focus:border-brand/60"
                    autoFocus
                  />
                  <textarea
                    value={newPromptSuffixValue}
                    onChange={(e) => setNewPromptSuffixValue(e.target.value)}
                    placeholder="后缀内容，例如：All text in Chinese, No watermarks, 禁止出现任何logo"
                    className="w-full h-20 bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-[10px] text-white placeholder:text-dark-subtle focus:outline-none focus:border-brand/60 resize-none leading-relaxed"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={savePromptSuffixTemplateForm}
                      className="flex-1 py-2 rounded-lg bg-brand hover:bg-brand-dark text-black text-[10px] font-extrabold transition-all"
                    >
                      {editingPromptSuffixId ? '保存修改' : '保存模板'}
                    </button>
                    <button
                      type="button"
                      onClick={resetPromptSuffixForm}
                      className="px-3 py-2 rounded-lg bg-dark-input border border-dark-border text-dark-muted hover:text-white hover:border-dark-subtle text-[10px] font-bold"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startAddingPromptSuffixTemplate}
                  className="w-full mt-3 py-2 rounded-lg border border-dashed border-brand/60 bg-brand/5 text-brand hover:bg-brand/10 text-[10px] font-extrabold transition-all"
                >
                  添加我的后缀模板
                </button>
              )}

              <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-dark-border/40">
                <span className="text-[9px] text-dark-muted leading-relaxed">
                  选择模板后不会改写分镜文本，只会在点击生成/一键发送时自动带入。
                </span>
                <button
                  type="button"
                  onClick={() => setActivePopover(null)}
                  className="shrink-0 px-3 py-2 rounded-lg bg-dark-input border border-dark-border text-dark-muted hover:text-white hover:border-dark-subtle text-[10px] font-bold"
                >
                  完成
                </button>
              </div>
            </div>
          )}

          {/* POPOVER 2: 属性参数 Modal matching Image 3 */}
          {activePopover === 'params' && (
            <div className="absolute top-[102%] left-[45px] w-[310px] bg-[#1a1b1f] border border-dark-border p-4 rounded-xl shadow-[0_12px_30px_rgba(0,0,0,0.6)] z-50 text-xs text-dark-text animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="flex justify-between items-center pb-2 border-b border-dark-border/40 mb-3.5">
                <span className="font-extrabold text-white text-[12px] tracking-wide">{globalModel} 参数</span>
                <button onClick={() => setActivePopover(null)} className="text-dark-subtle hover:text-white text-sm font-bold">✕</button>
              </div>

              <div className="space-y-4">
                {/* Section 1: 宽高比 */}
                <div>
                  <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">宽高比 ①</p>
                  <div className="flex flex-wrap gap-1.5">
                    {['16:9', '9:16', '1:1', '4:3', '3:4'].map(r => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => updateGlobalAspectRatio(r)}
                        className={`px-3 py-1.5 rounded-lg border text-center text-[10px] font-bold transition-all ${
                          globalAspectRatio === r 
                            ? 'border-brand bg-brand/10 text-brand font-extrabold shadow-[0_0_6px_rgba(16,185,129,0.15)]' 
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Section 2: 图片分辨率 */}
                {getModelMediaType(globalModel) === 'image' && (
                  <div>
                    <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">图片分辨率</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {['2K', '4K'].map(q => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => updateGlobalResolution(q)}
                          className={`py-1.5 rounded-lg border text-center text-[10px] font-bold transition-all ${
                            globalResolution === q
                              ? 'border-brand bg-brand/10 text-brand font-extrabold shadow-[0_0_6px_rgba(16,185,129,0.15)]'
                              : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                          }`}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Section 3: 视频时长 */}
                {getModelMediaType(globalModel) === 'video' && (
                <div>
                  <p className="text-[10px] text-dark-muted font-bold mb-2 uppercase tracking-wider">视频时长 ①</p>
                  <div className="grid grid-cols-7 gap-1">
                    {['2秒', '3秒', '4秒', '5秒', '6秒', '7秒', '8秒', '9秒', '10秒', '11秒', '12秒', '13秒', '14秒', '15秒'].map(d => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => updateGlobalDuration(d)}
                        className={`py-1.5 rounded-lg border text-center text-[10px] font-bold transition-all ${
                          globalDuration === d 
                            ? 'border-brand bg-brand/10 text-brand font-extrabold shadow-[0_0_6px_rgba(16,185,129,0.15)]' 
                            : 'border-dark-border bg-[#222328] hover:border-dark-subtle text-white'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* PANEL 2: 角色 场景 物品 */}
        <div className="bg-dark-card/45 border border-dark-border p-3 rounded-xl flex flex-col justify-between">
          <div className="flex justify-between items-center text-[10px] text-dark-muted font-bold tracking-wider mb-1.5 shrink-0">
            {/* Asset sub-tabs */}
            <div className="flex space-x-2">
              <button 
                onClick={() => setActiveAssetSubTab('character')}
                className={`pb-0.5 border-b transition-all ${activeAssetSubTab === 'character' ? 'text-brand border-brand font-extrabold' : 'hover:text-white border-transparent'}`}
              >角色</button>
              <button 
                onClick={() => setActiveAssetSubTab('scene')}
                className={`pb-0.5 border-b transition-all ${activeAssetSubTab === 'scene' ? 'text-brand border-brand font-extrabold' : 'hover:text-white border-transparent'}`}
              >场景</button>
              <button 
                onClick={() => setActiveAssetSubTab('item')}
                className={`pb-0.5 border-b transition-all ${activeAssetSubTab === 'item' ? 'text-brand border-brand font-extrabold' : 'hover:text-white border-transparent'}`}
              >物品</button>
            </div>
            <div className="flex space-x-1.5">
              <button
                type="button"
                onClick={() => importAssetImages(activeAssetSubTab)}
                className="hover:text-brand"
                title={`选择图片文件夹批量导入${activeAssetSubTab === 'character' ? '角色' : activeAssetSubTab === 'scene' ? '场景' : '物品'}，名称自动使用图片文件名`}
              >
                文件夹导入
              </button>
              <span>|</span>
              <button 
                onClick={() => {
                  if (activeAssetSubTab === 'character') {
                    setEditingCharId('new');
                    setNewCharName('');
                    setNewCharRole('主角设定');
                    setNewCharAvatar('https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=260');
                    setNewCharAvatarPath('');
                    setShowCharacterModal(true);
                  } else {
                    const label = activeAssetSubTab === 'scene' ? '场景' : '物品';
                    const name = prompt(`请输入新${label}名称:`);
                    if (name && name.trim()) {
                      const cleanName = cleanAssetName(name, activeAssetSubTab === 'scene' ? '$' : '#');
                      if (!cleanName) return;
                      const asset = { id: `${activeAssetSubTab}-${Date.now()}`, name: cleanName, role: label, avatar: '' };
                      if (activeAssetSubTab === 'scene') setSceneAssets(prev => [...prev, asset]);
                      else setItemAssets(prev => [...prev, asset]);
                    }
                  }
                }} 
                className="hover:text-brand"
              >
                新增
              </button>
              <span>|</span>
              <button 
                onClick={() => {
                  if (activeAssetSubTab === 'character') {
                    if (characterAssets[0]) {
                      setEditingCharId(characterAssets[0].id);
                      setNewCharName(characterAssets[0].name);
                      setNewCharRole(characterAssets[0].role || '');
                      setNewCharAvatar(characterAssets[0].avatar);
                      setNewCharAvatarPath(characterAssets[0].avatarPath || '');
                      setShowCharacterModal(true);
                    } else {
                      setEditingCharId('new');
                      setNewCharName('');
                      setNewCharRole('主角设定');
                      setNewCharAvatar('https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=260');
                      setNewCharAvatarPath('');
                      setShowCharacterModal(true);
                    }
                  } else {
                    const label = activeAssetSubTab === 'scene' ? '场景' : '物品';
                    const triggerSym = activeAssetSubTab === 'scene' ? '$' : '#';
                    const assets = activeAssetSubTab === 'scene' ? sceneAssets : itemAssets;
                    const setAssets = activeAssetSubTab === 'scene' ? setSceneAssets : setItemAssets;
                    const target = assets[0];
                    const nextName = prompt(target ? `编辑${label}名称:` : `请输入新${label}名称:`, target?.name || '');
                    if (!nextName || !nextName.trim()) return;
                    const cleanName = cleanAssetName(nextName, triggerSym);
                    if (!cleanName) return;
                    if (target) {
                      setAssets(prev => prev.map(x => x.id === target.id ? { ...x, name: cleanName } : x));
                    } else {
                      setAssets(prev => [...prev, { id: `${activeAssetSubTab}-${Date.now()}`, name: cleanName, role: label, avatar: '' }]);
                    }
                  }
                }} 
                className="hover:text-white"
              >
                管理
              </button>
            </div>
          </div>

          {/* Render asset lists by active sub-tab */}
          {activeAssetSubTab === 'character' ? (
            <div className="flex items-center space-x-2 flex-1 overflow-x-auto no-scrollbar pt-1">
              <button 
                onClick={() => {
                  setEditingCharId('new');
                  setNewCharName('');
                  setNewCharRole('主角设定');
                  setNewCharAvatar('https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=260');
                  setNewCharAvatarPath('');
                  setShowCharacterModal(true);
                }}
                className="w-7 h-7 rounded-full border border-dashed border-dark-border flex items-center justify-center text-dark-muted hover:text-brand hover:border-brand/40 transition-colors shrink-0"
                title="添加新角色"
              >
                <Plus className="w-4 h-4" />
              </button>
              {characterAssets.map(c => (
                <div 
                  key={c.id} 
                  onClick={() => {
                    setEditingCharId(c.id);
                    setNewCharName(c.name);
                    setNewCharRole(c.role || '');
                    setNewCharAvatar(c.avatar);
                    setNewCharAvatarPath(c.avatarPath || '');
                    setShowCharacterModal(true);
                  }}
                  className="flex flex-col items-center justify-center shrink-0 cursor-pointer group"
                  title={`点击编辑: ${c.name} (${c.role})`}
                >
                  <img src={c.avatar} alt={c.name} className="w-7 h-7 rounded-full border border-dark-border group-hover:border-brand/50 transition-all object-cover" />
                  <span className="text-[8px] text-dark-muted group-hover:text-white mt-0.5 truncate max-w-[40px] scale-90">{c.name}</span>
                </div>
              ))}
            </div>
          ) : (() => {
            const isScene = activeAssetSubTab === 'scene';
            const list = isScene ? sceneAssets : itemAssets;
            const setList = isScene ? setSceneAssets : setItemAssets;
            const label = isScene ? '场景' : '物品';
            const triggerSym = isScene ? '$' : '#';
            const AssetIcon = isScene ? Mountain : Gamepad2;
            return (
              <div className="flex items-center space-x-2 flex-1 overflow-x-auto no-scrollbar pt-1">
                <button
                  onClick={() => {
                    const name = prompt(`请输入新${label}名称:`);
                    if (name && name.trim()) {
                      const cleanName = cleanAssetName(name, triggerSym);
                      if (!cleanName) return;
                      setList(prev => [...prev, { id: `${activeAssetSubTab}-${Date.now()}`, name: cleanName, role: label, avatar: '' }]);
                    }
                  }}
                  className="w-7 h-7 rounded-full border border-dashed border-dark-border flex items-center justify-center text-dark-muted hover:text-brand hover:border-brand/40 transition-colors shrink-0"
                  title={`添加新${label}`}
                >
                  <Plus className="w-4 h-4" />
                </button>
                {list.map(a => (
                  <div
                    key={a.id}
                    className="relative flex flex-col items-center justify-center shrink-0 cursor-pointer group"
                    title={`点击编辑: ${a.name}（描述词中输入 ${triggerSym} 调用）`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`删除${label} "${a.name}" ？`)) {
                          setList(prev => prev.filter(x => x.id !== a.id));
                        }
                      }}
                      className="absolute -top-1 -right-1 z-10 w-3.5 h-3.5 rounded-full bg-red-500/80 text-white opacity-0 group-hover:opacity-100 hover:bg-red-500 transition-all flex items-center justify-center"
                      title={`删除${label}`}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                    <div
                      onClick={() => {
                        const nextName = prompt(`编辑${label}名称:`, a.name);
                        if (!nextName || !nextName.trim()) return;
                        const cleanName = cleanAssetName(nextName, triggerSym);
                        if (!cleanName) return;
                        setList(prev => prev.map(x => x.id === a.id ? { ...x, name: cleanName } : x));
                      }}
                      className="flex flex-col items-center justify-center"
                    >
                      <span className="w-7 h-7 rounded-full border border-dark-border group-hover:border-brand/50 transition-all bg-[#18191c] flex items-center justify-center overflow-hidden">
                        {a.avatar ? (
                          <img src={a.avatar} alt={a.name} className="w-full h-full object-cover" />
                        ) : (
                          <AssetIcon className="w-3.5 h-3.5 text-dark-muted group-hover:text-brand" />
                        )}
                      </span>
                      <span className="text-[8px] text-dark-muted group-hover:text-white mt-0.5 truncate max-w-[40px] scale-90">{a.name}</span>
                    </div>
                  </div>
                ))}
                {list.length === 0 && (
                  <span className="text-[9px] text-dark-subtle pl-1">暂无{label}，点 + 添加后可在描述词输入 {triggerSym} 调用</span>
                )}
              </div>
            );
          })()}
        </div>

        {/* PANEL 3: 草稿进度监控 */}
        <div className="bg-dark-card/45 border border-dark-border p-3 rounded-xl flex flex-col justify-between">
          <div className="flex justify-between items-center text-[10px] text-dark-muted font-bold uppercase shrink-0">
            <span>草稿任务统计</span>
            <span>进度 {segments.length > 0 ? Math.round((segments.filter(s => s.text && s.text.length > 20).length / segments.length) * 100) : 0}%</span>
          </div>
          
          <div className="grid grid-cols-3 gap-1.5 py-1">
            <div className="text-[9px] text-dark-muted leading-tight">
              配音 <span className="text-white font-bold block text-xs">0/{segments.length}</span>
            </div>
            <div className="text-[9px] text-dark-muted leading-tight border-l border-dark-border/40 pl-1.5">
              描述 <span className="text-white font-bold block text-xs">{segments.filter(s => s.text && s.text.length > 20).length}/{segments.length}</span>
            </div>
            <div className="text-[9px] text-dark-muted leading-tight border-l border-dark-border/40 pl-1.5">
              素材 <span className="text-white font-bold block text-xs">{segments.filter(s => (s.type === 'video' ? s.materialsVideo.length : s.materialsImage.length) > 0).length}/{segments.length}</span>
            </div>
          </div>

          {/* Smooth custom rendering progress bar */}
          <div className="w-full h-1 bg-dark-bg rounded-full overflow-hidden shrink-0 mt-0.5">
            <div 
              className="h-full bg-gradient-to-r from-brand to-emerald-400 rounded-full transition-all duration-1000" 
              style={{ width: `${segments.length > 0 ? Math.round((segments.filter(s => s.text && s.text.length > 20).length / segments.length) * 100) : 0}%` }}
            />
          </div>
        </div>

      </div>

      {/* 2. Column Headers Bar (Sticky Top) */}
      <div className="h-10 px-6 bg-dark-sidebar/40 border-b border-dark-border flex items-center text-xs font-bold text-dark-muted shrink-0 select-none">
        <div className="w-[48%] flex items-center justify-between pr-4 border-r border-dark-border/40">
          <span>描述词</span>
          <button className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-white px-2 py-0.5 rounded bg-dark-card border border-dark-border">
            <SlidersHorizontal className="w-2.5 h-2.5" />
            <span>筛选</span>
          </button>
        </div>
        <div className="w-[26%] flex items-center justify-between px-4 border-r border-dark-border/40">
          <span>当前素材</span>
          <div className="flex items-center space-x-1.5">
            <button
              onClick={handleExportAllCurrent}
              className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-black hover:bg-brand px-2 py-0.5 rounded bg-dark-card border border-dark-border hover:border-brand transition-all"
              title="导出所有行的当前素材"
            >
              <Download className="w-2.5 h-2.5" />
              <span>导出</span>
            </button>
            <button
              onClick={handleClearAllMaterials}
              className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-white hover:bg-red-500/80 px-2 py-0.5 rounded bg-dark-card border border-dark-border hover:border-red-400 transition-all"
              title="清空所有行的当前素材和可选素材"
            >
              <Trash2 className="w-2.5 h-2.5" />
              <span>清空所有素材</span>
            </button>
            <button
              onClick={handleMergeAllRows}
              disabled={mergeAllProgress.running}
              className="flex items-center space-x-1 text-[10px] text-dark-muted hover:text-black hover:bg-brand px-2 py-0.5 rounded bg-dark-card border border-dark-border hover:border-brand transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="对所有未锁定的行：把垫图 + @角色 + $场景 + #物品 合成为新的垫图"
            >
              <Combine className="w-2.5 h-2.5" />
              <span>
                {mergeAllProgress.running
                  ? `合并中 ${mergeAllProgress.current}/${mergeAllProgress.total}`
                  : '一键合并垫图'}
              </span>
            </button>
            <span className="text-[9px] bg-dark-input text-dark-subtle px-1.5 py-0.2 rounded font-normal">多行独立锁定</span>
          </div>
        </div>
        <div className="w-[26%] flex items-center justify-between pl-4">
          <span>可选素材</span>
          <div className="flex items-center space-x-1 bg-blue-500/10 border border-blue-500/30 text-blue-400 px-2 py-0.5 rounded text-[9px]">
            <span>☁️ 拖拽至此上传</span>
          </div>
        </div>
      </div>

      {/* 3. Rows Content Area (Each row has description, current material and available materials) */}
      <div className="flex-1 overflow-y-auto no-scrollbar bg-dark-bg/10 divide-y divide-dark-border/30 pb-12">
        {segments.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-dark-card border border-dark-border flex items-center justify-center">
              <FolderPlus className="w-7 h-7 text-dark-muted" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-bold text-dark-text">暂无分镜内容</p>
              <p className="text-xs text-dark-muted">点击下方按钮新增第一行分镜，开始创作</p>
            </div>
            <button
              type="button"
              onClick={handleAddNewSegmentRow}
              className="flex items-center space-x-2 px-5 py-2.5 bg-brand hover:bg-brand-dark text-black rounded-lg text-xs font-bold transition-all shadow-md"
            >
              <Plus className="w-4 h-4" />
              <span>新增第一行分镜</span>
            </button>
          </div>
        )}
        {segments.map((row) => {
          const isVid = row.type === 'video';
          const currentMaterial = (isVid ? row.currentMaterialVideo : row.currentMaterialImage) || { id: 0, name: '暂无画面', thumbnail: '', duration: '00:00', fps: 0, isPlaying: false };
          const materials = (isVid ? row.materialsVideo : row.materialsImage) || [];
          const isCurrentPlaying = isVid ? currentMaterial.isPlaying : false;
          
          return (
            <div 
              key={row.id}
              className="flex px-6 py-5 items-stretch hover:bg-dark-card/5 transition-all relative group/row"
            >
              {/* Floating Row Deletion Button on hover */}
              <button 
                onClick={(e) => handleDeleteSegmentRow(row.id, e)}
                className="absolute left-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 p-1.5 bg-red-500/15 border border-red-500/30 hover:bg-red-500 text-dark-muted hover:text-white rounded-full transition-all z-20"
                title="删除此行分镜"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              {/* COLUMN 1: Prompt segment (48% width) */}
              <div className="w-[48%] pr-4 flex flex-col justify-between border-r border-dark-border/20">
                <div className="space-y-3.5">
                  {/* Row ID, Mode switcher & Header info */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <span className="w-5 h-5 rounded-full bg-brand text-black flex items-center justify-center text-[11px] font-extrabold shadow-[0_0_8px_rgba(16,185,129,0.3)]">
                        {row.id}
                      </span>
                      
                      {/* Media mode button */}
                      <div className="flex bg-dark-bg p-0.5 rounded-lg border border-dark-border text-[10px]">
                        <button 
                          onClick={() => {
                            const nextModel = IMAGE_MODEL_NAMES.has(globalModel) ? '渠道四 Gemini' : globalModel;
                            setGlobalModel(nextModel);
                            setGenerateChannel(generateChannel === 'pixmax' ? 'pixmax' : (nextModel.startsWith('渠道四') ? 'oiioii' : nextModel.startsWith('渠道六') ? 'dola' : 'wizstar'));
                            setSegments(segments.map(s => s.id === row.id ? { ...s, type: 'video', model: nextModel } : s));
                          }}
                          className={`flex items-center space-x-1 px-2.5 py-1 rounded-md font-bold transition-all ${
                            row.type === 'video' ? 'bg-brand text-black shadow-sm' : 'text-dark-muted hover:text-white'
                          }`}
                        >
                          <Video className="w-2.5 h-2.5" />
                          <span>视频</span>
                        </button>
                        <button 
                          onClick={() => {
                            const nextModel = IMAGE_MODEL_NAMES.has(globalModel) ? globalModel : '渠道四 GPT-Image2';
                            setGlobalModel(nextModel);
                            setGenerateChannel('oiioii');
                            setSegments(segments.map(s => s.id === row.id ? { ...s, type: 'image', model: nextModel } : s));
                          }}
                          className={`flex items-center space-x-1 px-2.5 py-1 rounded-md font-bold transition-all ${
                            row.type === 'image' ? 'bg-brand text-black shadow-sm' : 'text-dark-muted hover:text-white'
                          }`}
                        >
                          <ImageIcon className="w-2.5 h-2.5" />
                          <span>图片</span>
                        </button>
                      </div>
                    </div>

                    <span className="text-[9px] text-dark-subtle font-semibold">支持输入 @ 角色 · $ 场景 · # 物品</span>
                  </div>

                  {/* Single Big Text Bubble with Embedded Inline Badges matching Screenshot 2 */}
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'copy';
                      e.currentTarget.classList.add('ring-2', 'ring-purple-500', 'border-purple-500');
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.remove('ring-2', 'ring-purple-500', 'border-purple-500');
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.remove('ring-2', 'ring-purple-500', 'border-purple-500');
                      const files = Array.from(e.dataTransfer.files || []);
                      const imgFile = files.find(f => f.type.startsWith('image/'));
                      if (!imgFile) {
                        alert('请拖入图片文件作为垫图');
                        return;
                      }
                      const filePath = imgFile.path || '';
                      const displayUrl = filePath ? makeLocalFileUrl(filePath) : URL.createObjectURL(imgFile);
                      setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: makeLocalReferenceImage(filePath, displayUrl), referenceImagePath: filePath} : s));
                    }}
                    className="bg-[#18191c] border border-dark-border/60 hover:border-[#10b981]/30 rounded-xl p-3 flex flex-col justify-start min-h-[112px] transition-all relative"
                  >
                    {/* 垫图徽章始终显示在文本区域上方 */}
                    <div className="mb-1.5 flex items-center">
                      {getReferenceDisplayUrl(row) ? (
                        <span 
                          className="inline-flex items-center space-x-1 bg-[#4c2d9a] hover:bg-[#5b39b0] text-white pl-2 pr-1 py-0.5 rounded font-bold select-none scale-95"
                        >
                          <span
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (window.electronAPI && window.electronAPI.selectFile) {
                                const filePath = await window.electronAPI.selectFile([
                                  { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }
                                ]);
                                if (filePath) {
                                  setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: makeLocalReferenceImage(filePath), referenceImagePath: filePath} : s));
                                }
                              }
                            }}
                            className="inline-flex items-center space-x-1 cursor-pointer"
                            title="点击更换垫图"
                          >
                            <img src={getReferenceDisplayUrl(row)} alt="ref" className="w-3.5 h-3.5 object-cover rounded-sm" />
                            <span className="text-[9px]">垫图</span>
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: null, referenceImagePath: ''} : s));
                            }}
                            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-black/30 text-white/70 hover:text-white transition-colors"
                            title="删除垫图"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </span>
                      ) : (
                        <span
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (window.electronAPI && window.electronAPI.selectFile) {
                              const filePath = await window.electronAPI.selectFile([
                                { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }
                              ]);
                              if (filePath) {
                                setSegments(prev => prev.map(s => s.id === row.id ? {...s, referenceImage: makeLocalReferenceImage(filePath), referenceImagePath: filePath} : s));
                              }
                            }
                          }}
                          className="inline-flex items-center space-x-1 bg-dark-card hover:bg-[#4c2d9a] text-dark-muted hover:text-white px-2 py-0.5 rounded cursor-pointer font-bold select-none scale-95 border border-dashed border-dark-border hover:border-purple-500 transition-all"
                        >
                          <Plus className="w-3 h-3" />
                          <span className="text-[9px]">垫图</span>
                        </span>
                      )}
                    </div>

                    {editingRowId === row.id ? (
                      <textarea
                        autoFocus
                        ref={(el) => {
                          if (el) {
                            promptTextareaRefs.current[row.id] = el;
                            requestAnimationFrame(() => resizePromptTextarea(el));
                          } else delete promptTextareaRefs.current[row.id];
                        }}
                        defaultValue={promptDraftsRef.current[row.id] ?? row.text}
                        onChange={(e) => handleTextareaChange(row.id, e.target.value, e)}
                        onKeyDown={(e) => handleTextareaKeyDown(row.id, e)}
                        onBlur={() => {
                          commitPromptDraft(row.id);
                          setTimeout(() => {
                            setEditingRowId(null);
                            resetAtState();
                          }, 150);
                        }}
                        placeholder="请输入描述词，输入 @ 选择角色、$ 选择场景、# 选择物品..."
                        className="w-full min-h-[72px] max-h-[260px] bg-transparent text-xs leading-relaxed text-dark-text placeholder-dark-subtle resize-none overflow-y-auto border-none outline-none focus:ring-0 p-0"
                      />
                    ) : (
                      <div 
                        onClick={() => startEditingPrompt(row)}
                        className="min-h-[72px] max-h-[260px] w-full cursor-text overflow-y-auto pr-1"
                        title="点击开始编辑文本"
                      >
                        <div className="text-xs text-dark-text leading-relaxed font-normal whitespace-pre-wrap select-text">
                          {/* Parser: renders （@角色）/（$场景）/（#物品）as colored pill badges */}
                          {(() => {
                            const text = row.text || '';
                            // 捕获形如 （@名字）（$名字）（#名字）或半角括号版本
                            const parts = text.split(/([（(][@$#][^）)]+[）)])/g);

                            return parts.map((part, i) => {
                              const m = part.match(/^[（(]([@$#])([^）)]+)[）)]$/);
                              if (m) {
                                const sym = m[1];
                                const rawName = m[2];
                                const meta = TRIGGERS[sym] || TRIGGERS['@'];
                                const name = meta.type === 'scene' ? cleanAssetName(rawName, '$') : meta.type === 'item' ? cleanAssetName(rawName, '#') : rawName.trim();
                                const asset = getAssetsForTrigger(sym).find(a => a.name === name);
                                const Icon = meta.type === 'scene' ? Mountain : (meta.type === 'item' ? Gamepad2 : null);
                                return (
                                  <span key={i} className="inline-flex items-center bg-[#133125] text-white px-2 py-0.5 rounded-full mx-1 align-middle select-none border border-[#10b981]/25 scale-95 animate-fade-in">
                                    {asset?.avatar ? (
                                      <img src={asset.avatar} className="w-3.5 h-3.5 rounded-full object-cover mr-1" />
                                    ) : (
                                      <span className="w-3.5 h-3.5 rounded-full bg-black/40 flex items-center justify-center mr-1">
                                        {Icon ? <Icon className="w-2 h-2 text-[#10b981]" /> : <span className="text-[7px] text-[#10b981] font-bold">{sym}</span>}
                                      </span>
                                    )}
                                    <span className="text-[8px] bg-black/40 text-[#10b981] px-1 rounded mr-1 scale-90 font-bold">{meta.label}</span>
                                    <span className="font-bold text-[10px] text-[#10b981]">{name}</span>
                                  </span>
                                );
                              }
                              return <span key={i}>{part}</span>;
                            });
                          })()}
                        </div>
                      </div>
                    )}

                    {/* Autocomplete @ / $ / # asset choice popover */}
                    {atState.isOpen && atState.rowId === row.id && (() => {
                      const activeTrigger = atState.trigger || '@';
                      const triggerMeta = TRIGGERS[activeTrigger] || TRIGGERS['@'];
                      const assetList = getAssetsForTrigger(activeTrigger);
                      const filtered = assetList.filter(a => a.name.toLowerCase().includes(atState.query.toLowerCase()));
                      const TriggerIcon = triggerMeta.type === 'scene' ? Mountain : (triggerMeta.type === 'item' ? Gamepad2 : null);
                      return (
                      <div 
                        onMouseDown={(e) => e.preventDefault()} // Prevent blur on click!
                        className="absolute left-6 top-[78px] w-[460px] h-[190px] bg-[#222328] border border-dark-border rounded-xl shadow-[0_12px_28px_rgba(0,0,0,0.6)] flex items-stretch overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100"
                      >
                        {/* Left List of Assets */}
                        <div className="w-[220px] border-r border-dark-border/40 p-2 flex flex-col space-y-1 overflow-y-auto no-scrollbar">
                          <div className="text-[9px] text-dark-subtle font-bold px-1 pb-1 uppercase tracking-wider shrink-0">
                            {triggerMeta.label}（{activeTrigger}）
                          </div>
                          {filtered.map((asset, index) => {
                              const isHovered = hoveredCharId === asset.id;
                              return (
                                <div
                                  key={asset.id}
                                  onMouseEnter={() => setHoveredCharId(asset.id)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSelectCharacterFromDropdown(row.id, asset.name, activeTrigger);
                                  }}
                                  className={`flex items-center space-x-3 p-1.5 rounded-lg cursor-pointer transition-colors ${
                                    isHovered ? 'bg-[#323338] text-brand' : 'hover:bg-[#2d2e33]/50 text-dark-text'
                                  }`}
                                >
                                  {/* Index Badge */}
                                  <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-extrabold transition-colors shrink-0 ${
                                    isHovered ? 'bg-[#10b981] text-black font-extrabold shadow-[0_0_6px_rgba(16,185,129,0.3)]' : 'bg-[#18191c] text-dark-muted'
                                  }`}>
                                    {index + 1}
                                  </span>
                                  
                                  {/* Small avatar or icon fallback */}
                                  {asset.avatar ? (
                                    <img src={asset.avatar} alt={asset.name} className="w-6 h-6 rounded-full object-cover border border-dark-border/20 shrink-0" />
                                  ) : (
                                    <span className="w-6 h-6 rounded-full bg-[#18191c] border border-dark-border/20 flex items-center justify-center shrink-0">
                                      {TriggerIcon ? <TriggerIcon className="w-3 h-3 text-dark-muted" /> : <span className="text-[10px] text-dark-muted">{activeTrigger}</span>}
                                    </span>
                                  )}
                                  
                                  {/* Asset Name */}
                                  <span className="text-xs font-semibold truncate flex-1">{asset.name}</span>
                                </div>
                              );
                            })}
                          {filtered.length === 0 && (
                            <div className="text-[10px] text-dark-subtle text-center py-6">
                              无匹配{triggerMeta.label}{assetList.length === 0 ? `，请先在下方资产区添加${triggerMeta.label}` : ''}
                            </div>
                          )}
                        </div>

                        {/* Right Larger Asset Profile Card */}
                        {(() => {
                          const activeChar = assetList.find(c => c.id === hoveredCharId) || filtered[0] || assetList[0];
                          return activeChar ? (
                            <div className="flex-1 bg-black/15 p-3 flex items-stretch space-x-3 relative">
                              <div className="w-[125px] h-full rounded-lg overflow-hidden border border-dark-border/30 relative shrink-0">
                                {activeChar.avatar ? (
                                  <img src={activeChar.avatar} alt="preview" className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full bg-[#18191c] flex items-center justify-center">
                                    {TriggerIcon ? <TriggerIcon className="w-8 h-8 text-dark-muted" /> : <span className="text-2xl text-dark-muted">{activeTrigger}</span>}
                                  </div>
                                )}
                                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1 text-center">
                                  <span className="text-[8px] text-brand font-extrabold tracking-wider bg-black/40 px-1 py-0.2 rounded">{activeChar.role || triggerMeta.label}</span>
                                </div>
                              </div>
                              <div className="flex-1 flex flex-col justify-center text-left">
                                <div className="text-xs font-bold text-white text-base">{activeChar.name}</div>
                                <div className="text-[10px] text-[#10b981] mt-1 font-semibold">{triggerMeta.label}就绪</div>
                                <div className="text-[9px] text-dark-subtle mt-1.5 leading-relaxed">点击自动将其转化为描述词标签，并同步添加至本分镜。</div>
                              </div>
                            </div>
                          ) : null;
                        })()}
                      </div>
                      );
                    })()}

                  </div>
                </div>

                {/* Sub row controls - High-fidelity Row Segment Footer matching Image 1 */}
                <div className="flex items-center justify-between pt-3 border-t border-dark-border/20 mt-2.5">
                  {/* Left Side: Parameters badges */}
                  <div className="flex items-center space-x-1.5 text-[10px]">
                    {/* Model Dropdown Trigger */}
                    <div 
                      onClick={() => setActivePopover('model')}
                      className="bg-[#222328] hover:bg-dark-bg border border-dark-border hover:border-brand/40 px-2.5 py-1.5 rounded-lg text-[#d1d5db] font-semibold cursor-pointer transition-colors scale-95"
                    >
                      <span className="text-[9px] text-brand font-extrabold mr-1">{getRowMediaLabel(row)}</span>
                      {getRowModelName(row)}
                    </div>

                    {/* API/Local channel selector with dropdown arrow ▼ */}
                    <div 
                      onClick={() => {
                        const currentChannel = row.channel || 'API';
                        const nextChannel = currentChannel === 'API' ? '本地' : 'API';
                        setSegments(segments.map(s => s.id === row.id ? { ...s, channel: nextChannel } : s));
                      }}
                      className="bg-[#222328] hover:bg-dark-bg border border-dark-border hover:border-brand/40 px-2.5 py-1.5 rounded-lg text-dark-muted font-bold cursor-pointer transition-colors flex items-center space-x-1.5 uppercase scale-95"
                      title="点击切换渠道"
                    >
                      <span>{row.channel || 'API'}</span>
                      <span className="scale-75 text-[8px] text-dark-subtle">▼</span>
                    </div>

                    {/* Aspect Ratio and Duration Badge */}
                    <div 
                      onClick={() => setActivePopover('params')}
                      className="bg-[#222328] hover:bg-dark-bg border border-dark-border hover:border-brand/40 px-2.5 py-1.5 rounded-lg text-dark-muted font-medium cursor-pointer transition-colors scale-95"
                    >
                      {globalAspectRatio} · {globalDuration}
                    </div>
                  </div>

                  {/* Right Side: Merge / Reasoning / Generate buttons */}
                  <div className="flex items-center space-x-2">
                    {/* Merge images button: pull @角色 / $场景 / #物品 / 垫图 into a single reference */}
                    <button
                      type="button"
                      onClick={() => openMergeModalForRow(row)}
                      className="flex items-center space-x-1 px-2.5 py-1.5 bg-[#1d1830] hover:bg-[#2a2244] border border-[#3a2f5e] text-[#b9a4ff] font-bold rounded-lg text-[11px] transition-colors"
                      title="把该行的垫图 + @角色 + $场景 + #物品 合成为一张新的垫图（不压缩分辨率）"
                    >
                      <Combine className="w-3 h-3" />
                      <span>合并图片</span>
                    </button>
                    {/* Reasoning button */}
                    <button 
                      type="button"
                      onClick={() => {
                        alert(`正在对分镜行 ${row.id} 描述词进行大模型智能推理扩写...\n成功优化语义！已开启多角色动作衔接特征。`);
                      }}
                      className="px-3 py-1.5 bg-[#162923] hover:bg-[#1f3a2f] border border-[#1a3d31] text-[#10b981] font-bold rounded-lg text-[11px] transition-colors"
                    >
                      推理
                    </button>

                    {/* Generate button */}
                    <button 
                      type="button"
                      onClick={() => handleGenerate(row.id)}
                      className="flex items-center space-x-1 px-3.5 py-1.5 bg-brand hover:bg-brand-dark text-black rounded-lg text-[11px] font-bold transition-all shadow-[0_2px_10px_rgba(16,185,129,0.15)] active:scale-95"
                      title="可连续点击多次，每次都会提交一个新的生成任务"
                    >
                      <Send className="w-3 h-3" />
                      <span>
                        {row.generating
                          ? `继续生成${getRowMediaLabel(row)}${row.activeTaskCount ? ` (${row.activeTaskCount})` : ''}`
                          : `生成${getRowMediaLabel(row)}`}
                      </span>
                    </button>
                    {(row.pendingChannel === 'dola' || row.lastFailedChannel === 'dola') && (row.pendingTaskId || row.lastFailedTaskId) && (
                      <button
                        type="button"
                        onClick={() => handleCollectDolaTask(row)}
                        className="px-2.5 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-300 hover:bg-orange-500/20 hover:text-orange-200 text-[11px] font-bold transition-all"
                        title="主动轮询渠道六结果，避免自动采集漏掉视频"
                      >
                        手动采集
                      </button>
                    )}
                    {hasActiveGenerationTask(row) && (
                      <button
                        type="button"
                        onClick={() => cancelRowGeneration(row.id)}
                        className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 hover:text-red-200 text-[11px] font-bold transition-all"
                        title="清空当前行所有等待中的任务状态"
                      >
                        清空等待
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* COLUMN 2: Row Current Material Viewport (26% width) */}
              <div className="w-[26%] px-4 flex flex-col justify-start space-y-2 border-r border-dark-border/20 relative">
                {/* Lock overlay if toggled on */}
                {row.isLocked && (
                  <div className="absolute inset-x-4 inset-y-0 bg-black/75 z-10 rounded-xl flex flex-col items-center justify-center text-center p-3 animate-in fade-in duration-200">
                    <Lock className="w-7 h-7 text-amber-500 animate-bounce mb-1" />
                    <span className="text-[10px] text-white font-bold">画面已锁定</span>
                    <button 
                      onClick={() => toggleLockRowMaterial(row.id)}
                      className="mt-2 px-2.5 py-0.5 bg-brand text-black rounded text-[9px] font-bold"
                    >
                      解锁
                    </button>
                  </div>
                )}

                {/* Sub-header inside column */}
                <div className="flex items-center justify-between mb-1 shrink-0">
                  <span className="text-[10px] font-bold text-dark-muted truncate max-w-[55%]">{currentMaterial.name}</span>
                  <div className="flex items-center space-x-1">
                    {/* Clear current preview button */}
                    {currentMaterial.id > 0 && (
                      <button 
                        type="button"
                        onClick={() => handleClearCurrent(row.id)}
                        className="p-1.5 hover:bg-red-500/15 rounded-md text-dark-muted hover:text-red-400 transition-all"
                        title="清除当前预览画面"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button 
                      onClick={() => toggleLockRowMaterial(row.id)}
                      className="flex items-center space-x-1 text-[9px] text-dark-muted hover:text-white px-1.5 py-0.5 rounded bg-dark-card border border-dark-border"
                    >
                      {row.isLocked ? <Lock className="w-2.5 h-2.5 text-amber-500" /> : <Unlock className="w-2.5 h-2.5" />}
                      <span>{row.isLocked ? '锁定' : '未锁'}</span>
                    </button>
                  </div>
                </div>

                {/* Canvas viewport container */}
                <div
                  className="w-full h-[156px] rounded-xl bg-zinc-950 border border-dark-border overflow-hidden relative flex items-center justify-center group/viewport shrink-0"
                  onDoubleClick={() => {
                    if (currentMaterial.thumbnail) {
                      const previewSrc = isVid
                        ? playableUrlForMaterial(currentMaterial)
                        : currentMaterial.thumbnail;
                      setFullscreenVideo({ src: previewSrc, mediaType: currentMaterial.mediaType || (isVideoUrl(previewSrc) ? 'video' : 'image') });
                    }
                  }}
                  title={currentMaterial.thumbnail ? '双击放大预览' : undefined}
                >
                  {currentMaterial.thumbnail ? (
                    currentMaterial.mediaType === 'video' || isVideoUrl(currentMaterial.thumbnail) ? (
                      <video
                        ref={(el) => {
                          if (!el) return;
                          if (isCurrentPlaying && el.paused) el.play().catch(()=>{});
                          if (!isCurrentPlaying && !el.paused) el.pause();
                        }}
                        key={playableUrlForMaterial(currentMaterial)}
                        src={isCurrentPlaying ? playableUrlForMaterial(currentMaterial) : undefined}
                        className={`w-full h-full object-contain bg-zinc-950 ${isCurrentPlaying ? 'scale-105 brightness-110' : ''} transition-all duration-700`}
                        muted
                        playsInline
                        loop
                        preload="none"
                        onError={() => {
                          if (isCurrentPlaying) {
                            console.warn('Video preview failed:', currentMaterial.thumbnail);
                          }
                        }}
                      />
                    ) : (
                      <img 
                        src={currentMaterial.thumbnail} 
                        alt={currentMaterial.name}
                        draggable={!isVid}
                        onMouseEnter={() => prepareExternalImageDrag(currentMaterial)}
                        onMouseDown={() => prepareExternalImageDrag(currentMaterial)}
                        onDragStart={(e) => startExternalImageDrag(e, currentMaterial)}
                        className={`w-full h-full object-contain bg-zinc-950 ${isCurrentPlaying ? 'scale-105 brightness-110' : ''} transition-all duration-700`}
                      />
                    )
                  ) : (
                    <div className="flex flex-col items-center justify-center text-dark-muted space-y-1">
                      <Video className="w-6 h-6 opacity-30" />
                      <span className="text-[9px] opacity-50">等待生成</span>
                    </div>
                  )}

                  {/* Generating progress overlay */}
                  {row.generating && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-zinc-950/80 backdrop-blur-[2px] px-5 space-y-2.5">
                      <RefreshCw className="w-5 h-5 text-brand animate-spin" />
                      {row.pendingChannel === 'dola' && (row.pendingAccountName || row.pendingAccountId) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenDolaAccountBrowser(row);
                          }}
                          className="max-w-full rounded-full border border-brand/35 bg-brand/10 px-2.5 py-1 text-[9px] font-extrabold text-brand hover:bg-brand hover:text-black transition-all truncate"
                          title="点击打开这个渠道六账号的浏览器窗口"
                        >
                          {row.pendingAccountName || `Dola账号 #${row.pendingAccountId}`}
                        </button>
                      )}
                      <span className="text-[10px] font-bold text-white">
                        {row.activeTaskCount > 1
                          ? `${row.activeTaskCount} 个任务生成中...`
                          : row.queuePosition != null && row.queuePosition > 0
                          ? `排队中 #${row.queuePosition}`
                          : (typeof row.generateProgress === 'number' && row.generateProgress > 0
                              ? `生成中 ${row.generateProgress}%`
                              : row.generateStatus === 'processing' ? '生成中...' : '等待中...')}
                      </span>
                      <div className="w-full max-w-[180px] h-1.5 rounded-full bg-dark-border/60 overflow-hidden">
                        {typeof row.generateProgress === 'number' && row.generateProgress > 0 ? (
                          <div
                            className="h-full bg-brand rounded-full transition-all duration-500 ease-out shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                            style={{ width: `${Math.min(100, Math.max(2, row.generateProgress))}%` }}
                          />
                        ) : (
                          <div className="h-full w-1/3 bg-brand/70 rounded-full animate-pulse" />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Generation failure message */}
                  {!row.generating && row.generationError && (
                    <div className="absolute inset-x-2 bottom-2 z-30 rounded-lg border border-red-500/40 bg-red-950/85 px-3 py-2 text-[10px] text-red-100 shadow-lg backdrop-blur-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-extrabold text-red-300">生成失败</div>
                          <div className="mt-0.5 max-h-8 overflow-hidden break-words" title={row.generationError}>{row.generationError}</div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSegments(prev => prev.map(seg => seg.id === row.id ? { ...seg, generationError: '' } : seg));
                          }}
                          className="shrink-0 rounded bg-white/10 p-0.5 text-red-100 hover:bg-white/20"
                          title="关闭提示"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Play Action center overlay (Only when there's actual content) */}
                  {isVid && currentMaterial.thumbnail && (
                    <button 
                      onClick={() => togglePlayCurrent(row.id)}
                      className={`absolute inset-0 m-auto w-10 h-10 rounded-full bg-brand hover:scale-110 shadow-lg shadow-brand/25 flex items-center justify-center text-black font-bold transition-all ${isCurrentPlaying ? 'opacity-0 group-hover/viewport:opacity-90' : 'opacity-90'}`}
                    >
                      {isCurrentPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
                    </button>
                  )}

                  {/* Fullscreen button */}
                  {currentMaterial.thumbnail && (
                    <button
                      onClick={() => {
                        const previewSrc = isVid
                          ? playableUrlForMaterial(currentMaterial)
                          : (currentMaterial.sourceUrl || currentMaterial.remoteUrl || (currentMaterial.localPath ? makeLocalFileUrl(currentMaterial.localPath) : '') || currentMaterial.thumbnail);
                        setFullscreenVideo({ src: previewSrc, mediaType: currentMaterial.mediaType || (isVideoUrl(previewSrc) ? 'video' : 'image') });
                      }}
                      className="absolute top-2 right-2 p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white/70 hover:text-white opacity-0 group-hover/viewport:opacity-100 transition-all"
                      title="放大预览"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Download button (video only, remote http) */}
                  {currentMaterial.thumbnail && isVid && /^https?:\/\//i.test(currentMaterial.thumbnail) && (
                    <button
                      onClick={() => handleDownloadVideo(currentMaterial.thumbnail, `${row.id}-${currentMaterial.name || 'video'}`)}
                      className="absolute top-2 right-10 p-1.5 rounded-md bg-black/60 hover:bg-brand text-white/70 hover:text-black opacity-0 group-hover/viewport:opacity-100 transition-all"
                      title="下载视频"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Timeline overlay footer (only when there's content) */}
                  {currentMaterial.thumbnail && (
                    isVid ? (
                      <div className="absolute bottom-0 inset-x-0 bg-black/60 p-2 border-t border-white/5 backdrop-blur-[2px] flex items-center justify-between text-[8px] text-dark-muted">
                        <span>{isCurrentPlaying ? '00:03' : '00:00'} / {currentMaterial.duration}</span>
                        <span>fps: {currentMaterial.fps}</span>
                      </div>
                    ) : (
                      <div className="absolute bottom-0 inset-x-0 bg-black/60 p-2 border-t border-white/5 backdrop-blur-[2px] flex items-center justify-center text-[8px] text-brand font-bold">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRenameCurrentMaterial(row.id);
                          }}
                          className="hover:text-brand-light max-w-full truncate"
                          title="点击修改素材名称"
                        >
                          {currentMaterial.name || '当前图片素材'}
                        </button>
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* COLUMN 3: Row Candidate Available Materials Grid (26% width) */}
              <div className="w-[26%] pl-4 flex flex-col justify-start">
                {/* Header row */}
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <div className="flex items-center space-x-1">
                    <span className="text-[10px] font-bold text-dark-muted">可选备选帧</span>
                    <span className="text-[9px] text-dark-subtle">({materials.length})</span>
                  </div>
                  {/* Clean local upload trigger on header */}
                  <button 
                    onClick={() => {
                      const name = prompt('请输入导入的本地素材名称:', `本地导入素材_${Date.now().toString().slice(-4)}.${isVid ? 'mp4' : 'jpg'}`);
                      if (name) {
                        const newMatId = Math.max(...materials.map(m => m.id)) + 1;
                        const newMat = {
                          id: newMatId,
                          name,
                          thumbnail: isVid ? 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&q=80&w=120' : 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&q=80&w=120',
                          status: 'new',
                          textStatus: isVid ? '+ 拖拽' : '原画',
                          mediaType: isVid ? 'video' : 'image'
                        };
                        setSegments(segments.map(s => {
                          if (s.id === row.id) {
                            return isVid 
                              ? { ...s, materialsVideo: [newMat, ...s.materialsVideo] }
                              : { ...s, materialsImage: [newMat, ...s.materialsImage] };
                          }
                          return s;
                        }));
                      }
                    }}
                    className="text-[9px] text-brand hover:text-brand-light font-bold bg-dark-card border border-dark-border hover:border-brand/40 px-1.5 py-0.5 rounded transition-all shrink-0"
                    title="导入本地文件"
                  >
                    + 导入
                  </button>
                </div>

                {/* Materials grid container - 2x2 forcing height */}
                <div className="grid grid-cols-2 gap-1.5 h-[156px] overflow-y-auto no-scrollbar pb-1 relative">
                  
                  {/* Candidates items in 2x2 grid */}
                  {materials.map((mat) => {
                    const matThumb = mat.thumbnail || '';
                    const curThumb = currentMaterial.thumbnail || '';
                    const isActive = !!matThumb && !!curThumb && curThumb.split('?')[0] === matThumb.split('?')[0];
                    const isVideoMat = mat.mediaType === 'video' || isVideoUrl(matThumb);
                    return (
                      <div 
                        key={mat.id}
                        draggable={!isVideoMat && !!matThumb}
                        onMouseEnter={() => prepareExternalImageDrag(mat)}
                        onMouseDown={() => prepareExternalImageDrag(mat)}
                        onDragStart={(e) => startExternalImageDrag(e, mat)}
                        onClick={() => handleSelectCandidateMaterial(row.id, mat)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (matThumb) setFullscreenVideo({ src: matThumb, mediaType: mat.mediaType || (isVideoUrl(matThumb) ? 'video' : 'image') });
                        }}
                        className={`relative rounded-lg border overflow-hidden h-[74px] cursor-pointer transition-all flex flex-col group/candidate ${
                          isActive 
                            ? 'border-brand bg-brand/5 shadow-[0_0_8px_rgba(16,185,129,0.15)]' 
                            : 'border-dark-border bg-dark-card/40 hover:bg-dark-card hover:border-dark-subtle'
                        }`}
                        title={isActive ? '当前已选中；双击放大预览，可拖出到其他软件' : '点击选为当前画面；双击放大预览，可拖出到其他软件'}
                      >
                        {/* Badges Overlay */}
                        <div className="absolute top-1 left-1 z-10 flex items-center justify-between w-[85%] pointer-events-none">
                          <span className="w-3.5 h-3.5 rounded bg-black/70 backdrop-blur-sm flex items-center justify-center text-[9px] font-bold text-white scale-90">
                            {mat.id}
                          </span>
                          {mat.status && (
                            <span className={`text-[7px] px-1 py-0.2 rounded font-semibold scale-90 ${
                              mat.status === 'new' 
                                ? 'bg-brand/20 text-brand border border-brand/30' 
                                : 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                            }`}>
                              {mat.textStatus}
                            </span>
                          )}
                        </div>

                        {/* Active checkmark badge */}
                        {isActive && (
                          <div className="absolute top-1 right-1 z-10 w-3.5 h-3.5 rounded-full bg-brand flex items-center justify-center pointer-events-none shadow">
                            <Check className="w-2.5 h-2.5 text-black" strokeWidth={3} />
                          </div>
                        )}

                        {/* Preview - video for mp4, image otherwise */}
                        {isVideoMat ? (
                          <>
                            <video
                              key={toPlayableUrl(matThumb)}
                              src={toPlayableUrl(matThumb)}
                              className="w-full h-full object-cover bg-zinc-950"
                              muted
                              playsInline
                              loop
                              preload="none"
                              onMouseEnter={(e) => { e.currentTarget.play().catch(()=>{}); }}
                              onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
                            />
                            <span className="absolute bottom-1 left-1 z-10 px-1 py-0.5 bg-black/70 text-white text-[8px] rounded font-bold scale-90 pointer-events-none">视频</span>
                          </>
                        ) : matThumb ? (
                          <img 
                            src={matThumb} 
                            alt={mat.name} 
                            className="w-full h-full object-cover" 
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-dark-subtle text-[8px]">无预览</div>
                        )}

                        {/* Label name Overlay on hover */}
                        <div className="absolute inset-x-0 bottom-0 bg-black/75 p-1 text-center scale-y-0 group-hover/candidate:scale-y-100 origin-bottom transition-transform duration-200">
                          <p className="text-[8px] text-white truncate pr-5">{mat.name}</p>
                        </div>

                        {/* Image to Video reference application hover button */}
                        {!isVid && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleConvertToVideoReference(row.id, mat);
                            }}
                            className="absolute bottom-1 left-1 opacity-0 group-hover/candidate:opacity-100 px-1.5 py-1 bg-black/85 hover:bg-brand border border-white/10 rounded text-[8px] font-bold text-dark-muted hover:text-black transition-all z-20 shadow-md flex items-center space-x-0.5"
                            title="一键转为视频垫图"
                          >
                            <span>转为视频垫图</span>
                          </button>
                        )}

                        {/* Floating Trash Delete Button on hover */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCandidate(row.id, mat.id);
                          }}
                          className="absolute bottom-1 right-1 opacity-0 group-hover/candidate:opacity-100 p-1 bg-black/75 hover:bg-red-500 border border-white/10 rounded text-dark-muted hover:text-white transition-all z-20 shadow-md"
                          title="删除备选帧"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    );
                  })}

                </div>
              </div>

            </div>
          );
        })}

        {/* Big Add Segment Row Action trigger at the bottom of the list */}
        <div className="p-6 flex justify-center">
          <button 
            type="button"
            onClick={handleAddNewSegmentRow}
            className="flex items-center space-x-2 px-8 py-3 bg-dark-card border border-dark-border hover:border-brand/40 text-xs text-dark-muted hover:text-white rounded-xl transition-all font-semibold"
          >
            <FolderPlus className="w-4 h-4 text-brand" />
            <span>新增一格分镜行 (每一行拥有独立素材预览与素材库)</span>
          </button>
        </div>
      </div>

      {/* 4. Batch Operations & Task settings Modal */}
      {showBatchModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-dark-sidebar border border-dark-border w-full max-w-2xl rounded-xl overflow-hidden shadow-2xl animate-in zoom-in duration-200">
            
            {/* Modal Header */}
            <div className="h-12 border-b border-dark-border px-5 flex items-center justify-between bg-dark-bg select-none">
              <div className="flex items-center space-x-2">
                <Settings className="w-4 h-4 text-brand animate-[spin_5s_infinite_linear]" />
                <span className="text-xs font-bold text-white">批量素材处理与多媒体导入中心</span>
              </div>
              <button 
                onClick={() => setShowBatchModal(false)}
                className="text-dark-muted hover:text-white text-xs transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Modal Scroll Body */}
            <div className="p-6 space-y-5 max-h-[380px] overflow-y-auto no-scrollbar">

              <div className="space-y-4 animate-in fade-in duration-200">
                <div className="border border-dashed border-dark-border hover:border-brand/40 bg-dark-bg/40 hover:bg-dark-bg/60 p-6 rounded-xl text-center cursor-pointer transition-all space-y-2 group" onClick={handleSelectBatchFolder}>
                  <div className="w-10 h-10 rounded-full border border-dark-border bg-dark-card flex items-center justify-center text-dark-muted mx-auto group-hover:text-brand group-hover:border-brand/30 transition-all">
                    <FolderOpen className="w-5 h-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-bold text-white group-hover:text-brand transition-colors">选择本地素材目录 或 拖入多个媒体文件</p>
                    <p className="text-[10px] text-dark-subtle leading-normal">
                      一键扫描并加载文件夹内的所有 `.mp4` 视频及 `.jpg / .png / .webp` 图片
                    </p>
                  </div>
                </div>

                {/* Selected files preview */}
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-dark-muted uppercase">待导入的媒体列表 ({batchFiles.length})</label>
                  <div className="border border-dark-border bg-dark-bg/30 rounded-xl divide-y divide-dark-border/30 max-h-[140px] overflow-y-auto no-scrollbar text-xs">
                    {batchFiles.map(f => (
                      <div key={f.id} className="p-2.5 flex items-center justify-between text-dark-text hover:bg-dark-card/20">
                        <div className="flex items-center space-x-2.5 min-w-0">
                          {f.type === 'video' ? <FileVideo className="w-4 h-4 text-blue-400 shrink-0" /> : <FileImage className="w-4 h-4 text-purple-400 shrink-0" />}
                          <span className="truncate max-w-[280px] text-white" title={f.name}>{f.name}</span>
                          <span className="text-[9px] text-dark-subtle font-mono truncate">{f.path}</span>
                        </div>
                        <div className="flex items-center space-x-2 text-[10px] shrink-0">
                          <span className="text-dark-muted">{f.size}</span>
                          {f.appliedAsRef && <span className="text-brand bg-brand/10 border border-brand/20 px-1 py-0.2 rounded font-bold scale-90">已转垫图</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <button 
                  type="button"
                  onClick={handleRunBatchImport}
                  className="w-full flex items-center justify-center space-x-1.5 py-2.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-md"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>一键批量导入候选媒体库 (按视频/图片分镜类型智能匹配)</span>
                </button>
              </div>

            </div>

            {/* Modal Footer */}
            <div className="h-12 border-t border-dark-border px-5 flex items-center justify-end bg-dark-bg select-none shrink-0">
              <button 
                onClick={() => setShowBatchModal(false)}
                className="px-5 py-1.5 bg-dark-card hover:bg-dark-cardHover border border-dark-border text-white text-xs font-bold rounded-lg transition-colors"
              >
                关闭窗口
              </button>
            </div>

          </div>
        </div>
      )}

      {/* 5. Character特征资产管理器 Sub-Window Modal matching screenshot */}
      {showCharacterModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] select-none">
          {/* Floating Sub-Window Card */}
          <div className="w-[640px] h-[460px] bg-[#1a1b1f] border border-dark-border/80 rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.7)] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            
            {/* Titlebar matching native title bar frame */}
            <div className="h-10 bg-[#111214] border-b border-dark-border px-4 flex items-center justify-between shrink-0">
              <div className="flex items-center space-x-2">
                <span className="w-2.5 h-2.5 rounded-full bg-brand animate-pulse" />
                <span className="text-xs font-bold text-dark-text">角色特征资产管理器 (特征垫图与关联中心)</span>
              </div>
              <button 
                onClick={() => setShowCharacterModal(false)}
                className="text-dark-muted hover:text-white text-base hover:bg-white/10 w-6 h-6 rounded flex items-center justify-center transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">
              
              {/* Left List Pane: All Current Characters */}
              <div className="w-[200px] border-r border-dark-border/40 bg-[#15161a] p-3 flex flex-col justify-between overflow-y-auto no-scrollbar shrink-0">
                <div className="space-y-1.5 flex-1 flex flex-col min-h-0">
                  <div className="text-[10px] text-dark-muted font-bold px-1 uppercase tracking-wider">当前角色资产 ({characterAssets.length})</div>
                  <div className="space-y-1 mt-2 flex-1 overflow-y-auto no-scrollbar">
                    {characterAssets.map((char) => {
                      const isActive = editingCharId === char.id;
                      return (
                        <div
                          key={char.id}
                          onClick={() => {
                            setEditingCharId(char.id);
                            setNewCharName(char.name);
                            setNewCharRole(char.role || '');
                            setNewCharAvatar(char.avatar);
                            setNewCharAvatarPath(char.avatarPath || '');
                          }}
                          className={`flex items-center space-x-2.5 p-2 rounded-lg cursor-pointer transition-all border ${
                            isActive ? 'bg-[#323338]/30 border-[#10b981]/40 text-brand' : 'hover:bg-[#1c1d22]/40 border-transparent text-dark-text'
                          }`}
                        >
                          <img src={char.avatar} alt={char.name} className="w-7 h-7 rounded-full object-cover border border-dark-border/20 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold truncate">{char.name}</div>
                            <div className="text-[9px] text-dark-subtle truncate">{char.role || '无标签'}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setEditingCharId('new');
                    setNewCharName('');
                    setNewCharRole('主角设定');
                    setNewCharAvatar('https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=260');
                    setNewCharAvatarPath('');
                  }}
                  className="w-full py-1.5 rounded-lg bg-dark-card border border-dashed border-dark-border hover:border-brand/40 text-xs font-bold text-dark-muted hover:text-brand transition-colors flex items-center justify-center space-x-1 mt-3 shrink-0"
                >
                  <span>+ 新增角色特征</span>
                </button>
              </div>

              {/* Right Detail Pane: Edit/Create Character */}
              <div className="flex-1 p-5 flex flex-col justify-between bg-[#1e1f24]/30 overflow-y-auto no-scrollbar">
                <div className="space-y-4">
                  <div className="text-[10px] text-dark-muted font-bold uppercase tracking-wider">
                    {editingCharId === 'new' ? '✨ 新增角色特征资产' : '📝 编辑角色特征资产'}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Avatar Selector Slot with Upload matching description */}
                    <div className="space-y-1.5 flex flex-col items-center">
                      <label className="text-[10px] text-dark-muted self-start font-bold">角色图片/特征头像</label>
                      <div className="w-32 h-32 relative rounded-xl border border-dashed border-dark-border/80 hover:border-brand/40 bg-dark-input/20 flex flex-col items-center justify-center overflow-hidden cursor-pointer group transition-colors shrink-0">
                        {newCharAvatar ? (
                          <div className="w-full h-full relative">
                            <img src={newCharAvatar} alt="upload preview" className="w-full h-full object-cover" />
                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center space-y-1 text-[9px] text-white transition-opacity">
                              <span>更换本地图片</span>
                              <span className="text-[7px] text-dark-subtle">点击选择文件</span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center text-center p-2 text-dark-subtle">
                            <Plus className="w-6 h-6 text-dark-muted group-hover:text-brand" />
                            <span className="text-[9px] mt-1">本地图片</span>
                          </div>
                        )}
                        {/* Invisible HTML File input */}
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleLocalAvatarUpload}
                          className="absolute inset-0 opacity-0 cursor-pointer z-10"
                        />
                      </div>
                      <div className="text-[8px] text-dark-subtle mt-1 text-center leading-tight">
                        支持 PNG, JPG, WebP 格式<br />点击自动导入本地特征图
                      </div>
                    </div>

                    {/* Form inputs */}
                    <div className="space-y-3.5 flex flex-col justify-center">
                      <div className="space-y-1">
                        <label className="text-[10px] text-dark-muted font-bold">角色名称 (@触发名称)</label>
                        <input
                          type="text"
                          value={newCharName}
                          onChange={(e) => setNewCharName(e.target.value)}
                          placeholder="例如: 娘, 爹爹, 林涵"
                          className="w-full bg-[#18191c] border border-dark-border rounded-lg px-2.5 py-1.5 text-xs text-dark-text placeholder-dark-subtle focus:border-brand/50 focus:ring-0 outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-dark-muted font-bold">角色特征标签/设定</label>
                        <input
                          type="text"
                          value={newCharRole}
                          onChange={(e) => setNewCharRole(e.target.value)}
                          placeholder="例如: 主角设定, 爹爹/夏志"
                          className="w-full bg-[#18191c] border border-dark-border rounded-lg px-2.5 py-1.5 text-xs text-dark-text placeholder-dark-subtle focus:border-brand/50 focus:ring-0 outline-none"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center justify-end space-x-2 border-t border-dark-border/20 pt-3 mt-4 shrink-0">
                  {editingCharId !== 'new' && (
                    <button
                      type="button"
                      onClick={handleDeleteCharacter}
                      className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all text-xs font-bold mr-auto"
                    >
                      删除角色
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowCharacterModal(false)}
                    className="px-4 py-1.5 rounded-lg bg-[#222328] border border-dark-border text-xs font-bold text-dark-text hover:bg-[#2d2e33] transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveCharacter}
                    className="px-4 py-1.5 rounded-lg bg-brand text-xs font-bold text-black hover:bg-brand/90 transition-colors shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                  >
                    保存资产
                  </button>
                </div>

              </div>

            </div>

          </div>
        </div>
      )}

      {/* Fullscreen Video/Image Preview Modal */}
      {fullscreenVideo && (
        <div 
          className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center backdrop-blur-sm"
          onClick={() => setFullscreenVideo(null)}
        >
          <button
            onClick={() => setFullscreenVideo(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          {!(fullscreenVideo.mediaType === 'video' || isVideoUrl(fullscreenVideo.src)) && (
            <button
              onClick={(e) => { e.stopPropagation(); copyImageToClipboard(fullscreenVideo.src); }}
              className="absolute top-4 right-16 flex items-center space-x-1.5 px-3 py-2 rounded-full bg-brand hover:bg-brand-dark text-black font-bold text-xs transition-colors"
              title="复制图片到剪贴板"
            >
              <Copy className="w-4 h-4" />
              <span>复制图片</span>
            </button>
          )}
          {(fullscreenVideo.mediaType === 'video' || isVideoUrl(fullscreenVideo.src)) && /^https?:\/\//i.test(fullscreenVideo.src) && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDownloadVideo(fullscreenVideo.src, 'video'); }}
              className="absolute top-4 right-16 flex items-center space-x-1.5 px-3 py-2 rounded-full bg-brand hover:bg-brand-dark text-black font-bold text-xs transition-colors"
              title="下载视频"
            >
              <Download className="w-4 h-4" />
              <span>下载</span>
            </button>
          )}
          <div className="max-w-[90vw] max-h-[90vh] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            {fullscreenVideo.mediaType === 'video' || isVideoUrl(fullscreenVideo.src) ? (
              <video
                key={toPlayableUrl(fullscreenVideo.src)}
                src={toPlayableUrl(fullscreenVideo.src)}
                className="max-w-full max-h-[85vh] rounded-lg shadow-2xl"
                controls
                autoPlay
                loop
              />
            ) : (
              <img
                src={fullscreenVideo.src}
                alt="preview"
                className="max-w-full max-h-[85vh] rounded-lg shadow-2xl object-contain"
              />
            )}
          </div>
        </div>
      )}

      <ImageMergeModal
        open={mergeModalState.open}
        initialItems={mergeModalState.items}
        title={`合并图片${mergeModalState.rowId ? ` · 第 ${mergeModalState.rowId} 行` : ''}`}
        onClose={() => setMergeModalState({ open: false, rowId: null, items: [] })}
        onApplyAsReference={mergeModalState.rowId ? (filePath) => applyMergedImageToRow(mergeModalState.rowId, filePath) : undefined}
      />

    </div>
  );
}
