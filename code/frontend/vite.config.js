import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    minify: 'esbuild', // Use esbuild for minification (faster and included with Vite)
    outDir: 'dist',
    sourcemap: false,
    // Ensure all dependencies are properly bundled
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    },
    // Inline all dynamic imports to avoid module resolution issues
    assetsInlineLimit: 0,
    // Ensure CommonJS dependencies are handled correctly
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true
    }
  },
  // Optimize dependency pre-bundling - includes Supabase to prevent tslib resolution errors
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@supabase/supabase-js',
      'tslib'
    ],
    force: false
  }
})
