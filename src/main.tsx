import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/**
 * Dashboard errors go to the server's Activity log (category "Dashboard"), so a broken screen
 * leaves a trace next to what the server was doing at that moment. Throttled and de-duplicated.
 */
(() => {
  const recent = new Map<string, number>();
  let sentThisMinute = 0;
  setInterval(() => (sentThisMinute = 0), 60 * 1000);
  const report = (message: string, stack?: string) => {
    if (!message || /ResizeObserver loop/.test(message)) return;
    const key = message.slice(0, 200);
    const now = Date.now();
    if ((recent.get(key) || 0) > now - 30 * 1000 || sentThisMinute >= 10) return;
    recent.set(key, now);
    sentThisMinute++;
    fetch('/api/logs/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'error', message, stack, url: location.href }),
      keepalive: true,
    }).catch(() => {});
  };
  window.addEventListener('error', (e) => {
    if (!e.message) return;
    report(e.message, (e.error as Error | undefined)?.stack || `${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string; name?: string } | undefined;
    if (r?.name === 'AbortError') return;
    report(`Unhandled promise rejection: ${r?.message || String(e.reason)}`, r?.stack);
  });
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
