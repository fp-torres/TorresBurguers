import { Logger } from '@nestjs/common';
import { corsOrigins } from './app-setup';
import {
  dbSynchronize,
  demoUsersSeedMode,
  envFlag,
  environmentWarnings,
  isDevOrTest,
  isProduction,
  runtimeEnv,
} from './env';
import {
  DEFAULT_JWT_EXPIRES_IN,
  jwtExpiresIn,
  jwtSecret,
  MIN_JWT_SECRET_LENGTH,
} from './jwt';

const STRONG_SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH);

describe('config', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('envFlag', () => {
    it('lê valores verdadeiros e falsos em vários formatos', () => {
      expect(envFlag('X', false, { X: 'true' })).toBe(true);
      expect(envFlag('X', false, { X: ' TRUE ' })).toBe(true);
      expect(envFlag('X', false, { X: '1' })).toBe(true);
      expect(envFlag('X', true, { X: 'false' })).toBe(false);
      expect(envFlag('X', true, { X: '0' })).toBe(false);
      expect(envFlag('X', true, { X: 'não' })).toBe(false);
    });

    it('vazio ou ausente usa o padrão, sem aviso', () => {
      expect(envFlag('X', true, {})).toBe(true);
      expect(envFlag('X', false, { X: '' })).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('valor desconhecido usa o padrão e avisa no log (uma vez por valor)', () => {
      expect(envFlag('FLAG_COM_ERRO', false, { FLAG_COM_ERRO: 'fasle' })).toBe(
        false,
      );
      expect(envFlag('FLAG_COM_ERRO', false, { FLAG_COM_ERRO: 'fasle' })).toBe(
        false,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('FLAG_COM_ERRO="fasle"'),
      );
    });
  });

  describe('ambiente (fail closed)', () => {
    it('só development e test (sem diferenciar maiúsculas) liberam as facilidades', () => {
      expect(runtimeEnv({ NODE_ENV: 'development' })).toBe('development');
      expect(runtimeEnv({ NODE_ENV: ' Test ' })).toBe('test');
      expect(isDevOrTest({ NODE_ENV: 'DEVELOPMENT' })).toBe(true);
      expect(isProduction({ NODE_ENV: 'test' })).toBe(false);
    });

    it.each([undefined, '', 'production', 'prod', 'staging', 'dev'])(
      'NODE_ENV=%p conta como produção',
      (value) => {
        const env = value === undefined ? {} : { NODE_ENV: value };
        expect(runtimeEnv(env)).toBe('production');
        expect(isProduction(env)).toBe(true);
        expect(isDevOrTest(env)).toBe(false);
      },
    );

    it('DB_SYNCHRONIZE: padrão ligado só em development/test; o valor explícito decide', () => {
      expect(dbSynchronize({ NODE_ENV: 'development' })).toBe(true);
      expect(dbSynchronize({ NODE_ENV: 'test' })).toBe(true);
      expect(dbSynchronize({})).toBe(false);
      expect(dbSynchronize({ NODE_ENV: 'production' })).toBe(false);
      expect(
        dbSynchronize({ NODE_ENV: 'production', DB_SYNCHRONIZE: 'true' }),
      ).toBe(true);
      expect(
        dbSynchronize({ NODE_ENV: 'development', DB_SYNCHRONIZE: 'false' }),
      ).toBe(false);
    });

    it('usuários padrão: criados em development/test, nunca em produção', () => {
      expect(demoUsersSeedMode({ NODE_ENV: 'development' })).toBe('seed');
      expect(
        demoUsersSeedMode({ NODE_ENV: 'test', SEED_DEMO_USERS: 'true' }),
      ).toBe('seed');
      expect(
        demoUsersSeedMode({
          NODE_ENV: 'development',
          SEED_DEMO_USERS: 'false',
        }),
      ).toBe('off');
      expect(demoUsersSeedMode({})).toBe('off');
      expect(demoUsersSeedMode({ NODE_ENV: 'production' })).toBe('off');
      expect(
        demoUsersSeedMode({ NODE_ENV: 'production', SEED_DEMO_USERS: 'true' }),
      ).toBe('refused');
      expect(demoUsersSeedMode({ SEED_DEMO_USERS: 'sim' })).toBe('refused');
    });

    it('avisos da subida: NODE_ENV ausente/desconhecido e synchronize em produção', () => {
      expect(environmentWarnings({ NODE_ENV: 'development' })).toEqual([]);
      expect(
        environmentWarnings({ NODE_ENV: 'test', DB_SYNCHRONIZE: 'true' }),
      ).toEqual([]);
      expect(environmentWarnings({ NODE_ENV: 'production' })).toEqual([]);

      expect(environmentWarnings({})).toEqual([
        expect.stringContaining('NODE_ENV não definido'),
      ]);
      expect(environmentWarnings({ NODE_ENV: 'prod' })).toEqual([
        expect.stringContaining('NODE_ENV="prod"'),
      ]);
      expect(
        environmentWarnings({ NODE_ENV: 'production', DB_SYNCHRONIZE: 'on' }),
      ).toEqual([expect.stringContaining('DB_SYNCHRONIZE ligado em produção')]);
    });
  });

  describe('corsOrigins', () => {
    it('sem CORS_ORIGINS reflete qualquer origem (desenvolvimento)', () => {
      expect(corsOrigins({})).toBe(true);
      expect(corsOrigins({ CORS_ORIGINS: ' , ' })).toBe(true);
      expect(corsOrigins({ CORS_ORIGINS: '*' })).toBe(true);
    });

    it('com CORS_ORIGINS libera só a lista (sem espaços e sem barra final)', () => {
      expect(
        corsOrigins({
          CORS_ORIGINS: 'https://loja.com.br/, https://painel.loja.com.br',
        }),
      ).toEqual(['https://loja.com.br', 'https://painel.loja.com.br']);
    });
  });

  describe('jwtSecret', () => {
    it('usa JWT_SECRET quando definido', () => {
      expect(
        jwtSecret({ NODE_ENV: 'development', JWT_SECRET: 'segredo-curto' }),
      ).toBe('segredo-curto');
      expect(
        jwtSecret({ NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET }),
      ).toBe(STRONG_SECRET);
      expect(jwtSecret({ JWT_SECRET: STRONG_SECRET })).toBe(STRONG_SECRET);
    });

    it('em produção sem JWT_SECRET impede a subida', () => {
      expect(() => jwtSecret({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
      expect(() =>
        jwtSecret({ NODE_ENV: 'production', JWT_SECRET: '   ' }),
      ).toThrow(/JWT_SECRET não definido/);
    });

    it('NODE_ENV vazio ou desconhecido conta como produção: sem segredo padrão', () => {
      expect(() => jwtSecret({})).toThrow(/JWT_SECRET não definido/);
      expect(() => jwtSecret({ NODE_ENV: 'prod' })).toThrow(
        /JWT_SECRET não definido/,
      );
    });

    it(`em produção recusa segredo com menos de ${MIN_JWT_SECRET_LENGTH} caracteres`, () => {
      expect(() =>
        jwtSecret({
          NODE_ENV: 'production',
          JWT_SECRET: 'a'.repeat(MIN_JWT_SECRET_LENGTH - 1),
        }),
      ).toThrow(/JWT_SECRET fraco/);
      expect(() => jwtSecret({ JWT_SECRET: 'segredo-do-ambiente' })).toThrow(
        /JWT_SECRET fraco/,
      );
    });

    it('em development/test sem JWT_SECRET usa um segredo fixo (o mesmo para assinar e verificar)', () => {
      const first = jwtSecret({ NODE_ENV: 'development' });
      expect(first).toBeTruthy();
      expect(jwtSecret({ NODE_ENV: 'test' })).toBe(first);
      expect(jwtSecret({ NODE_ENV: 'test', JWT_SECRET: '' })).toBe(first);
    });
  });

  describe('jwtExpiresIn', () => {
    it('padrão 7d', () => {
      expect(jwtExpiresIn({})).toBe(DEFAULT_JWT_EXPIRES_IN);
      expect(DEFAULT_JWT_EXPIRES_IN).toBe('7d');
    });

    it('aceita intervalos no formato do jsonwebtoken', () => {
      expect(jwtExpiresIn({ JWT_EXPIRES_IN: '12h' })).toBe('12h');
      expect(jwtExpiresIn({ JWT_EXPIRES_IN: '30 days' })).toBe('30 days');
    });

    it('só números = segundos', () => {
      expect(jwtExpiresIn({ JWT_EXPIRES_IN: '3600' })).toBe(3600);
    });

    it('valor inválido cai no padrão', () => {
      expect(jwtExpiresIn({ JWT_EXPIRES_IN: 'sete dias' })).toBe(
        DEFAULT_JWT_EXPIRES_IN,
      );
    });
  });
});
