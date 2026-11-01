import { ForbiddenException, Logger } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  StoreStorageGate,
  formatStorageSize,
  registerStoreStorageLimits,
  storageQuotaMessage,
  storeStorageGate,
  unregisterStoreStorageLimits,
  type StoreStorageLimitProvider,
} from './storage-quota';
import { BYTES_PER_MB, StorageUsageTracker } from './storage-usage';

const MB = BYTES_PER_MB;

describe('Cota de armazenamento da loja (StoreStorageGate)', () => {
  let dir: string;
  let tracker: StorageUsageTracker;
  let limitMb: number | null;
  const provider: StoreStorageLimitProvider = {
    storageLimit: jest.fn(() =>
      Promise.resolve(
        limitMb === null ? null : { planName: 'Básico', limitMb },
      ),
    ),
  };
  const gate = () => new StoreStorageGate(tracker, () => provider);
  const plant = (name: string, bytes: number) =>
    writeFileSync(join(dir, name), Buffer.alloc(bytes, 1));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'storage-quota-spec-'));
    tracker = new StorageUsageTracker({ dir: () => dir });
    limitMb = 1;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('abaixo do limite: precheck devolve o limite e a reserva soma o arquivo', async () => {
    plant('s3-a.webp', MB / 2);
    const limit = await gate().precheck(3);
    expect(limit).toEqual({ planName: 'Básico', limitMb: 1 });
    await gate().reserve(3, MB / 4, limit);
    await expect(tracker.usage(3)).resolves.toMatchObject({
      bytes: (MB * 3) / 4,
      files: 2,
    });
  });

  it('loja já no limite: 403 antes de converter, com a mensagem do plano', async () => {
    plant('s3-a.webp', MB);
    const error = (await gate()
      .precheck(3)
      .catch((caught: unknown) => caught)) as ForbiddenException;
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toBe(
      'Limite de armazenamento do plano Básico atingido: 1 de 1 MB em uso. ' +
        'Fale com a administração da plataforma para mudar de plano ou liberar espaço.',
    );
  });

  it('imagem que não cabe: 403 na reserva (com o tamanho dela) e nada é somado', async () => {
    plant('s3-a.webp', MB - 1000);
    const limit = await gate().precheck(3);
    const error = (await gate()
      .reserve(3, 2048, limit)
      .catch((caught: unknown) => caught)) as ForbiddenException;
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toContain(
      'Limite de armazenamento do plano Básico atingido: 1 de 1 MB em uso; a imagem otimizada tem 2 KB.',
    );
    await expect(tracker.usage(3)).resolves.toMatchObject({
      bytes: MB - 1000,
      files: 1,
    });
  });

  it('plano ilimitado ou loja sem plano vigente: não confere (nem lê a pasta) e só mantém o uso em dia', async () => {
    limitMb = null;
    const usage = jest.spyOn(tracker, 'usage');
    await expect(gate().precheck(3)).resolves.toBeNull();
    await gate().reserve(3, 10 * MB, null);
    expect(usage).not.toHaveBeenCalled();
  });

  it('sem provedor registrado (testes de outros módulos): grava sem conferir', async () => {
    const free = new StoreStorageGate(tracker, () => null);
    plant('s3-a.webp', 5 * MB);
    await expect(free.precheck(3)).resolves.toBeNull();
    await expect(free.reserve(3, MB, null)).resolves.toBeUndefined();
  });

  it('pasta ilegível: o envio segue (a cota não derruba os envios) e fica o aviso no log', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    jest
      .spyOn(tracker, 'usage')
      .mockRejectedValue(Object.assign(new Error('x'), { code: 'EACCES' }));
    jest
      .spyOn(tracker, 'reserve')
      .mockRejectedValue(Object.assign(new Error('x'), { code: 'EACCES' }));
    await expect(gate().precheck(3)).resolves.toBeNull();
    await expect(
      gate().reserve(3, 10, { planName: 'Básico', limitMb: 1 }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).toContain('EACCES');
  });

  it('release devolve a reserva de um arquivo que não ficou na pasta', async () => {
    const limit = await gate().precheck(3);
    await gate().reserve(3, 1000, limit);
    gate().release(3, 1000);
    await expect(tracker.usage(3)).resolves.toMatchObject({
      bytes: 0,
      files: 0,
    });
  });

  it('registro do provedor: a cota usada pelas imagens consulta o plano só depois de registrada', async () => {
    const spy = jest.fn().mockResolvedValue(null);
    const registered: StoreStorageLimitProvider = { storageLimit: spy };
    await storeStorageGate.precheck(777_001);
    expect(spy).not.toHaveBeenCalled();
    registerStoreStorageLimits(registered);
    try {
      await storeStorageGate.precheck(777_001);
      expect(spy).toHaveBeenCalledWith(777_001);
    } finally {
      unregisterStoreStorageLimits({ storageLimit: jest.fn() });
      // Outro provedor não desregistra este
      await storeStorageGate.precheck(777_001);
      expect(spy).toHaveBeenCalledTimes(2);
      unregisterStoreStorageLimits(registered);
      await storeStorageGate.precheck(777_001);
      expect(spy).toHaveBeenCalledTimes(2);
    }
  });

  it('textos: tamanhos em KB/MB e números no formato brasileiro', () => {
    expect(formatStorageSize(1)).toBe('0,1 KB');
    expect(formatStorageSize(150 * 1024 + 300)).toBe('150,3 KB');
    expect(formatStorageSize(1.25 * MB)).toBe('1,25 MB');
    expect(
      storageQuotaMessage(
        { planName: 'Pro', limitMb: 500 },
        499.5 * MB,
        800 * 1024,
      ),
    ).toBe(
      'Limite de armazenamento do plano Pro atingido: 499,5 de 500 MB em uso; a imagem otimizada tem 800 KB. ' +
        'Fale com a administração da plataforma para mudar de plano ou liberar espaço.',
    );
  });
});
