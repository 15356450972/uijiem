import React, { useState } from 'react';
import { 
  FolderHeart, 
  Search, 
  Plus, 
  Trash2, 
  Play, 
  Image as ImageIcon, 
  Music, 
  FileVideo, 
  FolderOpen 
} from 'lucide-react';

export default function AssetsManager() {
  const [activeAssetTab, setActiveAssetTab] = useState('video'); // video, audio, image
  const [assets, setAssets] = useState([
    { id: '1', title: '东方皇后回廊走步_1080p.mp4', type: 'video', size: '24.5 MB', duration: '00:15', thumbnail: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&q=80&w=120' },
    { id: '2', title: '古风唯美管弦背景配乐 - 寒宫秋.mp3', type: 'audio', size: '3.8 MB', duration: '02:30', thumbnail: null },
    { id: '3', title: '江南雨夜环境环境音.mp3', type: 'audio', size: '5.2 MB', duration: '01:45', thumbnail: null },
    { id: '4', title: '赤金累丝凤钗概念设计.png', type: 'image', size: '1.2 MB', duration: null, thumbnail: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&q=80&w=120' },
    { id: '5', title: '宫殿牌匾正门远景图.jpg', type: 'image', size: '890 KB', duration: null, thumbnail: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&q=80&w=120' },
    { id: '6', title: '江南雨巷运镜_2K_raw.mp4', type: 'video', size: '84.1 MB', duration: '00:08', thumbnail: 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&q=80&w=120' },
  ]);

  const handleDeleteAsset = (id) => {
    if (confirm('确定要删除这个资产素材吗？删除后，使用它的视频草稿可能需要重新添加。')) {
      setAssets(assets.filter(a => a.id !== id));
    }
  };

  const handleAddLocalAsset = () => {
    const title = prompt('请输入添加的素材名称:', '本地素材文件.mp4');
    if (!title) return;

    const ext = title.split('.').pop().toLowerCase();
    let type = 'video';
    if (['mp3', 'wav', 'aac'].includes(ext)) type = 'audio';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) type = 'image';

    const newAsset = {
      id: String(Date.now()),
      title,
      type,
      size: '12.4 MB',
      duration: type === 'audio' || type === 'video' ? '00:10' : null,
      thumbnail: type === 'image' || type === 'video' ? 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&q=80&w=120' : null
    };

    setAssets([newAsset, ...assets]);
  };

  const filteredAssets = assets.filter(a => a.type === activeAssetTab);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-dark-bg/20">
      {/* Assets Toolbar */}
      <div className="h-14 border-b border-dark-border px-6 flex items-center justify-between shrink-0 bg-dark-bg/40">
        <div className="flex items-center space-x-2">
          <FolderHeart className="w-4 h-4 text-brand" />
          <span className="text-sm font-bold text-white">我的资产库</span>
          <span className="text-[10px] bg-dark-border text-dark-muted px-2 py-0.5 rounded">
            总文件: {assets.length}
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {/* Tabs selectors */}
          <div className="flex bg-dark-input border border-dark-border rounded-lg p-0.5 text-xs mr-2">
            <button 
              onClick={() => setActiveAssetTab('video')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md font-semibold transition-all ${
                activeAssetTab === 'video' ? 'bg-brand text-black font-bold shadow-md' : 'text-dark-muted hover:text-white'
              }`}
            >
              <FileVideo className="w-3.5 h-3.5" />
              <span>视频 ({assets.filter(a => a.type === 'video').length})</span>
            </button>
            <button 
              onClick={() => setActiveAssetTab('audio')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md font-semibold transition-all ${
                activeAssetTab === 'audio' ? 'bg-brand text-black font-bold shadow-md' : 'text-dark-muted hover:text-white'
              }`}
            >
              <Music className="w-3.5 h-3.5" />
              <span>音频 ({assets.filter(a => a.type === 'audio').length})</span>
            </button>
            <button 
              onClick={() => setActiveAssetTab('image')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md font-semibold transition-all ${
                activeAssetTab === 'image' ? 'bg-brand text-black font-bold shadow-md' : 'text-dark-muted hover:text-white'
              }`}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              <span>图片 ({assets.filter(a => a.type === 'image').length})</span>
            </button>
          </div>

          <button 
            onClick={handleAddLocalAsset}
            className="flex items-center space-x-1.5 px-4 py-1.5 bg-brand hover:bg-brand-dark rounded-lg text-xs text-black font-bold transition-all shadow-lg"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>本地添加</span>
          </button>
        </div>
      </div>

      {/* Assets Listing */}
      <div className="flex-1 overflow-y-auto p-6 no-scrollbar">
        {filteredAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center text-dark-muted">
            <FolderOpen className="w-12 h-12 stroke-[1.5] mb-2.5 opacity-40 text-brand" />
            <p className="text-xs font-bold text-white">暂无相关资产素材</p>
            <p className="text-[10px] text-dark-subtle mt-1">您可以点击右上角“本地添加”按钮上传您的素材</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filteredAssets.map(asset => (
              <div 
                key={asset.id}
                className="bg-dark-card border border-dark-border/60 hover:border-brand/40 hover:bg-dark-cardHover rounded-xl overflow-hidden flex flex-col justify-between aspect-square relative group"
              >
                {/* Visual Preview / Thumbnail for video & image */}
                <div className="flex-1 bg-black/40 flex items-center justify-center relative overflow-hidden">
                  {asset.thumbnail ? (
                    <img src={asset.thumbnail} alt={asset.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  ) : (
                    <div className="w-full h-full bg-dark-sidebar flex flex-col items-center justify-center text-dark-subtle group-hover:bg-dark-card transition-colors">
                      <Music className="w-8 h-8 text-brand/60" />
                      <span className="text-[9px] mt-1.5">MP3 音频格式</span>
                    </div>
                  )}

                  {/* Play Action indicator overlay */}
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2">
                    {(asset.type === 'video' || asset.type === 'audio') && (
                      <button 
                        onClick={() => alert(`正在播放预览: ${asset.title}`)}
                        className="p-2 bg-brand text-black rounded-full hover:scale-110 transition-transform"
                      >
                        <Play className="w-4 h-4 fill-current ml-0.5" />
                      </button>
                    )}
                    <button 
                      onClick={() => handleDeleteAsset(asset.id)}
                      className="p-2 bg-dark-bg border border-dark-border text-red-400 rounded-full hover:bg-red-500/20 hover:scale-110 transition-all"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Footer details */}
                <div className="p-3 bg-dark-card border-t border-dark-border/40 space-y-1.5 shrink-0">
                  <h4 className="text-[11px] font-bold text-white truncate" title={asset.title}>
                    {asset.title}
                  </h4>
                  <div className="flex items-center justify-between text-[10px] text-dark-muted">
                    <span>{asset.size}</span>
                    {asset.duration && <span className="font-semibold text-brand">{asset.duration}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
