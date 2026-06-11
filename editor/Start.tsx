import React, {useRef, useState} from 'react';
import {useEditor} from './store';
import {clipDurationSec} from '../src/timeline';

export type ProjectMeta = {id: string; name: string; clips: number; updatedAt: string | null; thumb: string | null};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const ago = (iso: string | null) => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

// Home screen: open a recent project, or drop clips to start a new one.
export const Start: React.FC<{
  projects: ProjectMeta[];
  onNew: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}> = ({projects, onNew, onOpen, onRefresh}) => {
  const {clips, addClip} = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const importFiles = async (files: File[]) => {
    const vids = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
    if (!vids.length) return;
    for (let i = 0; i < vids.length; i++) {
      setBusy(`Uploading ${vids[i].name} (${i + 1}/${vids.length})…`);
      try {
        const clip = await fetch('/api/add-clip?name=' + encodeURIComponent(vids[i].name), {method: 'POST', body: vids[i]}).then((r) => r.json());
        if (clip?.id) addClip(clip);
      } catch {
        /* skip */
      }
    }
    setBusy(null);
  };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    importFiles(files);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    importFiles(Array.from(e.dataTransfer.files ?? []));
  };
  const del = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await fetch('/api/projects/' + id, {method: 'DELETE'}).catch(() => {});
    onRefresh();
  };

  return (
    <div className="h-screen bg-background text-on-surface flex flex-col items-center overflow-y-auto py-12 px-8">
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center">
          <h1 className="text-headline-lg font-headline-lg font-bold">AutoBroll</h1>
          <p className="text-body-md text-on-surface-variant mt-1">Open a project or drop clips to start a new one</p>
        </div>

        {/* New project */}
        <input ref={inputRef} type="file" accept="video/*" multiple onChange={onPick} className="hidden" />
        <div
          onClick={() => !clips.length && inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`w-full rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-3 py-12 transition-all ${
            dragOver ? 'border-primary bg-primary-container/10' : 'border-outline-variant bg-surface-container-low'
          } ${clips.length ? '' : 'cursor-pointer hover:border-primary/60'}`}
        >
          <span className="material-symbols-outlined text-[48px] text-primary">{busy ? 'progress_activity' : 'video_library'}</span>
          {busy ? (
            <p className="text-body-md text-primary">{busy}</p>
          ) : clips.length ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-body-md text-on-surface">{clips.length} clip{clips.length > 1 ? 's' : ''} ready</p>
              <div className="flex gap-2">
                <button onClick={() => inputRef.current?.click()} className="px-4 py-2 rounded-lg border border-outline-variant text-on-surface-variant hover:bg-surface-variant text-body-md font-bold">Add more</button>
                <button onClick={onNew} className="bg-primary-container text-on-primary-container px-5 py-2 rounded-lg font-bold text-body-md hover:brightness-110 active:scale-95 transition-all flex items-center gap-1">
                  Open editor <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className="bg-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-bold text-body-md hover:brightness-110 active:scale-95 transition-all">New project — add files</button>
              <p className="text-body-sm text-on-surface-variant">or drag &amp; drop videos here</p>
            </>
          )}
        </div>

        {/* Recent projects */}
        {projects.length > 0 && (
          <div className="mt-10">
            <h2 className="text-label-bold font-label-bold uppercase tracking-wider text-on-surface-variant mb-3">Recent projects</h2>
            <div className="grid grid-cols-3 gap-3">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onOpen(p.id)}
                  className="group relative text-left rounded-lg overflow-hidden border border-outline-variant/50 bg-surface-container-low hover:border-primary transition-all"
                >
                  <div className="aspect-video bg-surface-container relative">
                    {p.thumb ? (
                      <img src={p.thumb} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-on-surface-variant/40">
                        <span className="material-symbols-outlined">movie</span>
                      </div>
                    )}
                    <button
                      onClick={(e) => del(e, p.id)}
                      title="Delete project"
                      className="absolute top-1 right-1 w-6 h-6 rounded bg-surface-container-lowest/80 text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                  </div>
                  <div className="p-2">
                    <p className="text-body-sm font-medium truncate">{p.name}</p>
                    <p className="text-[11px] text-on-surface-variant">{p.clips} clip{p.clips === 1 ? '' : 's'} · {ago(p.updatedAt)}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
