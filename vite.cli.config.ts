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
//
// **The output goes into the published package's directory.** `perfherder-cli/`
// carries its own package.json, its own version and nothing else — the profiler
// repository's arrangement for `profiler-cli` — so that publishing the tool does
// not mean publishing the app, and the tool's version does not have to be the
// app's. `npm publish perfherder-cli/` is the whole ceremony.
import { chmodSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(
  readFileSync(new URL('./perfherder-cli/package.json', import.meta.url), 'utf8'),
) as { version: string };

// So the bundle can say what it is when someone reports a bug against it, and —
// the reason it is worth wiring rather than nice to have — so `verify-cli-build`
// can tell a fresh bundle from a stale one by looking for this string. `dist/`
// is gitignored and only the wrapper rebuilds it, so publishing yesterday's
// bundle under today's version number is the easy mistake here.
const define = { __VERSION__: JSON.stringify(pkg.version) };

// npm marks a `bin` target executable when it installs one, but a tarball
// unpacked by hand, or the file run straight out of the build, should not need
// that favour. One line, and the shebang above it is then true.
function executableOutput(file: string): Plugin {
  return {
    name: 'chmod-cli-bundle',
    closeBundle() {
      chmodSync(new URL(file, import.meta.url), 0o755);
    },
  };
}

export default defineConfig({
  // Off, or vite copies `public/` into the output — a favicon beside a CLI.
  publicDir: false,
  define,
  plugins: [executableOutput('./perfherder-cli/dist/perfherder-cli.mjs')],
  build: {
    target: 'node20',
    outDir: 'perfherder-cli/dist',
    emptyOutDir: true,
    // Vite would otherwise inline the small chunks and minify: neither helps a
    // script whose stack traces someone may have to read, and both cost the
    // ability to grep the bundle for a string you saw in the output.
    minify: false,
    // Not shipped — `files` in the package lists the bundle alone — because an
    // unminified bundle's stack traces are already readable and the map is four
    // times the size of the thing it describes. Built anyway, for the checkout.
    sourcemap: true,
    lib: {
      entry: 'src/cli/main.ts',
      formats: ['es'],
      fileName: () => 'perfherder-cli.mjs',
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        banner: '#!/usr/bin/env node',
      },
    },
  },
});
