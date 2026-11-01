import { Controller, Get, INestApplication, Logger, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp, trustProxySetting } from './app-setup';

@Controller('quem-sou')
class WhoAmIController {
  @Get()
  ip(@Req() req: Request) {
    return { ip: req.ip };
  }
}

/** Sobe a API de teste com o TRUST_PROXY informado (setupApp lê o ambiente na subida). */
async function appWith(
  trustProxy: string | undefined,
): Promise<INestApplication<App>> {
  const previous = process.env.TRUST_PROXY;
  if (trustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxy;
  try {
    const moduleRef = await Test.createTestingModule({
      controllers: [WhoAmIController],
    }).compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    setupApp(app);
    await app.init();
    return app;
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
}

async function ipSeen(
  app: INestApplication<App>,
  forwardedFor: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .get('/quem-sou')
    .set('X-Forwarded-For', forwardedFor)
    .expect(200);
  return (res.body as { ip: string }).ip;
}

describe('TRUST_PROXY', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('trustProxySetting', () => {
    it('true vira 1 salto: o Express nunca confia no X-Forwarded-For inteiro', () => {
      expect(trustProxySetting({ TRUST_PROXY: 'true' })).toBe(1);
      expect(trustProxySetting({ TRUST_PROXY: ' TRUE ' })).toBe(1);
    });

    it('mantém false, número de saltos, listas de IPs/sub-redes e o vazio (desligado)', () => {
      expect(trustProxySetting({ TRUST_PROXY: 'false' })).toBe(false);
      expect(trustProxySetting({ TRUST_PROXY: '2' })).toBe(2);
      expect(trustProxySetting({ TRUST_PROXY: 'loopback, 10.0.0.0/8' })).toBe(
        'loopback, 10.0.0.0/8',
      );
      expect(trustProxySetting({ TRUST_PROXY: '' })).toBeUndefined();
      expect(trustProxySetting({})).toBeUndefined();
    });
  });

  it('TRUST_PROXY=true atrás de um proxy que ACRESCENTA ao X-Forwarded-For: vale o IP que o proxy viu, não o forjado', async () => {
    const app = await appWith('true');
    try {
      // O cliente mandou "6.6.6.6"; o proxy (Nginx, ALB, ngrok...) acrescentou o IP real
      expect(await ipSeen(app, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('TRUST_PROXY=true'),
      );
    } finally {
      await app.close();
    }
  });

  it('TRUST_PROXY=1 (recomendado) usa o IP acrescentado pelo proxy, sem aviso', async () => {
    const app = await appWith('1');
    try {
      expect(await ipSeen(app, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining('TRUST_PROXY=true'),
      );
    } finally {
      await app.close();
    }
  });

  it('sub-rede IPv4-mapeada com prefixo curto (::ffff:10.0.0.0/8) não confia em qualquer IP (proxy-addr >= 2.0.8)', async () => {
    // GHSA-jqcg-44mw-7w3h: no proxy-addr 2.0.7 essa sub-rede casava com TODOS os IPs e o cliente
    // escolhia o próprio req.ip pelo X-Forwarded-For
    const app = await appWith('::ffff:10.0.0.0/8');
    try {
      expect(await ipSeen(app, '6.6.6.6')).not.toBe('6.6.6.6');
    } finally {
      await app.close();
    }
  });

  it('lista com o proxy de verdade (loopback) continua funcionando', async () => {
    const app = await appWith('loopback');
    try {
      expect(await ipSeen(app, '203.0.113.9')).toBe('203.0.113.9');
    } finally {
      await app.close();
    }
  });

  it('vazio: o X-Forwarded-For é ignorado', async () => {
    const app = await appWith(undefined);
    try {
      expect(await ipSeen(app, '6.6.6.6')).not.toBe('6.6.6.6');
    } finally {
      await app.close();
    }
  });
});
