import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  mixin,
  NestInterceptor,
  Optional,
  PayloadTooLargeException,
  Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import type { AuthUser } from '../../auth/auth-user';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { clientIpKey } from '../../auth/link-token';

/** Tamanho máximo das imagens enviadas (produtos, avatares e POST /uploads). */
export const MAX_IMAGE_SIZE_MB = 5;
export const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

export const IMAGE_TOO_LARGE_MESSAGE = `Imagem muito grande. O tamanho máximo é ${MAX_IMAGE_SIZE_MB} MB.`;
export const INVALID_IMAGE_MESSAGE =
  'Formato de imagem inválido. Envie um arquivo JPG, PNG ou WebP.';
export const MULTIPART_LIMIT_MESSAGE =
  'Formulário inválido: campos demais ou com texto longo demais.';
export const MULTIPART_FIELD_NAME_MESSAGE =
  'Formulário inválido: nome de campo não aceito.';

/**
 * Limites do multipart (busboy/multer). Sem eles o padrão é ilimitado em quantidade de campos e de
 * partes (1 MB por campo): um corpo enorme ficaria inteiro na memória ANTES de qualquer validação.
 * O maior formulário legítimo é o de produto (até 50 ingredientes + 200 adicionais, um campo cada,
 * e textos de até 1000 caracteres), então o pior caso fica em ~5 MB de texto + a imagem.
 * Nomes de campo: o site e o app mandam nomes simples (campos repetidos viram lista). O multer
 * transforma "x[n]" em array de tamanho n+1 e "a[b][c]" em objetos aninhados; sem teto, um único
 * nome como x[4294967294] seguido de x[k] trava o event loop por minutos (GHSA-535w-7cp7-47q4).
 * Por isso o índice não passa do número de campos e o aninhamento fica em dois níveis.
 */
export const MULTIPART_LIMITS = {
  fileSize: MAX_IMAGE_SIZE_BYTES,
  files: 1,
  fields: 300,
  parts: 301,
  fieldSize: 16 * 1024,
  fieldNameSize: 100,
  headerPairs: 50,
  fieldNestingDepth: 2,
  fieldArrayIndexLimit: 300,
} as const;

/** Chave do limite UPLOAD: a conta autenticada ou, sem login (cadastro com foto), o IP. */
export function uploadLimitKey(
  request: Request & { user?: AuthUser | null },
): string {
  const user = request.user;
  if (user?.id) return `user:${user.id}`;
  // IPv6 pela rede /64 (um único cliente recebe um /64 inteiro): clientIpKey
  return `ip:${clientIpKey(request)}`;
}

/**
 * FileInterceptor para imagens (5 MB, um arquivo, campos limitados).
 * - O multer interrompe o upload assim que um limite é ultrapassado (o resto do corpo é descartado,
 *   não guardado) e, no lugar do 413 padrão, a API responde 400 com mensagem em português.
 * - Limite UPLOAD (por conta, ou por IP sem login): quem já está no limite é recusado ANTES de o corpo
 *   ser lido; cada imagem recebida conta (avatar, produto, adicional, logo e POST /uploads), e também
 *   cada multipart que falha no parse (malformado, arquivo grande demais, campos demais ou nome de
 *   campo recusado), para que tentativas abusivas não escapem do limite. Um formulário válido sem
 *   imagem (ex.: editar o produto sem trocar a foto) não conta.
 * Use junto com o OptimizeImagePipe / withOptimizedImage.
 */
export function ImageFileInterceptor(
  fieldName = 'file',
): Type<NestInterceptor> {
  // fieldNestingDepth/fieldArrayIndexLimit (multer >= 2.5) ainda não constam nos tipos do Nest
  const MulterInterceptor = FileInterceptor(fieldName, {
    limits: { ...MULTIPART_LIMITS },
  });

  @Injectable()
  class ImageUploadInterceptor implements NestInterceptor {
    // Sem MulterModule.register no projeto: as opções são só as locais (limites acima)
    private readonly multer = new MulterInterceptor();

    // Opcional só para testes de controller que não registram o serviço (na API ele é global)
    constructor(@Optional() private readonly rateLimit?: RateLimitService) {}

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      const request = context
        .switchToHttp()
        .getRequest<Request & { user?: AuthUser | null }>();
      const multipart = Boolean(request.is?.('multipart/form-data'));
      const key = uploadLimitKey(request);
      // Já no limite: nem lê o corpo
      if (multipart) this.rateLimit?.assertNotLimited('UPLOAD', key);
      let parsed = false;
      try {
        return await this.multer.intercept(context, {
          handle: () => {
            parsed = true;
            // Imagem recebida: conta no limite (atômico) antes de qualquer processamento
            if ((request as { file?: unknown }).file) {
              this.rateLimit?.consume('UPLOAD', key);
            }
            return next.handle();
          },
        });
      } catch (error) {
        // Falhou no parse: a tentativa conta (o 429 da contagem acima já contou e não entra aqui)
        if (multipart && !parsed) this.countFailedUpload(key);
        throw translateUploadError(error, fieldName);
      }
    }

    /** Conta a tentativa que falhou; se a conta já está no limite, o erro original segue para o cliente. */
    private countFailedUpload(key: string): void {
      try {
        this.rateLimit?.consume('UPLOAD', key);
      } catch {
        // Já no limite: a próxima tentativa recebe 429 antes de o corpo ser lido
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
    /Unexpected (file )?field|Too many files/i.test(error.message)
  ) {
    return new BadRequestException(
      `Envie uma única imagem, no campo "${fieldName}".`,
    );
  }
  if (
    error instanceof BadRequestException &&
    /Too many (parts|fields)|Field (name|value) too long/i.test(error.message)
  ) {
    return new BadRequestException(MULTIPART_LIMIT_MESSAGE);
  }
  if (
    error instanceof BadRequestException &&
    /Field name (nesting too deep|array index too large|missing)|Invalid field name/i.test(
      error.message,
    )
  ) {
    return new BadRequestException(MULTIPART_FIELD_NAME_MESSAGE);
  }
  return error;
}
