import { Transform } from 'class-transformer';
import { normalizeEmail } from '../email';

// Transformações aplicadas pelo ValidationPipe (transform: true) ANTES da validação.
// Valem para JSON e para multipart (onde todos os campos chegam como texto).

/** Remove espaços nas pontas. */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Texto vazio (ou só espaços) vira "não informado", para o @IsOptional() ignorar o campo. */
export const EmptyToUndefined = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  });

/**
 * Texto vazio (ou só espaços) e null viram null: na edição, isso REMOVE o valor gravado.
 * "null" também conta, pois é o que o FormData envia em append(campo, null).
 */
export const EmptyToNull = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' || trimmed === 'null' ? null : trimmed;
  });

/** E-mail sem espaços e em minúsculas. */
export const NormalizeEmail = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  );
