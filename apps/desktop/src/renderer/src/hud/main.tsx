import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Hud } from './Hud';
import './hud.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Hud />
  </StrictMode>
);
