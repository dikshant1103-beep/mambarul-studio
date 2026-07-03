/**
 * e2e smoke — SCAFFOLD (see playwright.config.ts for setup).
 *
 * Exercises the critical user path against a live stack: load the app, reach a
 * prediction page, and confirm a real prediction renders. Requires the backend
 * (:8001) and Vite dev server (:5173) running, plus `npx playwright install`.
 *
 * Adjust the auth step to match your login flow (the app may already hold a
 * session; if a login screen appears, fill ADMIN creds via env).
 */
import { test, expect } from '@playwright/test'

test('app loads and shows the dashboard', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/Battery|MambaRUL|RUL/i)
})

test('warranty page renders and assesses a cell', async ({ page }) => {
  await page.goto('/warranty')
  await expect(page.getByText('Warranty Intelligence')).toBeVisible()
  // default single-cell form is pre-filled; run the assessment
  await page.getByRole('button', { name: /Assess Warranty/i }).click()
  // a status verdict should appear (Safe / At Risk / Likely Claim)
  await expect(page.getByText(/Safe|At Risk|Likely Claim/i).first()).toBeVisible({ timeout: 15_000 })
})

test('pack predict shows Pack-GNN model status', async ({ page }) => {
  await page.goto('/pack')
  await expect(page.getByText(/Pack-GNN model/i)).toBeVisible()
})
