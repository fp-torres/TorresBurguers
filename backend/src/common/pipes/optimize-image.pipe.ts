import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  Logger,
  PipeTransform,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { uploadsDir } from '../../config/paths';
import {
  IMAGE_TOO_LARGE_MESSAGE,
  INVALID_IMAGE_MESSAGE,
  MAX_IMAGE_SIZE_BYTES,
} from '../uploads/image-upload';
import { safeForLog } from '../uploads/safe-log';
import { storeStorageGate } from '../uploads/storage-quota';
import { storeIdFromPrefix } from '../uploads/store-files';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Decodificadores do libvips que ficam ligados no processo (sharp.block/unblock valem para todo o
 * processo). Defesa em profundidade além da assinatura conferida abaixo: as falhas mais graves do
 * libvips/libheif/librsvg empacotados no sharp ficam nos decodificadores de HEIF/AVIF, SVG, GIF, TIFF
 * e afins, que assim não são alcançáveis nem se a conferência mudar. A API só aceita JPG, PNG e WebP,
 * e a compressão das imagens antigas (manutenção) só encontra esses formatos.
 */
export const ALLOWED_IMAGE_LOADERS = [
  'VipsForeignLoadJpegBuffer',
  'VipsForeignLoadJpegFile',
  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadPngFile',
  'VipsForeignLoadWebpBuffer',
  'VipsForeignLoadWebpFile',
];

sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ALLOWED_IMAGE_LOADERS });

/**
 * Resolução máxima aceita (largura × altura). O padrão do sharp (~268 megapixels) deixaria um PNG
 * pequeno e muito comprimido, com dimensões enormes, ocupar GBs de memória ao ser decodificado.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;
export const IMAGE_TOO_MANY_PIXELS_MESSAGE =
  'Imagem com resolução muito alta (máximo de 40 megapixels). Reduza a imagem e tente de novo.';

/** Quantas imagens são processadas ao mesmo tempo (as demais esperam a vez). */
export const MAX_CONCURRENT_IMAGE_JOBS = 2;

let runningJobs = 0;
const waitingJobs: Array<() => void> = [];

/** Fila simples: no máximo MAX_CONCURRENT_IMAGE_JOBS conversões do sharp em paralelo no processo. */
async function withImageSlot<T>(job: () => Promise<T>): Promise<T> {
  if (runningJobs >= MAX_CONCURRENT_IMAGE_JOBS) {
    await new Promise<void>((resolve) => waitingJobs.push(resolve));
  } else {
    runningJobs++;
  }
  try {
    return await job();
  } finally {
    const nextJob = waitingJobs.shift();
    // A vaga passa direto para o próximo da fila (sem liberar e disputar de novo)
    if (nextJob) nextJob();
    else runningJobs--;
  }
}

/** Prefixo aceito no nome gravado: letras, números, "_" e "-" (ex.: "s12-"). Nunca pastas. */
const SAFE_PREFIX = /^[A-Za-z0-9_-]*$/;

