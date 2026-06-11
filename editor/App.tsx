import React, {useEffect, useState} from 'react';
import {useEditor} from './store';
import {Editor} from './Editor';
import {Start, type ProjectMeta} from './Start';

const META0 = {durationInFrames: 1, fps: 30, width: 1080, height: 1920};

// Top-level: Start screen is the home (new project + recent projects library).
// Opening or creating a project switches to the editor.
export const App: React.FC = () => {
  const {init, setProjectInfo} = useEditor();
  const [view, setView] = useState<'start' | 'editor'>('start');
  const [projects, setProjects] = useState<ProjectMeta[]>([]);

  const refresh = () =>
    fetch('/api/projects').then((r) => r.json()).then((l) => setProjects(Array.isArray(l) ? l : [])).catch(() => setProjects([]));

  // start with an empty project so the Start screen's uploads can compute meta
  useEffect(() => {
    init(META0, [], undefined, [], null, []);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openProject = async (id: string) => {
    try {
      const p = await fetch('/api/projects/' + id).then((r) => r.json());
      init(META0, p.captions ?? [], p.accentColor, p.clips ?? [], p.music ?? null, p.brolls ?? [], p.brollAssets ?? []);
      setProjectInfo(id, p.name || 'Untitled project');
      setView('editor');
    } catch {
      /* ignore */
    }
  };

  // new project: Start already populated clips via upload; assign an id and go
  const newProject = () => {
    setProjectInfo(`p-${Date.now()}`, 'Untitled project');
    setView('editor');
  };

  const backToStart = () => {
    init(META0, [], undefined, [], null, []); // clear for a fresh start
    refresh();
    setView('start');
  };

  if (view === 'start') return <Start projects={projects} onNew={newProject} onOpen={openProject} onRefresh={refresh} />;
  return <Editor onBackToStart={backToStart} />;
};
