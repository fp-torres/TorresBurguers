import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  mixin,
  NestInterceptor,
  PayloadTooLargeException,
  Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';

/** Tamanho máximo das imagens enviadas (produtos, avatares e POST /uploads). */
export const MAX_IMAGE_SIZE_MB = 5;
export const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

export const IMAGE_TOO_LARGE_MESSAGE = `Imagem muito grande. O tamanho máximo é ${MAX_IMAGE_SIZE_MB} MB.`;
export const INVALID_IMAGE_MESSAGE =
  'Formato de imagem inválido. Envie um arquivo JPG, PNG ou WebP.';

/**
 * FileInterceptor para imagens com limite de 5 MB.
 * O multer interrompe o upload assim que o limite é ultrapassado (o arquivo não fica inteiro
 * na memória) e, no lugar do 413 padrão, a API responde 400 com mensagem em português.
 * Use junto com o OptimizeImagePipe: @UploadedFile(OptimizeImagePipe).
 */
export function ImageFileInterceptor(
  fieldName = 'file',
): Type<NestInterceptor> {
  const MulterInterceptor = FileInterceptor(fieldName, {
    limits: { fileSize: MAX_IMAGE_SIZE_BYTES, files: 1 },
  });

  @Injectable()
  class ImageUploadInterceptor extends MulterInterceptor {
    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      try {
        return await super.intercept(context, next);
      } catch (error) {
        throw translateUploadError(error, fieldName);
      }
    }
  }

  return mixin(ImageUploadInterceptor);
}

function translateUploadError(error: unknown, fieldName: string): unknown {
  if (error instanceof PayloadTooLargeException) {
    return new BadRequestException(IMAGE_TOO_LARGE_MESSAGE);
  }
  if (
    error instanceof BadRequestException &&
    /Unexpected field|Too many files/i.test(error.message)
  ) {
    return new BadRequestException(
      `Envie uma única imagem, no campo "${fieldName}".`,
    );
  }
  return error;
}
