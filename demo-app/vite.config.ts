import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Visual Browser Workspace demo target.
// - React 18 dev build keeps per-fiber `_debugSource` (fileName/lineNumber)
//   populated by the automatic JSX dev transform, which the VBW Source Mapper
//   reads through __REACT_DEVTOOLS_GLOBAL_HOOK__.
// - Production builds include sourcemaps for stack-based mapping fallbacks.
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
  },
  preview: {
    host: '127.0.0.1',
  },
});
