import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'

const port = Number(process.env.DEEPSPACE_PORT ?? 5173)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: '.',
  testMatch: ['smoke.spec.ts', 'public-navigation.spec.ts', 'product-public.spec.ts'],
  outputDir: '../test-results-public',
  use: {
    baseURL,
    headless: true,
    launchOptions: chromiumLaunchOptions(),
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm exec -- vite --port ${port} --strictPort --host 127.0.0.1`,
    cwd: '..',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
