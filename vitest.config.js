import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer','crypto','stream','util','events','http','https','zlib','url','assert','querystring','process'],
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  test: {
    environment: 'happy-dom',
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
