import { defineConfig } from '@playwright/test';
import { E2E } from './support/env';

/**
 * Suíte ponta a ponta (API + Web) contra um ambiente isolado:
 *   API  → http://localhost:3001 (banco <slug>_e2e, uploads em e2e/.uploads)
 *   Web  → http://localhost:5174 (VITE_API_URL apontando para a API de teste)
 * Os servidores são iniciados automaticamente (ou reaproveitados se já estiverem no ar).
 * `npm test` recria o banco de teste do zero antes de rodar.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1, // estado global compartilhado (loja aberta/fechada, pedidos) → execução serial e determinística
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    {
      name: 'api',
      testDir: './tests/api',
      dependencies: ['setup'],
      use: { baseURL: E2E.apiURL },
    },
    {
      name: 'web',
      testDir: './tests/web',
      dependencies: ['setup'],
      use: {
        baseURL: E2E.webURL,
        channel: 'chrome', // usa o Google Chrome instalado (sem download de navegador)
        viewport: { width: 1366, height: 900 },
      },
    },
  ],
  webServer: [
    {
      // API compilada (npm test faz o build antes); cwd = backend para achar .env e node_modules
      command: 'node dist/main.js',
      cwd: '../backend',
      url: `${E2E.apiURL}/health`,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        PORT: String(E2E.apiPort),
        DB_DATABASE: E2E.db.database,
        UPLOADS_DIR: E2E.uploadsDir,
        NODE_ENV: 'test',
        SEED_DEMO_USERS: 'true',
        PAYMENT_SANDBOX: 'true',
        FOOTBALL_DATA_TOKEN: '',
      },
    },
    {
      command: `npm run dev -- --port ${E2E.webPort} --strictPort`,
      cwd: '../frontend-web',
      url: E2E.webURL,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { VITE_API_URL: E2E.apiURL },
    },
  ],
});
