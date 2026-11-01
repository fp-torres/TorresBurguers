import { Logger } from '@nestjs/common';
import * as fsModule from 'fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BYTES_PER_MB,
  STORAGE_USAGE_TTL_MS,
  StorageUsageTracker,
  bytesToMb,
} from './storage-usage';

describe('StorageUsageTracker (uso de armazenamento por loja)', () => {
  let dir: string;
  let now: number;

  const tracker = (ttlMs = STORAGE_USAGE_TTL_MS) =>
    new StorageUsageTracker({ ttlMs, dir: () => dir, clock: () => now });
  const plant = (name: string, bytes: number) =>
    writeFileSync(join(dir, name), Buffer.alloc(bytes, 1));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'storage-usage-spec-'));
    now = Date.parse('2026-10-31T12:00:00.000Z');
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('soma só os arquivos comuns da loja (s<id>-): outras lojas, fotos de perfil, sem prefixo e pastas não contam', async () => {
    plant('s12-compressed-1-aa.webp', 1000);
    plant('s12-compressed-2-bb.webp', 500);
    plant('s1-compressed-3-cc.webp', 7000); // loja 1 (s1- não é dono de s12-)
    plant('s120-compressed-4-dd.webp', 7000); // loja 120
    plant('u12-avatar.webp', 7000); // foto de perfil: nunca conta para a loja
    plant('compressed-5-ee.webp', 7000); // sem dono
    plant('S12-maiusculo.webp', 7000); // a API grava em minúsculas
    mkdirSync(join(dir, 's12-pasta'));
    writeFileSync(join(dir, 's12-pasta', 'dentro.webp'), Buffer.alloc(9000));

    const usage = await tracker().usage(12);
    expect(usage).toEqual({
      bytes: 1500,
      files: 2,
      measuredAt: new Date(now),
    });
    await expect(tracker().usage(1)).resolves.toMatchObject({
      bytes: 7000,
      files: 1,
    });
    await expect(tracker().usage(99)).resolves.toMatchObject({
      bytes: 0,
      files: 0,
    });
  });

  it('atalho (symlink) com o prefixo da loja não conta (lstat)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'storage-usage-fora-'));
    try {
      writeFileSync(join(outside, 'grande.bin'), Buffer.alloc(50_000));
      try {
        symlinkSync(join(outside, 'grande.bin'), join(dir, 's5-atalho.webp'));
      } catch {
        return; // Windows sem permissão para criar atalhos: o lstat garante o mesmo
      }
      plant('s5-real.webp', 10);
      await expect(tracker().usage(5)).resolves.toMatchObject({
        bytes: 10,
        files: 1,
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('pasta de uploads inexistente: uso zero; outro erro de disco rejeita (quem chama decide)', async () => {
    rmSync(dir, { recursive: true, force: true });
    await expect(tracker().usage(3)).resolves.toMatchObject({
      bytes: 0,
      files: 0,
    });

    jest
      .spyOn(fsModule.promises, 'readdir')
      .mockRejectedValueOnce(
        Object.assign(new Error('sem permissão'), { code: 'EACCES' }),
      );
    await expect(tracker().usage(3)).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('cache por loja: dentro do TTL não lê a pasta de novo; depois do TTL (ou invalidado) mede de novo', async () => {
    const usage = tracker(60_000);
    plant('s7-a.webp', 100);
    await expect(usage.usage(7)).resolves.toMatchObject({ bytes: 100 });

    plant('s7-b.webp', 50); // gravado por fora (outra instância)
    now += 59_000;
    await expect(usage.usage(7)).resolves.toMatchObject({ bytes: 100 });
    now += 1_000;
    await expect(usage.usage(7)).resolves.toMatchObject({
      bytes: 150,
      files: 2,
      measuredAt: new Date(now),
    });

    plant('s7-c.webp', 25);
    usage.invalidate(7);
    await expect(usage.usage(7)).resolves.toMatchObject({ bytes: 175 });
    plant('s7-d.webp', 25);
    usage.invalidateAll();
    await expect(usage.usage(7)).resolves.toMatchObject({ bytes: 200 });
  });

  it('uma leitura por vez por loja: pedidos simultâneos esperam a mesma', async () => {
    const readdir = jest.spyOn(fsModule.promises, 'readdir');
    plant('s8-a.webp', 10);
    const usage = tracker();
    const results = await Promise.all([
      usage.usage(8),
      usage.usage(8),
      usage.usage(8),
    ]);
    expect(results.map((item) => item.bytes)).toEqual([10, 10, 10]);
    expect(readdir).toHaveBeenCalledTimes(1);
  });

  it('invalidada durante a leitura: o valor lido não fica guardado', async () => {
    plant('s9-a.webp', 10);
    const usage = tracker();
    const reading = usage.usage(9);
    usage.invalidate(9); // um arquivo foi apagado enquanto a pasta era lida
    await expect(reading).resolves.toMatchObject({ bytes: 10 });
    expect(usage.cachedStores()).toBe(0);
  });

  it('reserva: confere e soma de uma vez; recusa o que não cabe; sem limite só soma; release devolve', async () => {
    plant('s4-a.webp', 900);
    const usage = tracker();

    await expect(usage.reserve(4, 100, 1000)).resolves.toEqual({ ok: true });
    await expect(usage.usage(4)).resolves.toMatchObject({
      bytes: 1000,
      files: 2,
    });
    // Igual ao limite cabe; 1 byte a mais não
    await expect(usage.reserve(4, 1, 1000)).resolves.toEqual({
      ok: false,
      usedBytes: 1000,
    });
    await expect(usage.usage(4)).resolves.toMatchObject({ bytes: 1000 });

    // Duas reservas simultâneas não passam juntas do limite
    usage.release(4, 100);
    const both = await Promise.all([
      usage.reserve(4, 80, 1000),
      usage.reserve(4, 80, 1000),
    ]);
    expect(both.filter((item) => item.ok)).toHaveLength(1);

    await expect(usage.reserve(4, 5000, null)).resolves.toEqual({ ok: true });
    await expect(usage.usage(4)).resolves.toMatchObject({ bytes: 5980 });
    usage.release(4, 10_000);
    await expect(usage.usage(4)).resolves.toMatchObject({ bytes: 0 });
  });

  it('add: soma só se o uso da loja já estiver guardado (não lê a pasta por causa disso)', async () => {
    const readdir = jest.spyOn(fsModule.promises, 'readdir');
    const usage = tracker();
    usage.add(6, 500);
    expect(readdir).not.toHaveBeenCalled();
    expect(usage.cachedStores()).toBe(0);

    plant('s6-a.webp', 10);
    await usage.usage(6);
    usage.add(6, 500);
    await expect(usage.usage(6)).resolves.toMatchObject({
      bytes: 510,
      files: 2,
    });
  });

  it('bytesToMb: MB binário com 2 casas, arredondado para cima', () => {
    expect(bytesToMb(0)).toBe(0);
    expect(bytesToMb(-5)).toBe(0);
    expect(bytesToMb(1)).toBe(0.01);
    expect(bytesToMb(BYTES_PER_MB)).toBe(1);
    expect(bytesToMb(BYTES_PER_MB * 1.5)).toBe(1.5);
    expect(bytesToMb(BYTES_PER_MB * 500 + 1)).toBe(500.01);
  });
});
