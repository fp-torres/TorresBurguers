import { Logger } from '@nestjs/common';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { corsOrigins } from './app-setup';
import { BRAND } from './brand';
import {
  dbMigrationsRun,
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

    it('DB_SYNCHRONIZE: padrão desligado em todos os ambientes (schema por migrations); o valor explícito decide', () => {
      expect(dbSynchronize({ NODE_ENV: 'development' })).toBe(false);
      expect(dbSynchronize({ NODE_ENV: 'test' })).toBe(false);
      expect(
        dbSynchronize({ NODE_ENV: 'development', DB_SYNCHRONIZE: 'true' }),
      ).toBe(true);
      expect(dbSynchronize({})).toBe(false);
      expect(dbSynchronize({ NODE_ENV: 'production' })).toBe(false);
      expect(
        dbSynchronize({ NODE_ENV: 'production', DB_SYNCHRONIZE: 'true' }),
      ).toBe(true);
      expect(
        dbSynchronize({ NODE_ENV: 'development', DB_SYNCHRONIZE: 'false' }),
      ).toBe(false);
    });

    it('DB_MIGRATIONS_RUN: padrão ligado em todos os ambientes; false desliga', () => {
      expect(dbMigrationsRun({})).toBe(true);
      expect(dbMigrationsRun({ NODE_ENV: 'production' })).toBe(true);
      expect(dbMigrationsRun({ DB_MIGRATIONS_RUN: 'false' })).toBe(false);
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
      const KEY = Buffer.alloc(32, 7).toString('base64');
      expect(
        environmentWarnings({
          NODE_ENV: 'production',
          CREDENTIALS_ENCRYPTION_KEY: KEY,
        }),
      ).toEqual([]);

      expect(environmentWarnings({ CREDENTIALS_ENCRYPTION_KEY: KEY })).toEqual([
        expect.stringContaining('NODE_ENV não definido'),
      ]);
      expect(
        environmentWarnings({
          NODE_ENV: 'prod',
          CREDENTIALS_ENCRYPTION_KEY: KEY,
        }),
      ).toEqual([expect.stringContaining('NODE_ENV="prod"')]);
      expect(
        environmentWarnings({
          NODE_ENV: 'production',
          DB_SYNCHRONIZE: 'on',
          CREDENTIALS_ENCRYPTION_KEY: KEY,
        }),
      ).toEqual([expect.stringContaining('DB_SYNCHRONIZE ligado em produção')]);
    });

    it('avisos da subida: chave de credenciais ausente ou inválida em produção', () => {
      expect(environmentWarnings({ NODE_ENV: 'production' })).toEqual([
        expect.stringContaining('CREDENTIALS_ENCRYPTION_KEY não definida'),
      ]);
      expect(
        environmentWarnings({
          NODE_ENV: 'production',
          CREDENTIALS_ENCRYPTION_KEY: 'curta-demais',
        }),
      ).toEqual([
        expect.stringContaining('CREDENTIALS_ENCRYPTION_KEY inválida'),
      ]);
      expect(
        environmentWarnings({
          NODE_ENV: 'production',
          CREDENTIALS_ENCRYPTION_KEY: 'a'.repeat(64),
        }),
      ).toEqual([]);
      // Em development/test não há avisos (a chave fixa de desenvolvimento é usada)
      expect(environmentWarnings({ NODE_ENV: 'development' })).toEqual([]);
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

    it('em test sem JWT_SECRET usa um segredo fixo (o mesmo para assinar e verificar)', () => {
      const first = jwtSecret({ NODE_ENV: 'test' });
      expect(first).toBeTruthy();
      expect(jwtSecret({ NODE_ENV: 'test', JWT_SECRET: '' })).toBe(first);
    });

    describe('development sem JWT_SECRET', () => {
      let dir: string;

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'jwt-dev-secret-'));
      });

      afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      const devEnv = (file: string): NodeJS.ProcessEnv => ({
        NODE_ENV: 'development',
        JWT_DEV_SECRET_FILE: file,
      });

      it('NÃO é derivado do nome público da marca (ninguém de fora consegue forjar um token)', () => {
        const file = join(dir, 'segredo');
        const secret = jwtSecret(devEnv(file));
        expect(secret).not.toBe(`${BRAND.slug}-dev-jwt-secret`);
        expect(secret).not.toContain(BRAND.slug);
        expect(secret.length).toBeGreaterThanOrEqual(MIN_JWT_SECRET_LENGTH);
        // Cada instalação tem o seu
        expect(jwtSecret(devEnv(join(dir, 'outra-maquina')))).not.toBe(secret);
      });

      it('é aleatório por instalação e guardado fora do Git: o mesmo entre reinícios (as sessões não caem)', () => {
        const file = join(dir, 'pasta-nova', 'segredo');
        const secret = jwtSecret(devEnv(file));
        expect(readFileSync(file, 'utf8')).toBe(secret);
        expect(jwtSecret(devEnv(file))).toBe(secret);
        // Outra execução da API (sem cache) lê o mesmo arquivo
        const saved = join(dir, 'ja-existe');
        writeFileSync(saved, 'b'.repeat(MIN_JWT_SECRET_LENGTH));
        expect(jwtSecret(devEnv(saved))).toBe(
          'b'.repeat(MIN_JWT_SECRET_LENGTH),
        );
      });

      it('arquivo com segredo curto demais é trocado por um novo', () => {
        const file = join(dir, 'curto');
        writeFileSync(file, 'curto');
        const secret = jwtSecret(devEnv(file));
        expect(secret.length).toBeGreaterThanOrEqual(MIN_JWT_SECRET_LENGTH);
        expect(readFileSync(file, 'utf8')).toBe(secret);
      });

      it('sem conseguir gravar: segredo aleatório só desta execução, com aviso (nunca o fixo)', () => {
        const blocker = join(dir, 'arquivo-comum');
        writeFileSync(blocker, 'x');
        const file = join(blocker, 'segredo'); // pasta dentro de um arquivo: não dá para criar
        const secret = jwtSecret(devEnv(file));
        expect(secret).not.toBe(`${BRAND.slug}-dev-jwt-secret`);
        expect(secret.length).toBeGreaterThanOrEqual(MIN_JWT_SECRET_LENGTH);
        expect(jwtSecret(devEnv(file))).toBe(secret);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('não foi possível guardar'),
        );
      });

      it('JWT_SECRET definido continua tendo prioridade (nada é gravado)', () => {
        const file = join(dir, 'segredo');
        expect(
          jwtSecret({ ...devEnv(file), JWT_SECRET: 'segredo-do-env' }),
        ).toBe('segredo-do-env');
        expect(existsSync(file)).toBe(false);
      });
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
