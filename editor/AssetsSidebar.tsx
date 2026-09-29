import React, {useRef, useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';
import {placeClips, clipDurationSec} from '../src/timeline';
import {IconButton} from './IconButton';

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

// Left "Assets" panel: source video clips (thumbnails) + audio.
export const AssetsSidebar: React.FC<{playerRef: React.RefObject<PlayerRef | null>}> = ({playerRef}) => {
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
      aria-label="Assets"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`w-64 bg-surface-container-low border-r flex flex-col h-full shrink-0 relative ${dragOver ? 'border-primary' : 'border-outline-variant'}`}
    >
      <input ref={clipInput} type="file" accept="video/*" multiple onChange={onPickClips} className="hidden" aria-label="Choose video clips" />
      <div className="p-4 border-b border-outline-variant flex justify-between items-center">
        <h2 className="text-label-bold font-label-bold uppercase tracking-wider text-on-surface-variant">Assets</h2>
        <IconButton icon="add_circle" size={20} label="Add video clips" onClick={() => clipInput.current?.click()} className="text-primary hover:brightness-125" />
      </div>

      {/* import progress — announced */}
      <div role="status" aria-live="polite" className={importing ? 'px-4 py-2 text-[11px] text-primary border-b border-outline-variant/30 flex items-center gap-2' : 'sr-only'}>
        {importing && <span aria-hidden="true" className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>}
        <span className="truncate">{importing ?? ''}</span>
      </div>
      {dragOver && (
        <div aria-hidden="true" className="absolute inset-0 bg-primary-container/20 border-2 border-dashed border-primary z-20 flex items-center justify-center pointer-events-none">
          <span className="text-primary font-bold text-body-md">Drop videos to import</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {/* Video clips */}
        <section aria-labelledby="assets-clips-heading">
          <div className="flex items-center justify-between mb-3">
            <h3 id="assets-clips-heading" className="text-label-bold font-label-bold text-on-surface-variant uppercase tracking-wider">Video clips</h3>
            <IconButton icon="add" size={16} label="Add video clips" onClick={() => clipInput.current?.click()} className="text-on-surface-variant hover:text-primary" />
          </div>
          <div className="grid grid-cols-1 gap-2">
            {placed.map(({clip, startMs}) => {
              const sel = clip.id === selectedClipId;
              const name = clip.label ?? clip.id;
              return (
                <button
                  key={clip.id}
                  type="button"
                  aria-label={`${name}, ${fmt(clipDurationSec(clip))}`}
                  aria-pressed={sel}
                  onClick={() => { selectClip(clip.id); seekToClip(startMs); }}
                  className={`group relative rounded-lg overflow-hidden border text-left transition-all ${
                    sel ? 'border-primary' : 'border-transparent hover:border-primary/60'
                  }`}
                >
                  <img
                    // thumbs exist per SOURCE file — autocut/split segments share it
                    src={'/clips/thumbs/' + (clip.src.split('/').pop() ?? '').replace(/\.\w+$/, '.jpg')}
                    alt=""
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
            {!clips.length && <p className="text-body-sm text-on-surface-variant/75">No clips loaded.</p>}
          </div>
        </section>

        {/* Audio */}
        <section aria-labelledby="assets-audio-heading">
          <h3 id="assets-audio-heading" className="text-label-bold font-label-bold mb-3 text-on-surface-variant uppercase tracking-wider">Audio</h3>
          <input ref={musicInput} type="file" accept="audio/*" onChange={onPickMusic} className="hidden" aria-label="Choose a music file" />
          {music ? (
            <div className="bg-surface-variant/30 p-2 rounded flex items-center gap-3 border border-outline-variant/30">
              <span aria-hidden="true" className="material-symbols-outlined text-secondary">audiotrack</span>
              <div className="flex-1 min-w-0">
                <p className="text-body-sm font-medium truncate">{music.src.split('/').pop()}</p>
                <p className="text-[10px] text-on-surface-variant font-mono">vol {Math.round(music.volume * 100)}%</p>
              </div>
              <IconButton icon="close" label="Remove music" onClick={() => setMusic(null)} className="text-on-surface-variant hover:text-error" />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => musicInput.current?.click()}
              className="w-full bg-surface-variant/20 p-2 rounded flex items-center gap-3 border border-dashed border-outline-variant/40 hover:border-primary-container transition-colors text-on-surface-variant"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-secondary">library_music</span>
              <span className="text-body-sm">Add music…</span>
            </button>
          )}
        </section>

        {/* B-roll assets (own footage/photos for the generator to pick from) */}
        <section aria-labelledby="assets-broll-heading">
          <div className="flex items-center justify-between mb-3">
            <h3 id="assets-broll-heading" className="text-label-bold font-label-bold text-on-surface-variant uppercase tracking-wider">B-roll assets</h3>
            <IconButton icon="add" size={16} label="Add your own B-roll footage or photos" onClick={() => brollInput.current?.click()} className="text-on-surface-variant hover:text-primary" />
          </div>
          <input ref={brollInput} type="file" accept="video/*,image/*" multiple onChange={onPickBroll} className="hidden" aria-label="Choose B-roll footage or photos" />
          <p role="status" aria-live="polite" className={brollBusy ? 'text-[11px] text-primary mb-2 truncate' : 'sr-only'}>{brollBusy ?? ''}</p>
          {brollAssets.length ? (
            <ul className="grid grid-cols-3 gap-2 list-none m-0 p-0">
              {brollAssets.map((a) => (
                <li key={a.id} className="group relative rounded-lg overflow-hidden border border-outline-variant/40">
                  <img src={a.thumb || '/' + a.src} alt={`${a.label} (${a.kind})`} className="aspect-video object-cover w-full" />
                  <span aria-hidden="true" className="absolute bottom-0.5 left-0.5 material-symbols-outlined text-[12px] text-white/90 drop-shadow">{a.kind === 'video' ? 'movie' : 'image'}</span>
                  <IconButton
                    icon="close"
                    size={14}
                    label={`Remove ${a.label}`}
                    onClick={() => removeBrollAsset(a.id)}
                    className="absolute top-0.5 right-0.5 w-5 h-5 rounded bg-surface-container-lowest/80 text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <button type="button" onClick={() => brollInput.current?.click()} className="w-full bg-surface-variant/20 p-2 rounded flex items-center gap-2 border border-dashed border-outline-variant/40 hover:border-primary-container text-on-surface-variant text-body-sm">
              <span aria-hidden="true" className="material-symbols-outlined text-secondary text-[18px]">perm_media</span>
              Add your footage…
            </button>
          )}
          <p className="text-[10px] text-on-surface-variant/75 mt-2">Auto B-roll prefers these; falls back to Pexels.</p>
        </section>
      </div>
    </aside>
  );
};
