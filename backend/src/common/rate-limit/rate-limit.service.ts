import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { envFlag } from '../../config/env';

/** Uma regra de limite: no máximo `limit` eventos por chave a cada `windowSeconds`. */
export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

/**
 * Políticas padrão (sobrescreva por ambiente com RATE_LIMIT_<NOME>=limite/segundos,
 * ex.: RATE_LIMIT_SIGNUP=1000/3600). RATE_LIMIT_ENABLED=false desliga tudo (não recomendado).
 */
export const RATE_LIMIT_POLICIES = {
  /** Falhas de login por IP + e-mail (força bruta numa conta). */
  LOGIN_FAILURES: { limit: 10, windowSeconds: 15 * 60 },
  /** Falhas de login por IP (várias contas a partir do mesmo endereço). */
  LOGIN_FAILURES_IP: { limit: 100, windowSeconds: 15 * 60 },
  /**
   * Falhas de login por conta (e-mail), somando todos os IPs (força bruta distribuída). Atingido o
   * teto, só origens conhecidas (IP de uma sessão ativa da conta) continuam tentando.
   */
  LOGIN_FAILURES_ACCOUNT: { limit: 50, windowSeconds: 60 * 60 },
  /** Logins corretos por IP + e-mail (cada um roda o bcrypt, cria uma sessão e grava auditoria). */
  LOGIN_SUCCESS: { limit: 200, windowSeconds: 10 * 60 },
  /** "Esqueci minha senha" por IP. */
  FORGOT_PASSWORD: { limit: 5, windowSeconds: 15 * 60 },
  /** Redefinições/aceites de link por IP (tokens inválidos). */
  TOKEN_REDEEM: { limit: 20, windowSeconds: 15 * 60 },
  /** Cadastro público de clientes por IP. */
  SIGNUP: { limit: 30, windowSeconds: 60 * 60 },
  /** Autoatendimento de novos estabelecimentos por IP. */
  STORE_SIGNUP: { limit: 5, windowSeconds: 60 * 60 },
  /** Busca de CEP por IP (a rota é um proxy público para os serviços de CEP). */
  CEP_LOOKUP: { limit: 60, windowSeconds: 60 },
  /** Pedidos criados por cliente em uma loja (chave: loja + cliente). */
  ORDER_CREATE: { limit: 10, windowSeconds: 10 * 60 },
  /** Pedidos criados por IP (todas as lojas). */
  ORDER_CREATE_IP: { limit: 60, windowSeconds: 10 * 60 },
  /** Cobranças PIX/cartão criadas por cliente em uma loja (chave: loja + cliente). */
  PAYMENT_CREATE: { limit: 10, windowSeconds: 10 * 60 },
  /** Cobranças PIX/cartão criadas por IP (todas as lojas). */
  PAYMENT_CREATE_IP: { limit: 60, windowSeconds: 10 * 60 },
  /** Notificações do Mercado Pago (webhook público dos pagamentos do delivery) por IP. */
  PAYMENT_WEBHOOK: { limit: 300, windowSeconds: 60 },
  /** Envios de imagem por conta (avatar, produto, adicional, logo, uploads). */
  UPLOAD: { limit: 30, windowSeconds: 10 * 60 },
  /** Criação/edição de endereços por conta. */
  ADDRESS_WRITE: { limit: 30, windowSeconds: 10 * 60 },
  /**
   * Criação de contas da equipe, convites e troca do e-mail de um membro por quem administra a loja
   * (chave: a loja).
   */
  TEAM_WRITE: { limit: 30, windowSeconds: 10 * 60 },
  /**
   * Trocas da própria senha ou do próprio e-mail que falharam (senha atual errada ou e-mail já em
   * uso), por conta e por IP. Uma troca em andamento também ocupa uma vaga até terminar.
   */
  CREDENTIALS_CHANGE: { limit: 10, windowSeconds: 15 * 60 },
  /** Pedidos de verificação e de troca do próprio e-mail, por conta (429). */
  ACCOUNT_EMAIL: { limit: 5, windowSeconds: 60 * 60 },
  /**
   * E-mails de verificação e de troca de e-mail por endereço de destino. Silencioso (acima dele nada é
   * enviado, sem aviso a quem pediu): protege a caixa de terceiros.
   */
  ACCOUNT_EMAIL_TARGET: { limit: 3, windowSeconds: 60 * 60 },
  /** Renovações da sessão do site (POST /auth/web/refresh) por IP: cada aba ativa renova a cada ~12 min. */
  REFRESH: { limit: 120, windowSeconds: 5 * 60 },
  /**
   * Links de pagamento da assinatura (POST /store/subscription/checkout) por loja: cada um pode chamar o
   * provedor (Mercado Pago) segurando uma conexão do banco até a resposta.
   */
  SUBSCRIPTION_CHECKOUT: { limit: 10, windowSeconds: 10 * 60 },
} satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

