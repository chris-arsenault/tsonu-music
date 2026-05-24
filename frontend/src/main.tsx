import React from 'react';
import ReactDOM from 'react-dom/client';
import './App.css';
import App from './App';
import { initializeRum } from './player-analytics';

void initializeRum();

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
