import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Focused validation of an isolated stack; no seeded global auth state.
export default defineConfig({
  testDir: './',
  testMatch: 'security-port.spec.ts',
  metadata: { securityPort: true },
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir:
    process.env.E2E_OUTPUT_DIR || path.join(tmpdir(), 'argus-security-port-e2e'),
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:55173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
