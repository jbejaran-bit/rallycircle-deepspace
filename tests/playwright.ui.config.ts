import { defineConfig } from '@playwright/test'

const port = Number(process.env.RALLYCIRCLE_UI_PORT ?? 5183)
export default defineConfig({
  testDir: '.', testMatch: ['ui-polish.spec.ts'],
  outputDir: '../test-results/ui-polish',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, timezoneId: 'America/New_York', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: {
    command: `npm exec -- vite --config tests/ui-fixtures/vite.config.ts --port ${port} --strictPort --host 127.0.0.1`,
    cwd: '..', url: `http://127.0.0.1:${port}/tests/ui-fixtures/index.html`, reuseExistingServer: false,
    timeout: 60_000,
  },
})
