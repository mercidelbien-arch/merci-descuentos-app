import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/admin/',          // <- importante para servir bajo /admin
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
