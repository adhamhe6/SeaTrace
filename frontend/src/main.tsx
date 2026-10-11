import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { bootstrapApi, createQueryClient } from './queryClient';
import './styles/tokens.css';
import './styles/global.css';
import './ui/ui.css';

bootstrapApi();
const queryClient = createQueryClient();
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App queryClient={queryClient} />
    </BrowserRouter>
  </StrictMode>,
);
