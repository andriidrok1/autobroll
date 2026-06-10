import React, {useEffect, useRef} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {CaptionedVideo} from '../src/CaptionedVideo';
import {buildCaptions, type Word, type Placement} from '../src/captions';
import {useEditor} from './store';
import {Timeline} from './Timeline';

// cache-bust: после импорта public/*.json перезаписаны, нужен свежий фетч
const j = (name: string) => fetch(`/${name}?_=${Date.now()}`).then((r) => r.json());

type Job = {status: string; step?: string; label?: string; progress?: number; file?: string; error?: string};

export const Editor: React.FC = () => {
  const {
    meta, captions, clips, music, accentColor, selectedId, currentFrame, past, future,
    init, select, setCurrentFrame, setTopPct, setText, toggleAccent, pushHistory, undo, redo,
  } = useEditor();
  const playerRef = useRef<PlayerRef>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [exp, setExp] = React.useState<Job | null>(null);
  const [imp, setImp] = React.useState<Job | null>(null);

  // строит проект заново из выхода pipeline (transcript/accents/placement)
  const loadFromPipeline = async () => {
    const [m, words, accents, placements] = await Promise.all([
      j('meta.json'),
      j('transcript.json') as Promise<Word[]>,
      j('accents.json') as Promise<number[]>,
      j('placement.json').catch(() => []) as Promise<Placement[]>,
    ]);
    init(m, buildCaptions(words, accents, placements));
    select(null);
  };

  // E8: загрузка — сохранённый проект с диска имеет приоритет над дефолтом pipeline
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/project');
        if (r.ok) {
          const p = await r.json();
          init(p.meta, p.captions, p.accentColor, p.clips, p.music);
        } else {
          await loadFromPipeline();
        }
      } catch (e) {
        setErr(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // E8: автосохранение полного проекта на диск (debounce), не localStorage.
  // Сохраняем и clips/music — мульти-клип таймлайн не должен теряться при сейве.
  useEffect(() => {
    if (!meta || !captions.length) return;
    const t = setTimeout(() => {
      fetch('/api/save', {method: 'POST', body: JSON.stringify({meta, captions, accentColor, clips, music})}).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [meta, captions, accentColor, clips, music]);

  // undo/redo с клавиатуры (не перехватываем, когда правишь текст в поле)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // E9: экспорт mp4 через backend
  const exportVideo = async () => {
    setExp({status: 'running', progress: 0});
    const r = await fetch('/api/render', {method: 'POST', body: JSON.stringify({captions, accentColor})}).then((x) => x.json());
    const poll = setInterval(async () => {
      const s = await fetch('/api/render/' + r.jobId).then((x) => x.json());
      setExp(s);
      if (s.status === 'done' || s.status === 'error') clearInterval(poll);
    }, 1500);
  };

  // E10: импорт видео → pipeline → авто-субтитры (без терминала)
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // позволить повторный импорт того же файла
    if (!file) return;
    setImp({status: 'uploading', label: 'Uploading…', progress: 0});
    const {jobId} = await fetch('/api/import', {method: 'POST', body: file}).then((x) => x.json());
    const poll = setInterval(async () => {
      const s: Job = await fetch('/api/import/' + jobId).then((x) => x.json());
      setImp(s);
      if (s.status === 'done') {
        clearInterval(poll);
        await loadFromPipeline();
        setTimeout(() => setImp(null), 1500);
      } else if (s.status === 'error') {
        clearInterval(poll);
      }
    }, 1200);
  };

  // сброс правок: пересобрать из pipeline-выхода (project.json перезапишется автосейвом)
  const resetEdits = () => loadFromPipeline();

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: {detail: {frame: number}}) => setCurrentFrame(e.detail.frame);
    p.addEventListener('frameupdate', onFrame);
    return () => p.removeEventListener('frameupdate', onFrame);
  }, [meta, setCurrentFrame]);

  if (err) return <Center>Error: {err}</Center>;
  if (!meta) return <Center>Loading…</Center>;

  const selected = captions.find((c) => c.id === selectedId);
  const nowMs = (currentFrame / meta.fps) * 1000;

  // субтитр видимый в текущем кадре (его и тянем драгом)
  const visibleCaption = captions.find((c, i) => {
    const nextStart = captions[i + 1]?.startMs ?? Infinity;
    const visEnd = Math.min(nextStart, c.endMs + 700);
    return nowMs >= c.startMs && nowMs < visEnd;
  });

  // ---- E4: drag по видео ----
  const onStagePointerDown = (e: React.PointerEvent) => {
    if (!visibleCaption) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    select(visibleCaption.id);
    const startY = e.clientY;
    const startTop = visibleCaption.topPct;
    let moved = false;
    let snapped = false;
    const move = (ev: PointerEvent) => {
      const dPct = ((ev.clientY - startY) / rect.height) * 100;
      if (Math.abs(ev.clientY - startY) > 3) {
        if (!snapped) { pushHistory(); snapped = true; }
        moved = true;
      }
      setTopPct(visibleCaption.id, Math.min(88, Math.max(5, startTop + dPct)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) playerRef.current?.toggle(); // не двигал → клик = play/pause
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div style={{display: 'flex', flexDirection: 'column', height: '100vh'}}>
      <header style={{display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', borderBottom: '1px solid #1e1e26'}}>
        <span style={{fontWeight: 700}}>AutoBroll Editor</span>
        <input ref={fileRef} type="file" accept="video/*" onChange={onPickFile} style={{display: 'none'}} />
        <button onClick={() => fileRef.current?.click()} disabled={imp?.status === 'running' || imp?.status === 'uploading'} style={btn('#2a2a33')}>
          ↥ Import video
        </button>
        {imp && imp.status !== 'done' && imp.status !== 'error' && (
          <span style={{fontSize: 13, color: '#9a9aa6'}}>{imp.label ?? 'Working…'} {imp.progress ?? 0}%</span>
        )}
        {imp?.status === 'error' && <span style={{fontSize: 13, color: '#ff5b5b'}}>Import failed</span>}

        <span style={{flex: 1}} />

        <button onClick={undo} disabled={!past.length} title="Undo (⌘Z)" style={btn('#2a2a33', !past.length)}>↶</button>
        <button onClick={redo} disabled={!future.length} title="Redo (⇧⌘Z)" style={btn('#2a2a33', !future.length)}>↷</button>

        {exp?.status === 'running' && <span style={{fontSize: 13, color: '#9a9aa6'}}>Rendering… {exp.progress ?? 0}%</span>}
        {exp?.status === 'done' && exp.file && <a href={exp.file} download style={{fontSize: 13, color: '#39d98a'}}>↓ Download mp4</a>}
        {exp?.status === 'error' && <span style={{fontSize: 13, color: '#ff5b5b'}}>Render error</span>}
        <button onClick={resetEdits} style={btn('#2a2a33')}>Reset</button>
        <button onClick={exportVideo} disabled={exp?.status === 'running'} style={btn('#2b6cff')}>Export mp4</button>
      </header>

      <main style={{flex: 1, display: 'flex', minHeight: 0}}>
        <div style={{flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, minWidth: 0}}>
          <div style={{position: 'relative', height: '100%', aspectRatio: `${meta.width} / ${meta.height}`}}>
            <Player
              ref={playerRef}
              component={CaptionedVideo}
              inputProps={{captions, accentColor}}
              durationInFrames={meta.durationInFrames}
              fps={meta.fps}
              compositionWidth={meta.width}
              compositionHeight={meta.height}
              controls
              style={{width: '100%', height: '100%', borderRadius: 12, overflow: 'hidden'}}
            />
            {/* drag-слой: верх кадра, не перекрывает контролы плеера снизу */}
            <div
              ref={stageRef}
              onPointerDown={onStagePointerDown}
              style={{position: 'absolute', inset: 0, bottom: 52, cursor: visibleCaption ? 'grab' : 'default'}}
            />
          </div>
        </div>

        <aside style={{width: 300, borderLeft: '1px solid #1e1e26', padding: 18, fontSize: 13, color: '#9a9aa6'}}>
          <div style={{color: '#e8e8ee', fontWeight: 600, marginBottom: 12}}>Inspector</div>
          {selected ? (
            <>
              {/* E5: правка текста */}
              <label style={{fontSize: 12}}>Text</label>
              <textarea
                value={selected.words.map((w) => w.text).join(' ')}
                onFocus={pushHistory}
                onChange={(e) => setText(selected.id, e.target.value)}
                rows={2}
                style={{
                  width: '100%', marginTop: 4, marginBottom: 14, background: '#16161c', color: '#fff',
                  border: '1px solid #2a2a33', borderRadius: 6, padding: 8, fontSize: 14, fontFamily: 'inherit', resize: 'vertical',
                }}
              />

              {/* E4: ползунок позиции */}
              <label style={{fontSize: 12}}>Vertical position: {selected.topPct}%</label>
              <input
                type="range" min={5} max={88} value={selected.topPct}
                onPointerDown={pushHistory}
                onChange={(e) => setTopPct(selected.id, Number(e.target.value))}
                style={{width: '100%', marginTop: 6, marginBottom: 14}}
              />

              {/* E7: акценты — клик по слову вкл/выкл */}
              <label style={{fontSize: 12}}>Accents (click a word)</label>
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0 14px'}}>
                {selected.words.map((w, i) => (
                  <button
                    key={i}
                    onClick={() => { pushHistory(); toggleAccent(selected.id, i); }}
                    style={{
                      padding: '4px 9px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                      border: '1px solid ' + (w.accent ? accentColor : '#2a2a33'),
                      background: w.accent ? accentColor : '#16161c',
                      color: w.accent ? '#000' : '#c8c8d2', fontWeight: w.accent ? 700 : 500,
                    }}
                  >
                    {w.text}
                  </button>
                ))}
              </div>

              <Row k="Start" v={`${(selected.startMs / 1000).toFixed(2)}s`} />
              <Row k="End" v={`${(selected.endMs / 1000).toFixed(2)}s`} />
              <div style={{marginTop: 14, fontSize: 12, color: '#555'}}>
                Video: drag the caption ↕. Track: drag the block/edges = timing. ⌘Z undo.
              </div>
            </>
          ) : (
            <div style={{fontSize: 13}}>Click a block on the track below, or a caption on the video.</div>
          )}
        </aside>
      </main>

      <footer style={{borderTop: '1px solid #1e1e26', padding: '8px 16px', overflowX: 'auto', background: '#0e0e12'}}>
        <Timeline playerRef={playerRef} />
      </footer>
    </div>
  );
};

const btn = (bg: string, disabled = false): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: 7, border: 'none', background: bg, color: '#fff',
  fontSize: 13, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
});

const Center: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', color: '#9a9aa6'}}>
    {children}
  </div>
);

const Row: React.FC<{k: string; v: string}> = ({k, v}) => (
  <div style={{display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #161620'}}>
    <span>{k}</span>
    <span style={{color: '#e8e8ee'}}>{v}</span>
  </div>
);
