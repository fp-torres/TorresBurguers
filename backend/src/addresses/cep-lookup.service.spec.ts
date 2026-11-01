import { Logger } from '@nestjs/common';
import {
  CEP_FOUND_TTL_MS,
  CEP_SERVICE_COOLDOWN_MS,
  CepLookupService,
  cepDigits,
  parseFakeCepMap,
} from './cep-lookup.service';

const json = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    body: { cancel: () => Promise.resolve() },
  }) as unknown as Response;

const VIACEP_COPACABANA = {
  cep: '22041-001',
  logradouro: 'Avenida Atlântica',
  bairro: 'Copacabana',
  localidade: 'Rio de Janeiro',
  uf: 'RJ',
};

const FAKE = JSON.stringify({
  '22041-001': {
    logradouro: 'Avenida Atlântica',
    bairro: 'Copacabana',
    localidade: 'Rio de Janeiro',
    uf: 'rj',
  },
  '28999000': { bairro: '', localidade: 'Cidade Única', uf: 'RJ' },
  '28999999': 'unavailable',
  '28999998': null,
});

describe('CepLookupService', () => {
  const originalEnv = { ...process.env };
  let fetchMock: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    delete process.env.CEP_LOOKUP_FAKE;
    fetchMock = jest.spyOn(global, 'fetch');
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    process.env = originalEnv;
  });

  it('CEP: só os 8 dígitos (com ou sem máscara); outro formato → null', () => {
    expect(cepDigits('22041-001')).toBe('22041001');
    expect(cepDigits(1001000)).toBe('01001000');
    expect(cepDigits('123')).toBeNull();
    expect(cepDigits(null)).toBeNull();
  });

  describe('modo de CEP falso (CEP_LOOKUP_FAKE) — só em NODE_ENV=test', () => {
    it('lê o mapa: encontrado (formato ViaCEP), sem bairro, inexistente e fora do ar', async () => {
      process.env.CEP_LOOKUP_FAKE = FAKE;
      const service = new CepLookupService();
      expect(service.fake).toBe(true);

      await expect(service.lookup('22041001', 'zone')).resolves.toEqual({
        status: 'found',
        address: {
          cep: '22041-001',
          logradouro: 'Avenida Atlântica',
          complemento: '',
          bairro: 'Copacabana',
          localidade: 'Rio de Janeiro',
          uf: 'RJ',
        },
      });
      await expect(service.lookup('28999-000')).resolves.toMatchObject({
        status: 'found',
        address: { bairro: '', localidade: 'Cidade Única' },
      });
      await expect(service.lookup('28999999')).resolves.toEqual({
        status: 'unavailable',
      });
      await expect(service.lookup('28999998')).resolves.toEqual({
        status: 'not_found',
      });
      // Fora do mapa = inexistente, sem ir à internet
      await expect(service.lookup('01001000', 'public')).resolves.toEqual({
        status: 'not_found',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fora de NODE_ENV=test o mapa é ignorado (com aviso) e a consulta vai aos serviços', async () => {
      process.env.NODE_ENV = 'production';
      process.env.CEP_LOOKUP_FAKE = FAKE;
      const service = new CepLookupService();
      expect(service.fake).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('CEP_LOOKUP_FAKE foi ignorado'),
      );
      fetchMock.mockResolvedValueOnce(json(200, VIACEP_COPACABANA));
      await expect(service.lookup('22041001', 'zone')).resolves.toMatchObject({
        status: 'found',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('mapa inválido: erro no log e todos os CEPs ficam como inexistentes (nunca vai à internet)', async () => {
      for (const raw of ['{', '[]', '{"123": {}}', '{"22041001": 5}']) {
        expect(() => parseFakeCepMap(raw)).toThrow();
        process.env.CEP_LOOKUP_FAKE = raw;
        const service = new CepLookupService();
        await expect(service.lookup('22041001')).resolves.toEqual({
          status: 'not_found',
        });
      }
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('CEP_LOOKUP_FAKE inválido'),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('NODE_ENV=test sem o mapa: a conferência do bairro não consulta a internet; a busca pública continua', async () => {
      const service = new CepLookupService();
      await expect(service.lookup('22041001', 'zone')).resolves.toEqual({
        status: 'unavailable',
      });
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockResolvedValueOnce(json(200, VIACEP_COPACABANA));
      await expect(service.lookup('22041001', 'public')).resolves.toMatchObject(
        { status: 'found' },
      );
    });
  });

  describe('serviços de CEP (produção e desenvolvimento)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('cache: CEP encontrado não é consultado de novo; consultas simultâneas dividem a chamada', async () => {
      const service = new CepLookupService();
      fetchMock.mockResolvedValue(json(200, VIACEP_COPACABANA));
      const [a, b] = await Promise.all([
        service.lookup('22041001', 'zone'),
        service.lookup('22041-001', 'public'),
      ]);
      expect(a).toEqual(b);
      await service.lookup('22041001', 'zone');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Depois de 24 h, consulta de novo
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + CEP_FOUND_TTL_MS + 1);
      await service.lookup('22041001', 'zone');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('CEP inexistente também fica no cache; serviço fora do ar não', async () => {
      const service = new CepLookupService();
      fetchMock
        .mockResolvedValueOnce(json(200, { erro: 'true' }))
        .mockResolvedValueOnce(json(404, {}));
      await expect(service.lookup('99999999')).resolves.toEqual({
        status: 'not_found',
      });
      await service.lookup('99999999');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const down = new CepLookupService();
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new Error('timeout'));
      await expect(down.lookup('20040002', 'zone')).resolves.toEqual({
        status: 'unavailable',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it(`serviço que falhou fica de fora por ${CEP_SERVICE_COOLDOWN_MS / 1000} s (sem esperar o prazo de novo)`, async () => {
      const service = new CepLookupService();
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue(
          json(200, {
            cep: '01001000',
            street: 'Praça da Sé',
            neighborhood: 'Sé',
            city: 'São Paulo',
            state: 'SP',
          }),
        );
      await expect(service.lookup('01001000')).resolves.toMatchObject({
        status: 'found',
        address: { bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' },
      });
      // Outro CEP logo depois: vai direto à BrasilAPI
      fetchMock.mockClear();
      await service.lookup('01002000');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [unknown];
      expect(String(url)).toContain('brasilapi');

      // Os dois fora do ar: responde "indisponível" na hora, sem chamar nada
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(json(503, {}));
      await service.lookup('01003000');
      fetchMock.mockClear();
      await expect(service.lookup('01004000')).resolves.toEqual({
        status: 'unavailable',
      });
      expect(fetchMock).not.toHaveBeenCalled();

      // Passado o intervalo, volta a tentar
      const now = Date.now();
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(now + CEP_SERVICE_COOLDOWN_MS + 1);
      await service.lookup('01005000');
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
