import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { useTheme } from './theme-store.js';
import './theme.css';
import './global.css';

declare global {
  interface Window { cloudhelm: import('@cloudhelm/contracts').DesktopAPI }
}

useTheme.getState().init();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
