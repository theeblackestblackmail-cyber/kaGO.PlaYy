import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.setTimeout(() => {
    try {
      registerSW({
        immediate: false,
        onRegisterError() {
          // Ignore registration errors in restricted preview iframes
        },
      });
    } catch {
      // Ignore registration errors
    }
  }, 1200);
}
