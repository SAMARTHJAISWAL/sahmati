import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from https://samarthjaiswal.github.io/sahmati/,
// so asset URLs need the /sahmati/ prefix there. Everywhere else (dev server,
// local preview, other hosts) the site lives at the root.
const base = process.env.GITHUB_PAGES === 'true' ? '/sahmati/' : '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
  },
});
