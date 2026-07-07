import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),        // lets Vite understand .jsx files and React syntax
    tailwindcss(),  // processes Tailwind class names into real CSS
  ],
  build: {
    outDir: 'dist',      // output folder = what Chrome will load
    emptyOutDir: true,   // wipe dist/ clean before each build
  },
})