/** Identifica JPG, PNG ou WebP pelo conteúdo (assinatura do arquivo), não pelo tipo declarado. */
function detectImageFormat(buffer: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Valida e otimiza as imagens enviadas (produtos, adicionais, avatares e POST /uploads):
 * 1. aceita somente JPG, PNG ou WebP de até 5 MB (o conteúdo é conferido) — senão 400;
 * 2. corrige a orientação (EXIF), limita a largura a 800px e converte para WebP (qualidade 80);
 * 3. arquivo de uma loja (prefixo s<storeId>-): confere a cota de armazenamento do plano ANTES de gravar
 *    (common/uploads/storage-quota.ts) — loja no limite ou imagem que não cabe → 403 e nada é gravado;
 * 4. grava em uploadsDir() (servida em /uploads) e devolve o arquivo com o novo filename (.webp) e o
 *    tamanho gravado (size).
 * Sem arquivo (upload opcional), devolve undefined. Fotos de perfil (u<id>-) e arquivos sem prefixo não
 * contam na cota de nenhuma loja.
 *
 * Como pipe de parâmetro (@UploadedFile(OptimizeImagePipe)) o arquivo é gravado sem prefixo. Para
 * arquivos de uma loja, use withOptimizedImage(file, action, { prefix: storeFilePrefix(storeId) })
 * ou transform(file, prefix).
 */
@Injectable()
export class OptimizeImagePipe implements PipeTransform<
  Express.Multer.File | undefined,
  Promise<Express.Multer.File | undefined>
> {
  private readonly logger = new Logger(OptimizeImagePipe.name);

  /**
   * prefixOrMetadata: início do nome do arquivo gravado (ex.: "s12-" para arquivos da loja 12, ver
   * common/uploads/store-files.ts). Sem prefixo — ou chamado pelo Nest como pipe, que passa aqui os
   * metadados do parâmetro —, o nome é só compressed-<data>-<código>.webp.
   */
  async transform(
    file?: Express.Multer.File,
    prefixOrMetadata?: string | ArgumentMetadata,
  ): Promise<Express.Multer.File | undefined> {
    if (!file) return file;
    const prefix = typeof prefixOrMetadata === 'string' ? prefixOrMetadata : '';
    // O prefixo vem do servidor (ex.: storeFilePrefix), nunca do cliente; ainda assim, nada de
    // pastas ou caracteres estranhos no nome gravado
    if (!SAFE_PREFIX.test(prefix)) {
      throw new Error(`Prefixo de arquivo inválido: ${prefix}`);
    }

    const { buffer } = file;
    if (!buffer?.length) {
      throw new BadRequestException('Arquivo de imagem vazio ou inválido.');
    }
    if (
      file.size > MAX_IMAGE_SIZE_BYTES ||
      buffer.length > MAX_IMAGE_SIZE_BYTES
    ) {
      throw new BadRequestException(IMAGE_TOO_LARGE_MESSAGE);
    }
    if (!detectImageFormat(buffer)) {
      throw new BadRequestException(INVALID_IMAGE_MESSAGE);
    }

    // Cota de armazenamento da loja: já no limite → 403 antes de gastar a conversão
    const storeId = storeIdFromPrefix(prefix);
    const limit =
      storeId === null ? null : await storeStorageGate.precheck(storeId);

    let output: Buffer;
    try {
      output = await withImageSlot(() =>
        sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
          .rotate() // respeita a orientação da câmera (EXIF)
          .resize({ width: 800, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer(),
      );
    } catch (error) {
      const message = (error as Error).message ?? '';
      // O nome enviado pelo cliente vai escapado (sem CR/LF): não forja linhas no log
      this.logger.warn(
        `Imagem recusada (${safeForLog(file.originalname)}): ${safeForLog(message, 200)}`,
      );
      throw new BadRequestException(
        /pixel limit/i.test(message)
          ? IMAGE_TOO_MANY_PIXELS_MESSAGE
          : 'Não foi possível processar a imagem. Verifique o arquivo e tente novamente.',
      );
    }

    // Com o tamanho final e ANTES de gravar: não cabe na cota → 403 e nada fica na pasta
    if (storeId !== null) {
      await storeStorageGate.reserve(storeId, output.length, limit);
    }

    const dir = uploadsDir();
    const filename = `${prefix}compressed-${Date.now()}-${randomBytes(4).toString('hex')}.webp`;
    const fullPath = path.join(dir, filename);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, output, { flag: 'wx' });
    } catch (error) {
      if (storeId !== null) storeStorageGate.release(storeId, output.length);
      await fs.unlink(fullPath).catch(() => undefined);
      throw error;
    }

    // O controller usa o filename gerado (agora .webp); size passa a ser o tamanho gravado
    file.filename = filename;
    file.path = fullPath;
    file.destination = dir;
    file.mimetype = 'image/webp';
    file.size = output.length;
    return file;
  }
}

const optimizer = new OptimizeImagePipe();

/**
 * Otimiza a imagem (se enviada) e executa a ação com o nome do arquivo salvo.
 * Use dentro do handler, depois da validação do corpo: assim um formulário inválido não
 * deixa imagem órfã em /uploads, e se a ação falhar o arquivo recém-salvo é apagado.
 * options.prefix: prefixo do nome gravado (arquivos de loja: storeFilePrefix(storeId)).
 */
export async function withOptimizedImage<T>(
  file: Express.Multer.File | undefined,
  action: (filename?: string) => Promise<T>,
  options: { prefix?: string } = {},
): Promise<T> {
  const prefix = options.prefix ?? '';
  const image = await optimizer.transform(file, prefix);
  try {
    return await action(image?.filename);
  } catch (error) {
    if (image?.path) {
      await fs.unlink(image.path).catch(() => undefined);
      // O arquivo apagado devolve o espaço reservado na cota da loja
      const storeId = storeIdFromPrefix(prefix);
      if (storeId !== null) storeStorageGate.release(storeId, image.size);
    }
    throw error;
  }
}