/** Chave do TEAM_WRITE: a loja (vários ADMINs da mesma loja dividem o limite). */
export function teamWriteKey(storeId: number): string {
  return `store:${storeId}`;
}

export const TOO_MANY_ATTEMPTS_MESSAGE =
  'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.';

/** 429 no formato de erro do contrato ({ statusCode, message, error }), como as exceções do Nest. */
function tooManyAttempts(): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: TOO_MANY_ATTEMPTS_MESSAGE,
      error: 'Too Many Requests',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** Lê RATE_LIMIT_<NOME> ("limite/segundos"); valor inválido → padrão. */
export function resolvePolicy(
  name: RateLimitPolicyName,
  env: NodeJS.ProcessEnv = process.env,
): RateLimitPolicy {
  const fallback = RATE_LIMIT_POLICIES[name];
  const raw = env[`RATE_LIMIT_${name}`]?.trim();
  const match = raw?.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return fallback;
  const limit = Number(match[1]);
  const windowSeconds = Number(match[2]);
  return limit > 0 && windowSeconds > 0 ? { limit, windowSeconds } : fallback;
}

/** Chaves conferidas por chamada na limpeza periódica (em fatias: não trava o event loop). */
export const RATE_LIMIT_SWEEP_BATCH = 5_000;
/** Intervalo mínimo entre duas limpezas completas. */
const SWEEP_INTERVAL_MS = 60_000;

/** Janela (ms) da regra do balde ("NOME:chave"); nome desconhecido → a maior janela (conservador). */
function bucketWindowMs(bucket: string): number {
  const name = bucket.slice(0, bucket.indexOf(':'));
  if (Object.prototype.hasOwnProperty.call(RATE_LIMIT_POLICIES, name))
    return resolvePolicy(name as RateLimitPolicyName).windowSeconds * 1000;
  return (
    Math.max(
      ...Object.keys(RATE_LIMIT_POLICIES).map(
        (policy) => resolvePolicy(policy as RateLimitPolicyName).windowSeconds,
      ),
    ) * 1000
  );
}

/** Desfaz uma reserva feita com take() (idempotente). */
export type RateLimitRelease = () => void;

