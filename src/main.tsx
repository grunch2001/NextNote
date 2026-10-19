import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, bootstrap } from './App';
import './styles/app.css';
import './styles/page.css';
import './styles/editor.css';

const root = createRoot(document.getElementById('root')!);

bootstrap()
  .catch((e) => console.error('NextNote: Start fehlgeschlagen', e))
  .finally(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    document.getElementById('boot')?.remove();
  });
