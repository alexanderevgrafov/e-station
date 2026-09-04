import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from the editor page');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
