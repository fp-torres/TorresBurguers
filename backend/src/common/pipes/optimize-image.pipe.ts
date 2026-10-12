import {
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

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

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
 * Valida e otimiza as imagens enviadas (produtos, avatares e POST /uploads):
 * 1. aceita somente JPG, PNG ou WebP de até 5 MB (o conteúdo é conferido) — senão 400;
 * 2. corrige a orientação (EXIF), limita a largura a 800px e converte para WebP (qualidade 80);
 * 3. grava em uploadsDir() (servida em /uploads) e devolve o arquivo com o novo filename (.webp).
 * Sem arquivo (upload opcional), devolve undefined.
 */
@Injectable()
export class OptimizeImagePipe implements PipeTransform<
  Express.Multer.File | undefined,
  Promise<Express.Multer.File | undefined>
> {
  private readonly logger = new Logger(OptimizeImagePipe.name);

  async transform(
    file?: Express.Multer.File,
  ): Promise<Express.Multer.File | undefined> {
    if (!file) return file;

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

    const dir = uploadsDir();
    await fs.mkdir(dir, { recursive: true });

    const filename = `compressed-${Date.now()}-${randomBytes(4).toString('hex')}.webp`;
    const fullPath = path.join(dir, filename);

    try {
      await sharp(buffer)
        .rotate() // respeita a orientação da câmera (EXIF)
        .resize({ width: 800, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(fullPath);
    } catch (error) {
      this.logger.warn(
        `Imagem recusada (${file.originalname}): ${(error as Error).message}`,
      );
      throw new BadRequestException(
        'Não foi possível processar a imagem. Verifique o arquivo e tente novamente.',
      );
    }

    // O controller usa o filename gerado (agora .webp)
    file.filename = filename;
    file.path = fullPath;
    file.destination = dir;
    file.mimetype = 'image/webp';
    return file;
  }
}

const optimizer = new OptimizeImagePipe();

/**
 * Otimiza a imagem (se enviada) e executa a ação com o nome do arquivo salvo.
 * Use dentro do handler, depois da validação do corpo: assim um formulário inválido não
 * deixa imagem órfã em /uploads, e se a ação falhar o arquivo recém-salvo é apagado.
 */
export async function withOptimizedImage<T>(
  file: Express.Multer.File | undefined,
  action: (filename?: string) => Promise<T>,
): Promise<T> {
  const image = await optimizer.transform(file);
  try {
    return await action(image?.filename);
  } catch (error) {
    if (image?.path) await fs.unlink(image.path).catch(() => undefined);
    throw error;
  }
}
