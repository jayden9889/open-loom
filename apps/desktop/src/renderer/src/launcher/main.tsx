import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '../components/ui';
import { Launcher } from './Launcher';
import '../styles/app.css';
import './launcher.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Launcher />
    </ToastProvider>
  </StrictMode>
);
