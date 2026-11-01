import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// --- SEGURANÇA DO SPA EM PRODUÇÃO ---
// A vitrine, o painel das lojas e o superpainel são o mesmo SPA (um só origin, tokens no localStorage).
// A Content-Security-Policy limita de onde vêm scripts e para onde o navegador pode enviar dados, reduzindo o
// impacto de um XSS ou de um script de terceiros comprometido. Ela entra SÓ no build de produção
// (<meta http-equiv> no index.html): o Vite de desenvolvimento usa scripts inline (React Refresh).
// O servidor que hospeda o build deve enviar os mesmos cabeçalhos de securityHeaders() (o vite preview envia),
// porque frame-ancestors, X-Frame-Options e os demais não funcionam por <meta>.

/** Endereço padrão da API (o mesmo de src/services/api.ts quando VITE_API_URL não está definido). */
const DEFAULT_API_URL = 'http://localhost:3000'

/** Mercado Pago: SDK do cartão (sdk.mercadopago.com) e o que ele carrega e chama (tokenização, antifraude, imagens). */
const MERCADO_PAGO_SOURCES = [
  'https://*.mercadopago.com',
  'https://*.mercadopago.com.br',
  'https://*.mercadolibre.com',
  'https://*.mercadolivre.com',
  'https://*.mercadolivre.com.br',
  'https://*.mlstatic.com',
]

/** Ícones do Iconify: o @iconify/react busca os ícones na API pública. */
const ICONIFY_SOURCES = ['https://api.iconify.design', 'https://api.simplesvg.com', 'https://api.unisvg.com']

/** Avatares prontos do perfil (lista fixa aceita pela API em users/avatar.ts). */
const AVATAR_SOURCES = ['https://cdn-icons-png.flaticon.com']

/**
 * Recharts e as dependências que só ele traz (npm ls: nenhum outro pacote do app as usa). Se um pacote daqui
 * passar a ser usado fora dos gráficos, tire-o da lista: senão o pedaço principal passa a carregar o "charts".
 */
const CHART_MODULES = new RegExp(
  `[\\\\/]node_modules[\\\\/](${[
    'recharts', 'victory-vendor', 'd3-[a-z-]+', 'internmap', '@reduxjs[\\\\/]toolkit', 'redux', 'redux-thunk', 'react-redux',
    'reselect', 'immer', 'es-toolkit', 'eventemitter3', 'decimal\\.js-light', 'tiny-invariant', 'clsx', 'use-sync-external-store',
  ].join('|')})[\\\\/]`,
)

/** Origin da API (imagens em /uploads e chamadas); null se a URL for relativa (mesmo origin do site). */
function apiOrigin(apiUrl: string): string | null {
  try {
    const { origin } = new URL(apiUrl)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** CSP do SPA. frameAncestors: só por cabeçalho HTTP (o navegador ignora frame-ancestors em <meta>). */
function contentSecurityPolicy(apiUrl: string, { frameAncestors = false } = {}): string {
  const api = apiOrigin(apiUrl)
  const apiSources = api ? [api] : []
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // Sem 'unsafe-inline' nem 'unsafe-eval': o build não tem scripts inline
    'script-src': ["'self'", ...MERCADO_PAGO_SOURCES],
    // O react-hot-toast injeta <style> e o React aplica estilos inline
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...apiSources, ...AVATAR_SOURCES, ...MERCADO_PAGO_SOURCES],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...apiSources, ...MERCADO_PAGO_SOURCES, ...ICONIFY_SOURCES],
    'frame-src': MERCADO_PAGO_SOURCES,
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    ...(frameAncestors ? { 'frame-ancestors': ["'none'"] } : {}),
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(' ')}`)
    .join('; ')
}

/** Cabeçalhos recomendados para o servidor que hospeda o build (usados pelo vite preview). */
function securityHeaders(apiUrl: string): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(apiUrl, { frameAncestors: true }),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=()',
  }
}

/** Injeta a CSP (e a política de referência) logo depois do <meta charset> do index.html do build. */
function contentSecurityPolicyPlugin(apiUrl: string): Plugin {
  const policy = contentSecurityPolicy(apiUrl)
  return {
    name: 'comestra-content-security-policy',
    apply: 'build',
    transformIndexHtml(html) {
      const charset = /<meta charset="[^"]*"\s*\/?>/i
      // Sem o ponto de inserção, o build falha: a CSP nunca some sem aviso
      if (!charset.test(html)) throw new Error('index.html sem <meta charset>: não foi possível incluir a Content-Security-Policy.')
      const tags = `\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n    <meta name="referrer" content="strict-origin-when-cross-origin" />`
      return html.replace(charset, (tag) => `${tag}${tags}`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Mesma URL da API que o app usa (VITE_API_URL do .env ou do ambiente)
  const env = loadEnv(mode, path.dirname(fileURLToPath(import.meta.url)), 'VITE_')
  const apiUrl = (env.VITE_API_URL || DEFAULT_API_URL).replace(/\/+$/, '')

  return {
    plugins: [react(), contentSecurityPolicyPlugin(apiUrl)],
    preview: { headers: securityHeaders(apiUrl) },
    build: {
      rollupOptions: {
        output: {
          // React e o roteador num pedaço próprio: mudam pouco entre versões do app (cache do navegador) e o
          // pedaço principal fica abaixo do limite de aviso de 500 kB.
          // Recharts e as dependências que só ele usa (d3, redux...) no pedaço "charts": carregado só pelas telas
          // com gráficos (lazy), com um nome claro no build em vez do primeiro módulo dele (antes "chartTheme-*.js")
          manualChunks(id) {
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react'
            if (CHART_MODULES.test(id)) return 'charts'
            return undefined
          },
        },
      },
    },
  }
})