/**
 * Limite de tentativas em memória (janela deslizante por chave). Vale por instância da API:
 * com várias instâncias, cada uma conta as suas (para um limite global use um armazenamento
 * compartilhado, como Redis — evolução documentada).
 *
 * Atomicidade: conferir e contar acontecem na mesma chamada síncrona (consume e take), sem nenhum
 * await no meio, então requisições simultâneas na mesma instância nunca dividem a mesma vaga.
 * Quando o evento só se confirma depois de um trabalho assíncrono (ex.: conferir a senha), use
 * take() ANTES desse trabalho e desfaça a reserva se o evento não aconteceu: a tentativa em
 * andamento já conta no limite (conferir antes e contar depois deixaria uma rajada passar inteira).
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();
  /** Limpeza em andamento (continua de onde parou na próxima chamada). */
  private sweepCursor: Iterator<[string, number[]]> | null = null;

  private enabled(): boolean {
    return envFlag('RATE_LIMIT_ENABLED', true);
  }

  private bucket(name: RateLimitPolicyName, key: string): string {
    return `${name}:${key.toLowerCase()}`;
  }

  private recent(bucket: string, windowMs: number, now: number): number[] {
    const list = (this.hits.get(bucket) ?? []).filter(
      (at) => now - at < windowMs,
    );
    if (list.length) this.hits.set(bucket, list);
    else this.hits.delete(bucket);
    return list;
  }

  /** Limite já atingido para a chave? (não conta um novo evento) */
  isLimited(name: RateLimitPolicyName, key: string, now = Date.now()): boolean {
    if (!this.enabled()) return false;
    const policy = resolvePolicy(name);
    return (
      this.recent(this.bucket(name, key), policy.windowSeconds * 1000, now)
        .length >= policy.limit
    );
  }

  /** Registra um evento (ex.: senha errada). */
  hit(name: RateLimitPolicyName, key: string, now = Date.now()): void {
    if (!this.enabled()) return;
    this.sweep(now);
    const policy = resolvePolicy(name);
    const bucket = this.bucket(name, key);
    const list = this.recent(bucket, policy.windowSeconds * 1000, now);
    list.push(now);
    this.hits.set(bucket, list);
  }

  /** Conta o evento e lança 429 se passou do limite (uso: cadastro, "esqueci a senha"). Atômico. */
  consume(name: RateLimitPolicyName, key: string, now = Date.now()): void {
    if (this.isLimited(name, key, now)) {
      this.logger.warn(`Limite ${name} atingido (${key}).`);
      throw tooManyAttempts();
    }
    this.hit(name, key, now);
  }

  /**
   * Reserva atômica: lança 429 se a chave já está no limite; senão conta o evento AGORA e devolve
   * a função que desfaz essa contagem (ex.: a senha estava certa, então não foi uma falha).
   * Enquanto a tentativa está em andamento ela ocupa uma vaga: uma rajada de requisições
   * simultâneas não passa do limite.
   */
  take(
    name: RateLimitPolicyName,
    key: string,
    now = Date.now(),
  ): RateLimitRelease {
    if (!this.enabled()) return () => undefined;
    this.consume(name, key, now);
    const bucket = this.bucket(name, key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const list = this.hits.get(bucket);
      const index = list ? list.indexOf(now) : -1;
      if (!list || index < 0) return;
      list.splice(index, 1);
      if (!list.length) this.hits.delete(bucket);
    };
  }

  /** Lança 429 se a chave já está no limite (uso: antes de conferir a senha). */
  assertNotLimited(name: RateLimitPolicyName, key: string): void {
    if (this.isLimited(name, key)) {
      throw tooManyAttempts();
    }
  }

  /** Zera a chave (ex.: login bem-sucedido). */
  reset(name: RateLimitPolicyName, key: string): void {
    this.hits.delete(this.bucket(name, key));
  }

  /**
   * Limpeza periódica (evita crescer sem limite): a cada SWEEP_INTERVAL_MS percorre os baldes em
   * fatias de RATE_LIMIT_SWEEP_BATCH por chamada e tira de cada um só os eventos fora da janela da
   * PRÓPRIA regra (ex.: CEP_LOOKUP sai depois de 60 s, não depois da maior janela de todas). Eventos
   * dentro da janela nunca saem: ninguém zera o próprio balde forçando uma limpeza.
   */
  private sweep(now: number): void {
    if (!this.sweepCursor) {
      if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
      this.lastSweep = now;
      this.sweepCursor = this.hits.entries();
    }
    const windows = new Map<string, number>();
    for (let index = 0; index < RATE_LIMIT_SWEEP_BATCH; index++) {
      const next = this.sweepCursor.next();
      if (next.done) {
        this.sweepCursor = null;
        return;
      }
      const [bucket, list] = next.value;
      const name = bucket.slice(0, bucket.indexOf(':'));
      let windowMs = windows.get(name);
      if (windowMs === undefined) {
        windowMs = bucketWindowMs(bucket);
        windows.set(name, windowMs);
      }
      const fresh = list.filter((at) => now - at < windowMs);
      if (!fresh.length) this.hits.delete(bucket);
      else if (fresh.length !== list.length) this.hits.set(bucket, fresh);
    }
  }

  /** Quantos baldes estão guardados (diagnóstico e testes). */
  get size(): number {
    return this.hits.size;
  }
}
