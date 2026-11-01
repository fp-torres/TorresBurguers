import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { crc32 } from 'zlib';
import {
  registerStoreStorageLimits,
  unregisterStoreStorageLimits,
  type StoreStorageLimitProvider,
} from '../uploads/storage-quota';
import { BYTES_PER_MB, storeStorageUsage } from '../uploads/storage-usage';
import {
  IMAGE_TOO_MANY_PIXELS_MESSAGE,
  OptimizeImagePipe,
  withOptimizedImage,
} from './optimize-image.pipe';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** O mesmo PNG com outras dimensões no cabeçalho (IHDR), CRC recalculado: arquivo minúsculo. */
function pngWithDimensions(width: number, height: number): Buffer {
  const png = Buffer.from(PNG);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)) >>> 0, 29);
  return png;
}

const fileOf = (buffer: Buffer, originalname = 'foto.png') =>
  ({
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype: 'image/png',
    size: buffer.length,
    buffer,
  }) as Express.Multer.File;

describe('OptimizeImagePipe', () => {
  let dir: string;
  let warn: jest.SpyInstance;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'optimize-pipe-spec-'));
    process.env.UPLOADS_DIR = dir;
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterAll(() => {
    delete process.env.UPLOADS_DIR;
    rmSync(dir, { recursive: true, force: true });
    warn.mockRestore();
  });

  beforeEach(() => warn.mockClear());

  it('PNG pequeno com resolução enorme (64 MP) → 400 pelo limite de pixels, sem decodificar nem gravar', async () => {
    const huge = pngWithDimensions(8000, 8000);
    expect(huge.length).toBeLessThan(200);
    await expect(
      new OptimizeImagePipe().transform(fileOf(huge)),
    ).rejects.toThrow(new BadRequestException(IMAGE_TOO_MANY_PIXELS_MESSAGE));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('o nome enviado vai escapado para o log (CR/LF não forjam linhas)', async () => {
    const broken = Buffer.concat([PNG.subarray(0, 8), Buffer.from('lixo')]);
    const forged = 'a.png\r\n[Nest] 1 - LOG [AuthService] linha forjada';
    await expect(
      new OptimizeImagePipe().transform(fileOf(broken, forged)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = warn.mock.calls[0] as [string];
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('a.png??[Nest] 1 - LOG');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('imagem válida continua sendo gravada como .webp (com o prefixo pedido)', async () => {
    const saved = await new OptimizeImagePipe().transform(fileOf(PNG), 'u42-');
    expect(saved?.filename).toMatch(/^u42-compressed-\d+-[0-9a-f]{8}\.webp$/);
    expect(readdirSync(dir)).toEqual([saved?.filename]);
  });
});

describe('OptimizeImagePipe — cota de armazenamento da loja (antes de gravar)', () => {
  let dir: string;
  let limitMb: number | null;
  const storageLimit = jest.fn((storeId: number) => {
    void storeId;
    return Promise.resolve(
      limitMb === null ? null : { planName: 'Básico', limitMb },
    );
  });
  const provider: StoreStorageLimitProvider = { storageLimit };
  const files = () => readdirSync(dir).sort();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'optimize-pipe-quota-spec-'));
    process.env.UPLOADS_DIR = dir;
    registerStoreStorageLimits(provider);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterAll(() => {
    unregisterStoreStorageLimits(provider);
    delete process.env.UPLOADS_DIR;
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    for (const name of readdirSync(dir)) rmSync(join(dir, name));
    storeStorageUsage.invalidateAll();
    storageLimit.mockClear();
    limitMb = 1;
  });

  it('loja já no limite: 403 com a mensagem do plano e nada é gravado', async () => {
    writeFileSync(join(dir, 's5-lastro.webp'), Buffer.alloc(BYTES_PER_MB));
    const error = (await new OptimizeImagePipe()
      .transform(fileOf(PNG), 's5-')
      .catch((caught: unknown) => caught)) as ForbiddenException;
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toMatch(
      /^Limite de armazenamento do plano Básico atingido: 1 de 1 MB em uso\./,
    );
    expect(storageLimit).toHaveBeenCalledWith(5);
    expect(files()).toEqual(['s5-lastro.webp']);
  });

  it('imagem que não cabe no que sobra: 403 pelo tamanho final (WebP), sem gravar', async () => {
    writeFileSync(join(dir, 's5-lastro.webp'), Buffer.alloc(BYTES_PER_MB - 10));
    await expect(
      new OptimizeImagePipe().transform(fileOf(PNG), 's5-'),
    ).rejects.toThrow(/a imagem otimizada tem/);
    expect(files()).toEqual(['s5-lastro.webp']);
    await expect(storeStorageUsage.usage(5)).resolves.toMatchObject({
      bytes: BYTES_PER_MB - 10,
      files: 1,
    });
  });

  it('cabe: grava, devolve o tamanho gravado e o uso da loja já soma o arquivo', async () => {
    writeFileSync(join(dir, 's5-lastro.webp'), Buffer.alloc(1000));
    const saved = await new OptimizeImagePipe().transform(fileOf(PNG), 's5-');
    expect(saved?.filename).toMatch(/^s5-compressed-\d+-[0-9a-f]{8}\.webp$/);
    expect(saved?.size).toBe(statSync(saved!.path).size);
    await expect(storeStorageUsage.usage(5)).resolves.toMatchObject({
      bytes: 1000 + saved!.size,
      files: 2,
    });
  });

  it('plano ilimitado: grava sem limite; foto de perfil (u<id>-) e sem prefixo nem consultam a cota', async () => {
    limitMb = null;
    writeFileSync(join(dir, 's5-lastro.webp'), Buffer.alloc(5 * BYTES_PER_MB));
    await expect(
      new OptimizeImagePipe().transform(fileOf(PNG), 's5-'),
    ).resolves.toBeDefined();
    storageLimit.mockClear();
    limitMb = 1;
    await new OptimizeImagePipe().transform(fileOf(PNG), 'u5-');
    await new OptimizeImagePipe().transform(fileOf(PNG));
    expect(storageLimit).not.toHaveBeenCalled();
  });

  it('withOptimizedImage: cadastro recusado depois de gravar → arquivo apagado e espaço devolvido', async () => {
    writeFileSync(join(dir, 's6-lastro.webp'), Buffer.alloc(1000));
    await expect(storeStorageUsage.usage(6)).resolves.toMatchObject({
      bytes: 1000,
    });
    await expect(
      withOptimizedImage(
        fileOf(PNG),
        () => Promise.reject(new BadRequestException('Produto inválido.')),
        { prefix: 's6-' },
      ),
    ).rejects.toThrow('Produto inválido.');
    expect(files()).toEqual(['s6-lastro.webp']);
    await expect(storeStorageUsage.usage(6)).resolves.toMatchObject({
      bytes: 1000,
      files: 1,
    });
  });
});

describe('sharp/libvips: só os decodificadores de JPEG, PNG e WebP ficam ligados', () => {
  // Defesa em profundidade além da assinatura: as falhas do libvips/libheif/librsvg empacotados se
  // concentram em HEIF/AVIF, SVG, GIF e TIFF (GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w)
  const blank = () =>
    sharp({
      create: { width: 4, height: 4, channels: 3, background: '#0a0' },
    });

  it.each(['gif', 'tiff'] as const)(
    '%s: o próprio libvips recusa decodificar',
    async (format) => {
      const encoded = await blank()[format]().toBuffer();
      await expect(sharp(encoded).webp().toBuffer()).rejects.toThrow(
        /unsupported image format/i,
      );
    },
  );

  it('SVG: o próprio libvips recusa decodificar', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
    );
    await expect(sharp(svg).webp().toBuffer()).rejects.toThrow(
      /unsupported image format/i,
    );
  });

  it.each(['jpeg', 'png', 'webp'] as const)(
    '%s continua sendo decodificado',
    async (format) => {
      const encoded = await blank()[format]().toBuffer();
      const out = await sharp(encoded).webp().toBuffer();
      expect(out.length).toBeGreaterThan(0);
    },
  );
});
