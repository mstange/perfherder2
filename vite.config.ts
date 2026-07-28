// `vitest/config` rather than `vite`: it's the same `defineConfig` widened to
// accept the `test` block below. Importing it from `vite` type-checks fine
// until `tsc -p tsconfig.node.json` (i.e. `npm run check`) reaches this file
// and rejects `test` as an unknown property.
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // Under vitest, resolve `svelte` itself through its browser entry. Without
  // this the package's node condition wins and `mount()` comes from
  // `index-server.js`, which throws `lifecycle_function_unavailable` — the
  // same SSR-vs-client split described in the `environment` note below, but one
  // level up, in the dependency rather than in our own modules. Scoped to the
  // test run so the app build is untouched.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: {
    // Runes only compile in files the Svelte plugin processes, which means a
    // name ending in `.svelte.ts`. Vitest's default glob wants `.test.ts` at
    // the end, so tests that exercise reactive state are named
    // `<thing>.test.svelte.ts` and matched here.
    include: ['src/**/*.test.ts', 'src/**/*.test.svelte.ts'],
    // A DOM-ish environment is what makes vite compile Svelte modules in
    // client mode. Under the default node environment they're compiled for
    // SSR, where the effect machinery is stubbed out — `$effect.root` becomes
    // a no-op and no reactive code can be tested at all.
    environment: 'happy-dom',
  },
})
