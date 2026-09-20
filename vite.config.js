import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Solana + Anchor + Metaplex all expect a Node-ish environment (Buffer, crypto,
// stream). The polyfill plugin provides them for the browser bundle.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'events', 'http', 'https', 'zlib', 'url', 'assert', 'querystring', 'process'],
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The live preview is served from a *.e2b.app hostname, so the dev server
    // must accept that Host header instead of rejecting it.
    allowedHosts: true,
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { chunkSizeWarningLimit: 5000, target: 'es2020' },
  optimizeDeps: { esbuildOptions: { define: { global: 'globalThis' } } },
})
