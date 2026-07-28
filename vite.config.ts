import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
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
