import { Injectable, Logger } from '@nestjs/common';
import { BRAND } from '../config/brand';

/** Endereço do CEP no formato do ViaCEP (o que os front-ends já usam). */
export interface CepLookupResult {
  cep: string;
  logradouro: string;
  complemento: string;
  bairro: string;
  localidade: string;
  uf: string;
}

/** Resultado da consulta: encontrado, inexistente ou serviços fora do ar (nunca lança). */
export type CepLookupOutcome =
  | { status: 'found'; address: CepLookupResult }
  | { status: 'not_found' }
  | { status: 'unavailable' };

/**
 * Para que a consulta serve:
 * - public: GET /addresses/cep/:cep (formulário de endereço);
 * - zone: conferência do bairro, da cidade e da UF pelo CEP (cadastro do endereço e orçamento), que decide a
 *   zona de entrega. Prazo menor e, em NODE_ENV=test sem CEP_LOOKUP_FAKE, nunca vai à internet.
 */
export type CepLookupPurpose = 'public' | 'zone';

/** Tempo máximo de espera por cada serviço de CEP na busca pública. */
export const CEP_TIMEOUT_MS = 5000;
/** Na conferência do bairro (cadastro e orçamento): menor, para não segurar o pedido. */
export const CEP_ZONE_TIMEOUT_MS = 3000;
/** Um serviço que falhou (rede, prazo, HTTP inesperado) fica de fora por este tempo. */
export const CEP_SERVICE_COOLDOWN_MS = 60_000;
/** Cache em memória por instância: CEP encontrado vale 24 h; inexistente, 1 h. */
export const CEP_FOUND_TTL_MS = 24 * 60 * 60 * 1000;
export const CEP_NOT_FOUND_TTL_MS = 60 * 60 * 1000;
const CEP_CACHE_MAX_ENTRIES = 5000;

/** Valor do mapa falso que simula os serviços fora do ar. */
const FAKE_UNAVAILABLE = 'unavailable';

type CepService = 'viacep' | 'brasilapi';

/**
 * Modo de operação:
 * - network: produção e desenvolvimento (ViaCEP com a BrasilAPI de reserva);
 * - test-network: NODE_ENV=test sem CEP_LOOKUP_FAKE (a busca pública continua indo à internet, como antes;
 *   a conferência do bairro não consulta nada e fica como "serviço indisponível");
 * - fake: NODE_ENV=test com CEP_LOOKUP_FAKE (busca pública e conferência usam só o mapa).
 */
type CepLookupMode =
  | { kind: 'network' }
  | { kind: 'test-network' }
  | { kind: 'fake'; entries: Map<string, CepLookupOutcome> };

interface JsonResponse {
  status: number;
  data: Record<string, unknown> | null;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/** "22041-001" → "22041001"; outro formato → null. */
export function cepDigits(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits =
    typeof value === 'number'
      ? String(value).padStart(8, '0')
      : value.replace(/\D/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

export const formatCep = (digits: string) =>
  `${digits.slice(0, 5)}-${digits.slice(5)}`;

/**
 * Lê CEP_LOOKUP_FAKE: { "22041001": { "logradouro", "bairro", "localidade", "uf", "complemento"? },
 * "28999999": "unavailable" }. CEP fora do mapa = inexistente. Inválido → Error com a explicação.
 */
export function parseFakeCepMap(raw: string): Map<string, CepLookupOutcome> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('o valor não é um JSON válido.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('use um objeto { "<CEP>": { bairro, localidade, uf } }.');
  }
  const entries = new Map<string, CepLookupOutcome>();
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const digits = cepDigits(key);
    if (!digits) throw new Error(`"${key}" não é um CEP com 8 dígitos.`);
    if (
      typeof value === 'string' &&
      value.trim().toLowerCase() === FAKE_UNAVAILABLE
    ) {
      entries.set(digits, { status: 'unavailable' });
    } else if (value === null) {
      entries.set(digits, { status: 'not_found' });
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const entry = value as Record<string, unknown>;
      entries.set(digits, {
        status: 'found',
        address: {
          cep: formatCep(digits),
          logradouro: text(entry.logradouro),
          complemento: text(entry.complemento),
          bairro: text(entry.bairro),
          localidade: text(entry.localidade),
          uf: text(entry.uf).toUpperCase(),
        },
      });
    } else {
      throw new Error(
        `o CEP ${key} precisa de um objeto { bairro, localidade, uf }, null (inexistente) ou "${FAKE_UNAVAILABLE}".`,
      );
    }
  }
  return entries;
}

/**
 * Busca de CEP (ViaCEP com a BrasilAPI de reserva) compartilhada pela rota pública e pela conferência do
 * bairro dos endereços. Cache em memória (encontrado 24 h, inexistente 1 h), consultas simultâneas do mesmo
 * CEP compartilham a chamada e um serviço que falhou fica de fora por CEP_SERVICE_COOLDOWN_MS (sem esperar o
 * prazo de novo a cada consulta).
 *
 * Testes determinísticos: SÓ em NODE_ENV=test, CEP_LOOKUP_FAKE com um mapa de CEPs substitui os serviços.
 */
@Injectable()
export class CepLookupService {
  private readonly logger = new Logger(CepLookupService.name);
  private readonly mode: CepLookupMode;
  private readonly cache = new Map<
    string,
    { outcome: CepLookupOutcome; expiresAt: number }
  >();
  private readonly inflight = new Map<string, Promise<CepLookupOutcome>>();
  private readonly downUntil: Record<CepService, number> = {
    viacep: 0,
    brasilapi: 0,
  };

