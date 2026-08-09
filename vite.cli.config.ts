// The CLI's build: src/cli/main.ts and everything it pulls out of src/lib,
// bundled into one dependency-free ES module.
//
// A second config rather than a second entry in vite.config.ts, because
// everything about this build is different — no Svelte plugin, a node target
// rather than a browser one, a library output rather than an app one — and
// because `npm run build` must keep producing exactly the app it produced
// before.
//
// Bundled rather than run through a loader so the tool is one file that plain
// `node` executes. `valibot` is bundled in with it (~30 KB); the alternative is
// a CLI that stops working when node_modules is pruned, which is precisely when
// somebody reaches for it.
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  // Off, or vite copies `public/` into the output — a favicon beside a CLI.
  publicDir: false,
  build: {
    target: 'node20',
    outDir: 'dist-cli',
    emptyOutDir: true,
    // Vite would otherwise inline the small chunks and minify: neither helps a
    // script whose stack traces someone may have to read, and both cost the
    // ability to grep the bundle for a string you saw in the output.
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/cli/main.ts',
      formats: ['es'],
      fileName: () => 'perfherder.mjs',
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        banner: '#!/usr/bin/env node',
      },
    },
  },
});
