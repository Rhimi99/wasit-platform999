import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { I18nProvider } from './lib/i18n-context';
import { AuthProvider } from './lib/auth-context';
import { ConsentProvider } from './lib/consent-context';
import { CartProvider } from './lib/cart';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <ConsentProvider>
          <AuthProvider>
            <CartProvider>
              <App />
            </CartProvider>
          </AuthProvider>
        </ConsentProvider>
      </I18nProvider>
    </BrowserRouter>
  </React.StrictMode>,
);