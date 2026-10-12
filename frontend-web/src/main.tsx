import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { APP_TITLE } from './config/brand';
import { migrateLegacyStorage } from './utils/legacyStorage';
import './index.css';

// O index.html traz um título neutro; o nome do produto vem da configuração (VITE_APP_NAME)
document.title = APP_TITLE;

// Carrinho e tema das versões antigas passam para as chaves novas antes de os contextos lerem o armazenamento
migrateLegacyStorage();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