  constructor() {
    this.mode = this.readMode(process.env);
  }

  private readMode(env: NodeJS.ProcessEnv): CepLookupMode {
    const raw = env.CEP_LOOKUP_FAKE?.trim();
    if (env.NODE_ENV !== 'test') {
      if (raw)
        this.logger.warn(
          'CEP_LOOKUP_FAKE foi ignorado: o modo de CEP falso só vale com NODE_ENV=test.',
        );
      return { kind: 'network' };
    }
    if (!raw) return { kind: 'test-network' };
    try {
      return { kind: 'fake', entries: parseFakeCepMap(raw) };
    } catch (error) {
      this.logger.error(
        `CEP_LOOKUP_FAKE inválido (${(error as Error).message}). Todos os CEPs ficam como inexistentes.`,
      );
      return { kind: 'fake', entries: new Map() };
    }
  }

  /** Modo de CEP falso ativo (NODE_ENV=test + CEP_LOOKUP_FAKE). */
  get fake(): boolean {
    return this.mode.kind === 'fake';
  }

  /** Nunca lança: CEP com formato inválido responde como inexistente (quem chama valida antes). */
  async lookup(
    cep: string,
    purpose: CepLookupPurpose = 'public',
  ): Promise<CepLookupOutcome> {
    const digits = cepDigits(cep);
    if (!digits) return { status: 'not_found' };

    if (this.mode.kind === 'fake')
      return this.mode.entries.get(digits) ?? { status: 'not_found' };
    // Testes sem o mapa falso: a conferência do bairro não depende da internet (o bairro digitado vale)
    if (this.mode.kind === 'test-network' && purpose === 'zone')
      return { status: 'unavailable' };

    const cached = this.cache.get(digits);
    if (cached && cached.expiresAt > Date.now()) return cached.outcome;
    if (cached) this.cache.delete(digits);

    const running = this.inflight.get(digits);
    if (running) return running;
    const task = this.fetchOutcome(
      digits,
      purpose === 'zone' ? CEP_ZONE_TIMEOUT_MS : CEP_TIMEOUT_MS,
    ).finally(() => this.inflight.delete(digits));
    this.inflight.set(digits, task);
    return task;
  }

  private async fetchOutcome(
    digits: string,
    timeoutMs: number,
  ): Promise<CepLookupOutcome> {
    let notFound = false;

    // 1ª tentativa: ViaCEP (responde 200 com { erro: true } quando o CEP não existe)
    if (this.available('viacep')) {
      try {
        const { status, data } = await this.getJson(
          `https://viacep.com.br/ws/${digits}/json/`,
          timeoutMs,
        );
        if (status === 200 && data && !data.erro) {
          return this.remember(digits, {
            status: 'found',
            address: {
              cep: formatCep(text(data.cep).replace(/\D/g, '') || digits),
              logradouro: text(data.logradouro),
              complemento: text(data.complemento),
              bairro: text(data.bairro),
              localidade: text(data.localidade),
              uf: text(data.uf),
            },
          });
        }
        if (status === 200) notFound = true;
        else this.markDown('viacep', `ViaCEP respondeu HTTP ${status}.`);
      } catch (error) {
        this.markDown(
          'viacep',
          `ViaCEP indisponível: ${(error as Error).message}`,
        );
      }
    }

    // 2ª tentativa: BrasilAPI (responde 404 quando o CEP não existe)
    if (this.available('brasilapi')) {
      try {
        const { status, data } = await this.getJson(
          `https://brasilapi.com.br/api/cep/v1/${digits}`,
          timeoutMs,
        );
        if (status === 200 && data) {
          return this.remember(digits, {
            status: 'found',
            address: {
              cep: formatCep(text(data.cep).replace(/\D/g, '') || digits),
              logradouro: text(data.street),
              complemento: '',
              bairro: text(data.neighborhood),
              localidade: text(data.city),
              uf: text(data.state),
            },
          });
        }
        if (status === 404) notFound = true;
        else this.markDown('brasilapi', `BrasilAPI respondeu HTTP ${status}.`);
      } catch (error) {
        this.markDown(
          'brasilapi',
          `BrasilAPI indisponível: ${(error as Error).message}`,
        );
      }
    }

    if (notFound) return this.remember(digits, { status: 'not_found' });
    return { status: 'unavailable' };
  }

  private available(service: CepService): boolean {
    return this.downUntil[service] <= Date.now();
  }

  private markDown(service: CepService, reason: string): void {
    this.downUntil[service] = Date.now() + CEP_SERVICE_COOLDOWN_MS;
    this.logger.warn(reason);
  }

  private remember(
    digits: string,
    outcome: CepLookupOutcome,
  ): CepLookupOutcome {
    if (outcome.status === 'unavailable') return outcome;
    if (this.cache.size >= CEP_CACHE_MAX_ENTRIES) {
      // Map guarda a ordem de inserção: sai o mais antigo
      for (const oldest of this.cache.keys()) {
        this.cache.delete(oldest);
        break;
      }
    }
    this.cache.set(digits, {
      outcome,
      expiresAt:
        Date.now() +
        (outcome.status === 'found' ? CEP_FOUND_TTL_MS : CEP_NOT_FOUND_TTL_MS),
    });
    return outcome;
  }

  private async getJson(url: string, timeoutMs: number): Promise<JsonResponse> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `${BRAND.slug}-api`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, data: null };
    }
    const data = (await response.json()) as unknown;
    return {
      status: response.status,
      data:
        data && typeof data === 'object'
          ? (data as Record<string, unknown>)
          : null,
    };
  }
}
