import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

// No StrictMode on purpose: effects here do real RPC work (simulation,
// wallet listeners) and we don't want them fired twice in development.
createRoot(document.getElementById('root')).render(<App />)
