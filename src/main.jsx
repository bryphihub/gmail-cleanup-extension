// Entry point: mounts the React app into the <div id="root"> in index.html.
// You rarely need to touch this file.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

async function start() {
  // Dev-only: when previewing in a normal browser tab (`npx vite`), the
  // chrome.* extension APIs don't exist — load the fake Gmail instead so
  // every screen is clickable with made-up data. `import.meta.env.DEV` is
  // false during `npm run build`, so none of this ships in the extension.
  if (import.meta.env.DEV && !window.chrome?.identity) {
    await import('./devMock.js')
  }

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

start()
