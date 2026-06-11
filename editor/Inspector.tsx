import React, {useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import {useEditor} from './store';
import {clipDurationSec} from '../src/timeline';
import {projectCaptions} from '../src/captions';
import {projectBrolls} from '../src/Broll';

type Tab = 'Captions' | 'B-roll' | 'Styles' | 'Settings';

const ACCENT_SWATCHES = ['#FFB020', '#c2c1ff', '#ffb785', '#adc6ff', '#39d98a', '#ff6b8b'];

// Right "Inspector" panel: tabbed (Captions / B-roll / Styles / Settings), context-aware.
export const Inspector: React.FC<{
  playerRef: React.RefObject<PlayerRef>;
  onGenerate: () => void;
  generating?: boolean;
  progressLabel?: string;
  onGenerateBroll: () => void;
  brollGenerating?: boolean;
  brollLabel?: string;
}> = ({playerRef, onGenerate, generating, progressLabel, onGenerateBroll, brollGenerating, brollLabel}) => {
  const {
    meta, captions, clips, music, brolls, accentColor, selectedId, selectedClipId,
    select, selectClip, setText, setTopPct, toggleAccent, pushHistory,
    deleteClip, moveClip, setMusic, setAccentColor, setBrollMode, swapBroll, removeBroll,
    setClipVolume, toggleClipMute, setClipSpeed,
  } = useEditor();
  const [tab, setTab] = useState<Tab>('Captions');
  if (!meta) return null;

  // captions + b-roll are clip-anchored → project for display (absolute times + order)
  const projCaps = projectCaptions(captions, clips, meta.fps);
  const projBrolls = projectBrolls(brolls, clips, meta.fps);
  const selClip = clips.find((c) => c.id === selectedClipId);
  const seekMs = (ms: number) => playerRef.current?.seekTo(Math.round((ms / 1000) * meta.fps));

  return (
    <aside className="w-80 bg-surface-container-high border-l border-outline-variant flex flex-col h-full shrink-0">
      <div className="p-panel-padding pb-0">
        <h2 className="text-headline-md font-headline-md text-on-surface">Inspector</h2>
        <p className="text-body-sm text-on-surface-variant mb-4">Properties</p>
        <div className="flex border-b border-outline-variant">
          {(['Captions', 'B-roll', 'Styles', 'Settings'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 pb-2 text-[10px] font-label-bold uppercase tracking-wide border-b-2 transition-colors ${
                tab === t ? 'border-primary text-on-primary-container' : 'border-transparent text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-panel-padding">
        {tab === 'Captions' && (
          <>
            <button
              onClick={onGenerate}
              disabled={generating || !clips.length}
              className="w-full py-3 bg-primary-container text-on-primary-container rounded-lg font-bold text-body-md hover:brightness-110 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            >
              <span className={`material-symbols-outlined text-[20px] ${generating ? 'animate-spin' : ''}`}>{generating ? 'progress_activity' : 'auto_awesome'}</span>
              {generating ? 'Generating…' : 'Generate AI Captions'}
            </button>
            {generating && <p className="text-[11px] text-on-surface-variant mt-2 mb-3 truncate">{progressLabel}</p>}
            <div className="mb-5" />

            {/* selected clip card */}
            {selClip && (
              <div className="mb-5 p-3 rounded-lg bg-surface-variant/40 border border-primary/30">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-label-bold font-label-bold uppercase text-primary">Clip</span>
                  <div className="flex gap-1">
                    <IconBtn icon="chevron_left" title="Move left" onClick={() => moveClip(selClip.id, -1)} />
                    <IconBtn icon="chevron_right" title="Move right" onClick={() => moveClip(selClip.id, 1)} />
                    <IconBtn icon="delete" title="Delete take" danger onClick={() => { deleteClip(selClip.id); selectClip(null); }} />
                  </div>
                </div>
                <p className="text-body-sm text-on-surface truncate mb-2">{selClip.label ?? selClip.id}</p>
                <Row k="In" v={`${selClip.inSec.toFixed(2)}s`} />
                <Row k="Out" v={`${selClip.outSec.toFixed(2)}s`} />
                <Row k="Duration" v={`${clipDurationSec(selClip).toFixed(2)}s`} />

                {/* playback speed */}
                <label className="text-[11px] text-on-surface-variant block mt-3">Speed: {(selClip.speed ?? 1).toFixed(2)}×</label>
                <div className="flex items-center gap-1 mt-1">
                  {[0.5, 1, 1.5, 2].map((sp) => (
                    <button
                      key={sp}
                      onClick={() => { pushHistory(); setClipSpeed(selClip.id, sp); }}
                      className={`flex-1 py-1 text-[11px] rounded border ${
                        Math.abs((selClip.speed ?? 1) - sp) < 0.01 ? 'border-primary text-primary bg-primary-container/20' : 'border-outline-variant/40 text-on-surface-variant'
                      }`}
                    >
                      {sp}×
                    </button>
                  ))}
                </div>
                <input
                  type="range" min={25} max={400} step={5} value={Math.round((selClip.speed ?? 1) * 100)}
                  onPointerDown={pushHistory}
                  onChange={(e) => setClipSpeed(selClip.id, Number(e.target.value) / 100)}
                  className="w-full mt-1 accent-primary"
                />

                {/* clip audio */}
                <div className="flex items-center justify-between mt-3 mb-1">
                  <label className="text-[11px] text-on-surface-variant">
                    Volume: {selClip.muted ? 'muted' : `${Math.round((selClip.volume ?? 1) * 100)}%`}
                  </label>
                  <button
                    onClick={() => toggleClipMute(selClip.id)}
                    title={selClip.muted ? 'Unmute clip' : 'Mute clip'}
                    className={`material-symbols-outlined text-[18px] ${selClip.muted ? 'text-error' : 'text-on-surface-variant hover:text-on-surface'}`}
                  >
                    {selClip.muted ? 'volume_off' : 'volume_up'}
                  </button>
                </div>
                <input
                  type="range" min={0} max={200} value={Math.round((selClip.volume ?? 1) * 100)}
                  disabled={selClip.muted}
                  onPointerDown={pushHistory}
                  onChange={(e) => setClipVolume(selClip.id, Number(e.target.value) / 100)}
                  className="w-full accent-primary disabled:opacity-40"
                />
                <p className="text-[11px] text-on-surface-variant/60 mt-2">Drag the clip's edges on the Video track to trim.</p>
              </div>
            )}

            {/* caption cards */}
            {!captions.length ? (
              <p className="text-body-sm text-on-surface-variant/60">
                No captions yet. Trim your cut, then hit <span className="text-primary">Generate AI Captions</span>.
              </p>
            ) : (
              <div className="space-y-2">
                {projCaps.map((c) => {
                  const sel = c.id === selectedId;
                  const text = c.words.map((w) => w.text).join(' ');
                  return (
                    <div
                      key={c.id}
                      onClick={() => { select(c.id); seekMs(c.startMs + 20); }}
                      className={`p-3 rounded cursor-pointer transition-colors relative ${
                        sel ? 'bg-surface-variant/40 border-2 border-primary' : 'bg-surface-variant/20 border border-outline-variant/30 hover:border-primary/30'
                      }`}
                    >
                      {sel && <div className="absolute -left-[1px] top-0 bottom-0 w-1 bg-primary rounded-l" />}
                      <div className="flex justify-between items-center mb-1">
                        <span className={`text-[10px] font-mono ${sel ? 'text-primary' : 'text-on-surface-variant'}`}>
                          {(c.startMs / 1000).toFixed(2)}s – {(c.endMs / 1000).toFixed(2)}s
                        </span>
                      </div>

                      {sel ? (
                        <div onClick={(e) => e.stopPropagation()}>
                          <textarea
                            value={text}
                            onFocus={pushHistory}
                            onChange={(e) => setText(c.id, e.target.value)}
                            rows={2}
                            className="w-full mt-1 mb-3 bg-surface-container-lowest text-on-surface border border-outline-variant/40 focus:border-primary focus:outline-none rounded p-2 text-body-md resize-y"
                          />
                          <label className="text-[11px] text-on-surface-variant">Vertical position: {c.topPct}%</label>
                          <input
                            type="range" min={5} max={88} value={c.topPct}
                            onPointerDown={pushHistory}
                            onChange={(e) => setTopPct(c.id, Number(e.target.value))}
                            className="w-full mt-1 mb-3 accent-primary"
                          />
                          <label className="text-[11px] text-on-surface-variant">Accents (click a word)</label>
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {c.words.map((w, i) => (
                              <button
                                key={i}
                                onClick={() => { pushHistory(); toggleAccent(c.id, i); }}
                                style={w.accent ? {background: accentColor, borderColor: accentColor, color: '#000'} : undefined}
                                className={`px-2 py-1 rounded text-[12px] border ${
                                  w.accent ? 'font-bold' : 'border-outline-variant/40 bg-surface-container-lowest text-on-surface-variant'
                                }`}
                              >
                                {w.text}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="text-body-sm text-on-surface-variant truncate">{text}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === 'B-roll' && (
          <>
            <button
              onClick={onGenerateBroll}
              disabled={brollGenerating || !clips.length}
              className="w-full py-3 bg-primary-container text-on-primary-container rounded-lg font-bold text-body-md hover:brightness-110 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            >
              <span className={`material-symbols-outlined text-[20px] ${brollGenerating ? 'animate-spin' : ''}`}>{brollGenerating ? 'progress_activity' : 'movie'}</span>
              {brollGenerating ? 'Finding B-roll…' : 'Auto B-roll'}
            </button>
            {brollGenerating && <p className="text-[11px] text-on-surface-variant mt-2 truncate">{brollLabel}</p>}
            <div className="mb-5" />

            {!brolls.length ? (
              <p className="text-body-sm text-on-surface-variant/60">
                No B-roll yet. Generate captions first, then hit <span className="text-primary">Auto B-roll</span> — it overlays stock/your footage where it helps.
              </p>
            ) : (
              <div className="space-y-2">
                {projBrolls.map((b) => {
                  const isSel = b.id === selectedId;
                  return (
                    <div
                      key={b.id}
                      onClick={() => { select(b.id); seekMs(b.startMs + 20); }}
                      className={`p-3 rounded cursor-pointer transition-colors ${isSel ? 'bg-surface-variant/40 border-2 border-primary' : 'bg-surface-variant/20 border border-outline-variant/30 hover:border-primary/30'}`}
                    >
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] font-mono text-on-surface-variant">{(b.startMs / 1000).toFixed(1)}s</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase ${b.source === 'own' ? 'bg-secondary-container/40 text-secondary' : 'bg-tertiary-container/40 text-tertiary'}`}>{b.source ?? 'pexels'}</span>
                      </div>
                      <p className="text-body-sm text-on-surface truncate mb-2">{b.query ?? b.id}</p>
                      <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
                        {(['fullscreen', 'top', 'inset'] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => setBrollMode(b.id, m)}
                            className={`flex-1 py-1 text-[10px] rounded border ${b.mode === m ? 'border-primary text-primary bg-primary-container/20' : 'border-outline-variant/40 text-on-surface-variant'}`}
                          >
                            {m === 'fullscreen' ? 'Full' : m === 'top' ? 'Top' : 'Inset'}
                          </button>
                        ))}
                        {!!b.alternatives?.length && (
                          <button onClick={() => swapBroll(b.id)} title="Next option" className="material-symbols-outlined text-[18px] text-on-surface-variant hover:text-primary px-1">cached</button>
                        )}
                        <button onClick={() => removeBroll(b.id)} title="Remove" className="material-symbols-outlined text-[18px] text-on-surface-variant hover:text-error px-1">delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === 'Styles' && (
          <div>
            <label className="text-label-bold font-label-bold uppercase text-on-surface-variant">Accent color</label>
            <div className="flex flex-wrap gap-2 mt-3">
              {ACCENT_SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => setAccentColor(c)}
                  style={{background: c}}
                  className={`w-8 h-8 rounded-full border-2 ${accentColor.toLowerCase() === c.toLowerCase() ? 'border-on-surface' : 'border-transparent'}`}
                  title={c}
                />
              ))}
            </div>
            <p className="text-[11px] text-on-surface-variant/60 mt-3">Highlights the meaningful words in your captions.</p>
          </div>
        )}

        {tab === 'Settings' && (
          <div className="space-y-5">
            <div>
              <label className="text-label-bold font-label-bold uppercase text-on-surface-variant">Music</label>
              {music ? (
                <>
                  <p className="text-body-sm text-on-surface truncate mt-2 mb-3">{music.src.split('/').pop()}</p>
                  <label className="text-[11px] text-on-surface-variant">Volume: {Math.round(music.volume * 100)}%</label>
                  <input
                    type="range" min={0} max={100} value={Math.round(music.volume * 100)}
                    onChange={(e) => setMusic({...music, volume: Number(e.target.value) / 100})}
                    className="w-full mt-1 mb-3 accent-primary"
                  />
                  <label className="text-[11px] text-on-surface-variant">Fade-out: {music.fadeOutSec.toFixed(1)}s</label>
                  <input
                    type="range" min={0} max={50} value={Math.round(music.fadeOutSec * 10)}
                    onChange={(e) => setMusic({...music, fadeOutSec: Number(e.target.value) / 10})}
                    className="w-full mt-1 accent-primary"
                  />

                  {/* auto-duck under voice */}
                  <div className="flex items-center justify-between mt-4">
                    <label className="text-[11px] text-on-surface-variant">Duck under voice</label>
                    <button
                      onClick={() => setMusic({...music, duck: !music.duck})}
                      title="Automatically lower the music while someone is speaking"
                      className={`w-9 h-5 rounded-full relative transition-colors ${music.duck ? 'bg-primary-container' : 'bg-surface-container-lowest border border-outline-variant/50'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${music.duck ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </div>
                  {music.duck && (
                    <>
                      <label className="text-[11px] text-on-surface-variant">Ducked level: {Math.round((music.duckLevel ?? 0.25) * 100)}%</label>
                      <input
                        type="range" min={5} max={80} value={Math.round((music.duckLevel ?? 0.25) * 100)}
                        onChange={(e) => setMusic({...music, duckLevel: Number(e.target.value) / 100})}
                        className="w-full mt-1 accent-primary"
                      />
                      <p className="text-[10px] text-on-surface-variant/50 mt-1">Speech is detected from your captions — generate captions first.</p>
                    </>
                  )}
                </>
              ) : (
                <p className="text-body-sm text-on-surface-variant/60 mt-2">No music. Add a track in the Assets panel.</p>
              )}
            </div>
            <div className="pt-4 border-t border-outline-variant/30">
              <Row k="Resolution" v={`${meta.width}×${meta.height}`} />
              <Row k="FPS" v={String(meta.fps)} />
              <Row k="Clips" v={String(clips.length)} />
              <Row k="Duration" v={`${(meta.durationInFrames / meta.fps).toFixed(1)}s`} />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

const Row: React.FC<{k: string; v: string}> = ({k, v}) => (
  <div className="flex justify-between py-1 text-body-sm border-b border-outline-variant/15">
    <span className="text-on-surface-variant">{k}</span>
    <span className="text-on-surface font-mono">{v}</span>
  </div>
);

const IconBtn: React.FC<{icon: string; title: string; onClick: () => void; danger?: boolean}> = ({icon, title, onClick, danger}) => (
  <button
    title={title}
    onClick={onClick}
    className={`material-symbols-outlined text-[18px] ${danger ? 'text-on-surface-variant hover:text-error' : 'text-on-surface-variant hover:text-on-surface'}`}
  >
    {icon}
  </button>
);
