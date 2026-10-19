import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// UI end-to-end tests run against the built app with a throwaway data folder.
// Run: npm run build && npm run test:e2e
export const E2E_DATA_DIR = path.join(os.tmpdir(), 'contract-desk-e2e');
// Second server with Wi-Fi access on, for the phone passcode tests.
export const LAN_PORT = 4794;
export const LAN_PASSCODE = 'harbor-2026';
const LAN_DATA_DIR = path.join(os.tmpdir(), 'contract-desk-e2e-lan');
const wipe = (dir) => `node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true })" "${dir}"`;
const PORT = 4793;
const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));

export default defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: systemChromium && !process.env.PW_BUNDLED ? { executablePath: systemChromium } : {},
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `${wipe(E2E_DATA_DIR)} && node server/index.js`,
      url: `http://127.0.0.1:${PORT}/api/meta`,
      env: { DATA_DIR: E2E_DATA_DIR, PORT: String(PORT) },
      reuseExistingServer: false,
    },
    {
      command: `${wipe(LAN_DATA_DIR)} && node server/index.js`,
      url: `http://127.0.0.1:${LAN_PORT}/api/meta`,
      env: { DATA_DIR: LAN_DATA_DIR, PORT: String(LAN_PORT), LAN_PASSCODE },
      reuseExistingServer: false,
    },
  ],
});
