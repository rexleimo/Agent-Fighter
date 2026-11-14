import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import '../../web/styles.css';
import '../../web/team.css';
import '../../web/account.css';
import '../../web/guide.css';
import '../../web/manual.css';
import '../../web/library.css';
import './styles/app.css';

if (import.meta.env.DEV) {
  const show = (title: string, detail: string) => {
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;inset:0;z-index:99999;margin:0;padding:24px;background:#120d10;color:#ff8a96;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow:auto';
    box.textContent = `${title}\n\n${detail}`;
    document.body.appendChild(box);
  };
  window.addEventListener('error', (event) => {
    show('Runtime error', `${event.message}\n${event.error?.stack ?? ''}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    show('Unhandled rejection', String(reason?.stack ?? reason));
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
