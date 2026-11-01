import { defineConfig } from '@playwright/test';
import { E2E } from './support/env';
import { E2E_GEOCODING_FAKE } from './support/geocoding-fake';

/**
 * Suíte ponta a ponta (API + Web) contra um ambiente isolado:
 *   API  → http://localhost:3001 (banco <slug>_e2e criado só pelas migrations, uploads em e2e/.uploads)
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
  // Pastas próprias por execução (E2E_OUTPUT_DIR/E2E_REPORT_DIR): o Playwright limpa a pasta de
  // resultados ao iniciar, então execuções paralelas não podem compartilhá-la
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.E2E_REPORT_DIR ?? 'playwright-report' }]],
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
      // API compilada em backend/dist-e2e (npm test faz o build antes); cwd = backend para achar .env e node_modules
      command: 'node dist-e2e/main.js',
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
        // Schema 100% pelas migrations (o mesmo da produção): o synchronize esconderia uma migration esquecida
        DB_SYNCHRONIZE: 'false',
        DB_MIGRATIONS_RUN: 'true',
        // Loja demo (criada pelo seed) = loja das rotas antigas sem slug
        SEED_DEMO_USERS: 'true',
        DEFAULT_STORE_SLUG: E2E.demoStoreSlug,
        PAYMENT_SANDBOX: 'true',
        FOOTBALL_DATA_TOKEN: '',
        // A suíte cadastra centenas de clientes e erra senhas de propósito a partir do mesmo IP:
        // limites por IP folgados; o limite por IP + e-mail (LOGIN_FAILURES) continua o padrão de produção
        RATE_LIMIT_SIGNUP: '100000/3600',
        RATE_LIMIT_LOGIN_FAILURES_IP: '100000/900',
        RATE_LIMIT_FORGOT_PASSWORD: '100000/900',
        RATE_LIMIT_TOKEN_REDEEM: '100000/900',
        RATE_LIMIT_STORE_SIGNUP: '100000/3600',
        // Limites de abuso (pedidos, cobranças, webhook, uploads, endereços, equipe, troca de credenciais): a suíte
        // repete essas ações centenas de vezes com os mesmos clientes e do mesmo IP (as regras têm testes unitários)
        RATE_LIMIT_ORDER_CREATE: '100000/600',
        RATE_LIMIT_ORDER_CREATE_IP: '100000/600',
        RATE_LIMIT_PAYMENT_CREATE: '100000/600',
        RATE_LIMIT_PAYMENT_CREATE_IP: '100000/600',
        RATE_LIMIT_PAYMENT_WEBHOOK: '100000/60',
        RATE_LIMIT_UPLOAD: '100000/600',
        RATE_LIMIT_ADDRESS_WRITE: '100000/600',
        RATE_LIMIT_TEAM_WRITE: '100000/600',
        RATE_LIMIT_CREDENTIALS_CHANGE: '100000/900',
        // Logins bem-sucedidos por conta e falhas por conta: a suíte entra centenas de vezes com os
        // usuários do seed (os limites têm testes unitários; o "teto de sessões" usa a própria conta)
        RATE_LIMIT_LOGIN_SUCCESS: '100000/600',
        RATE_LIMIT_LOGIN_FAILURES_ACCOUNT: '100000/3600',
        // Dashboard e financeiro do superpainel sem o cache de 30 s: os testes comparam com as listas na hora
        PLATFORM_INSIGHTS_CACHE_MS: '0',
        // Verificação e troca de e-mail (/account): pedidos por conta e e-mails por destino (os limites
        // têm testes unitários). Modo das rotas antigas: compat (E2E_ACCOUNT_SECURITY_MODE para a rodada strict)
        RATE_LIMIT_ACCOUNT_EMAIL: '100000/3600',
        RATE_LIMIT_ACCOUNT_EMAIL_TARGET: '100000/3600',
        ACCOUNT_SECURITY_MODE: process.env.E2E_ACCOUNT_SECURITY_MODE ?? 'compat',
        // Sessão do site em cookie: tolerância curta do refresh anterior (o teste de reuso espera passar dela)
        // e renovações por IP folgadas (cada aba e cada teste renovam; o limite tem teste unitário)
        AUTH_REFRESH_GRACE_SECONDS: '3',
        RATE_LIMIT_REFRESH: '100000/300',
        // E-mail de teste do superpainel (5 a cada 10 min por operador): execuções seguidas com a API
        // reaproveitada usam o mesmo superadmin (o limite tem testes unitários)
        RATE_LIMIT_TEST_EMAIL: '100000/600',
        // Links de pagamento da assinatura por loja (o limite tem teste unitário)
        RATE_LIMIT_SUBSCRIPTION_CHECKOUT: '100000/600',
        // E-mail transacional sempre pelo driver de log: um MAIL_DRIVER=smtp no backend/.env faria a suíte
        // enviar e-mails de verdade (convites, redefinição de senha, e-mail de teste)
        MAIL_DRIVER: 'log',
        // Links de convite e redefinição de senha apontam para a web de teste
        APP_WEB_URL: E2E.webURL,
        // Cobrança SaaS: registro manual; o webhook valida assinatura com este segredo de teste
        SAAS_BILLING_PROVIDER: 'MANUAL',
        MP_SAAS_WEBHOOK_SECRET: E2E.saasWebhookSecret,
        // Rotina das assinaturas a cada 10 s (mínimo aceito; padrão 5 min): tests/api/billing simula a
        // passagem do tempo mudando datas no banco de teste e espera a rotina. A loja demo não é afetada:
        // a assinatura dela (plano interno gratuito) não tem vencimento nem faturas
        SAAS_BILLING_INTERVAL_MS: '10000',
        // Entrega por distância: coordenadas falsas por CEP (a API nunca consulta mapas de verdade nos testes).
        // Mesmos CEPs de tests/api/commerce/delivery-distance.spec.ts e tests/web/multistore/delivery-distance.spec.ts
        GEOCODING_FAKE: E2E_GEOCODING_FAKE,
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
