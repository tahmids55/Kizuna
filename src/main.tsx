import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/store';
import { App } from './App';
import { Toaster } from './components/Toast';
import './styles.css';

// Follow the OS theme live when the user picked "System".
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if ((localStorage.getItem('kizuna-theme') || 'system') === 'system') document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
