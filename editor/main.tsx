import React from 'react';
import {createRoot} from 'react-dom/client';
import {Editor} from './Editor';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Editor />
  </React.StrictMode>,
);
