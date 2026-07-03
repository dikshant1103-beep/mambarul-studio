/**
 * Playwright e2e config — SCAFFOLD.
 *
 * Not run in CI yet: needs browsers + a running stack. To use:
 *   npm i -D @playwright/test
 *   npx playwright install chromium
 *   # start backend (uvicorn main:app --port 8001) and `npm run dev` (vite :5173)
 *   npm run e2e
 *
 * baseURL targets the Vite dev server; the backend is proxied on :8001.
 */
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
