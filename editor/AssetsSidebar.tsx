import React, {useRef, useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';
import {placeClips, clipDurationSec} from '../src/timeline';

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

// Left "Assets" panel: source video clips (thumbnails) + audio.
export const AssetsSidebar: React.FC<{playerRef: React.RefObject<PlayerRef>}> = ({playerRef}) => {
  const {meta, clips, music, brollAssets, selectedClipId, selectClip, setMusic, addClip, addBrollAsset, removeBrollAsset} = useEditor();
  const musicInput = useRef<HTMLInputElement>(null);
  const clipInput = useRef<HTMLInputElement>(null);
  const brollInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [brollBusy, setBrollBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  if (!meta) return null;
  const placed = placeClips(clips, meta.fps);

  const seekToClip = (startMs: number) => playerRef.current?.seekTo(Math.round((startMs / 1000) * meta.fps) + 1);

  // upload videos → backend remuxes/encodes + thumbnails → append to timeline
  const importFiles = async (files: File[]) => {
    const vids = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
    for (let i = 0; i < vids.length; i++) {
      setImporting(`Importing ${vids[i].name} (${i + 1}/${vids.length})…`);
      try {
        const clip = await fetch('/api/add-clip?name=' + encodeURIComponent(vids[i].name), {method: 'POST', body: vids[i]}).then((r) => r.json());
        if (clip?.id) addClip(clip);
      } catch {
        /* skip a failed file, keep going */
      }
    }
    setImporting(null);
  };

  const onPickClips = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) importFiles(files);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) importFiles(files);
  };

  // upload own B-roll source footage/photos (pool the generator can pick from)
  const onPickBroll = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const kind = f.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|heic)$/i.test(f.name) ? 'image' : 'video';
      setBrollBusy(`Adding ${f.name} (${i + 1}/${files.length})…`);
      try {
        const a = await fetch(`/api/add-broll-asset?name=${encodeURIComponent(f.name)}&kind=${kind}`, {method: 'POST', body: f}).then((r) => r.json());
        if (a?.id) addBrollAsset(a);
      } catch {
        /* skip */
      }
    }
    setBrollBusy(null);
  };

  const onPickMusic = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const r = await fetch('/api/music?name=' + encodeURIComponent(file.name), {method: 'POST', body: file}).then((x) => x.json());
    if (r.src) setMusic({src: r.src, volume: 0.8, startSec: 0, fadeOutSec: 1.5});
  };

  return (
    <aside
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`w-64 bg-surface-container-low border-r flex flex-col h-full shrink-0 relative ${dragOver ? 'border-primary' : 'border-outline-variant'}`}
    >
      <input ref={clipInput} type="file" accept="video/*" multiple onChange={onPickClips} className="hidden" />
      <div className="p-4 border-b border-outline-variant flex justify-between items-center">
        <span className="text-label-bold font-label-bold uppercase tracking-wider text-on-surface-variant">Assets</span>
        <button onClick={() => clipInput.current?.click()} title="Add video clips" className="text-primary material-symbols-outlined text-[20px] hover:brightness-125">
          add_circle
        </button>
      </div>

      {importing && (
        <div className="px-4 py-2 text-[11px] text-primary border-b border-outline-variant/30 flex items-center gap-2">
          <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
          <span className="truncate">{importing}</span>
        </div>
      )}
      {dragOver && (
        <div className="absolute inset-0 bg-primary-container/20 border-2 border-dashed border-primary z-20 flex items-center justify-center pointer-events-none">
          <span className="text-primary font-bold text-body-md">Drop videos to import</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {/* Video clips */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-label-bold font-label-bold text-on-surface-variant uppercase tracking-wider">Video clips</h3>
            <button onClick={() => clipInput.current?.click()} title="Add video clips" className="material-symbols-outlined text-[16px] text-on-surface-variant hover:text-primary">
              add
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2">
            {placed.map(({clip, startMs}) => {
              const sel = clip.id === selectedClipId;
              return (
                <button
                  key={clip.id}
                  onClick={() => { selectClip(clip.id); seekToClip(startMs); }}
                  className={`group relative rounded-lg overflow-hidden border text-left transition-all ${
                    sel ? 'border-primary' : 'border-transparent hover:border-primary/60'
                  }`}
                >
                  <img
                    // thumbs exist per SOURCE file — autocut/split segments share it
                    src={'/clips/thumbs/' + (clip.src.split('/').pop() ?? '').replace(/\.\w+$/, '.jpg')}
                    alt={clip.id}
                    className="aspect-video object-cover w-full opacity-80 group-hover:opacity-100 transition-opacity"
                  />
                  <span className="absolute bottom-1 right-1 bg-surface-container/80 text-[10px] px-1 rounded font-mono text-on-surface">
                    {fmt(clipDurationSec(clip))}
                  </span>
                  {clip.label && (
                    <span className="absolute bottom-1 left-1 right-10 bg-surface-container/70 text-[9px] px-1 rounded truncate text-on-surface-variant">
                      {clip.label}
                    </span>
                  )}
                </button>
              );
            })}
            {!clips.length && <p className="text-body-sm text-on-surface-variant/50">No clips loaded.</p>}
          </div>
        </section>

        {/* Audio */}
        <section>
          <h3 className="text-label-bold font-label-bold mb-3 text-on-surface-variant uppercase tracking-wider">Audio</h3>
          <input ref={musicInput} type="file" accept="audio/*" onChange={onPickMusic} className="hidden" />
          {music ? (
            <div className="bg-surface-variant/30 p-2 rounded flex items-center gap-3 border border-outline-variant/30">
              <span className="material-symbols-outlined text-secondary">audiotrack</span>
              <div className="flex-1 min-w-0">
                <p className="text-body-sm font-medium truncate">{music.src.split('/').pop()}</p>
                <p className="text-[10px] text-on-surface-variant font-mono">vol {Math.round(music.volume * 100)}%</p>
              </div>
              <button onClick={() => setMusic(null)} title="Remove music" className="material-symbols-outlined text-[18px] text-on-surface-variant hover:text-error">
                close
              </button>
            </div>
          ) : (
            <button
              onClick={() => musicInput.current?.click()}
              className="w-full bg-surface-variant/20 p-2 rounded flex items-center gap-3 border border-dashed border-outline-variant/40 hover:border-primary-container transition-colors text-on-surface-variant"
            >
              <span className="material-symbols-outlined text-secondary">library_music</span>
              <span className="text-body-sm">Add music…</span>
            </button>
          )}
        </section>

        {/* B-roll assets (own footage/photos for the generator to pick from) */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-label-bold font-label-bold text-on-surface-variant uppercase tracking-wider">B-roll assets</h3>
            <button onClick={() => brollInput.current?.click()} title="Add your own B-roll footage/photos" className="material-symbols-outlined text-[16px] text-on-surface-variant hover:text-primary">add</button>
          </div>
          <input ref={brollInput} type="file" accept="video/*,image/*" multiple onChange={onPickBroll} className="hidden" />
          {brollBusy && <p className="text-[11px] text-primary mb-2 truncate">{brollBusy}</p>}
          {brollAssets.length ? (
            <div className="grid grid-cols-3 gap-2">
              {brollAssets.map((a) => (
                <div key={a.id} className="group relative rounded-lg overflow-hidden border border-outline-variant/40">
                  <img src={a.thumb || '/' + a.src} alt={a.label} className="aspect-video object-cover w-full" />
                  <span className="absolute bottom-0.5 left-0.5 material-symbols-outlined text-[12px] text-white/90 drop-shadow">{a.kind === 'video' ? 'movie' : 'image'}</span>
                  <button onClick={() => removeBrollAsset(a.id)} title="Remove" className="absolute top-0.5 right-0.5 w-5 h-5 rounded bg-surface-container-lowest/80 text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 flex items-center justify-center">
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <button onClick={() => brollInput.current?.click()} className="w-full bg-surface-variant/20 p-2 rounded flex items-center gap-2 border border-dashed border-outline-variant/40 hover:border-primary-container text-on-surface-variant text-body-sm">
              <span className="material-symbols-outlined text-secondary text-[18px]">perm_media</span>
              Add your footage…
            </button>
          )}
          <p className="text-[10px] text-on-surface-variant/50 mt-2">Auto B-roll prefers these; falls back to Pexels.</p>
        </section>
      </div>
    </aside>
  );
};
