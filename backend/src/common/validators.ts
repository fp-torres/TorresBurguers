import {
  registerDecorator,
  ValidateIf,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Campo opcional que, quando enviado, não pode ser null (coluna NOT NULL no banco).
 * Diferente do @IsOptional(), que também deixa passar null sem validar.
 */
export const IsOptionalNotNull = () =>
  ValidateIf((_object: object, value: unknown) => value !== undefined);

export interface TextRules {
  maxLength: number;
  /** Mensagem de campo obrigatório; quando definida, texto vazio também é recusado. */
  required?: string;
  /** Tipo errado ou fora do formato (pattern). */
  invalid: string;
  tooLong: string;
  pattern?: RegExp;
}

/**
 * Texto validado com UMA mensagem por problema (ausente, tipo/formato errado ou longo demais),
 * em vez da lista que IsNotEmpty + IsString + MaxLength geram juntos.
 * Em campos opcionais, combine com @IsOptional() ou IsOptionalNotNull().
 */
export function IsText(
  rules: TextRules,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isText',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          (!rules.required || value.length > 0) &&
          value.length <= rules.maxLength &&
          (!rules.pattern || rules.pattern.test(value)),
        defaultMessage: ({ value }: ValidationArguments) => {
          if (typeof value !== 'string') {
            return value === undefined || value === null
              ? (rules.required ?? rules.invalid)
              : rules.invalid;
          }
          if (value.length === 0 && rules.required) return rules.required;
          if (value.length > rules.maxLength) return rules.tooLong;
          return rules.invalid;
        },
      },
    });
  };
}

export interface NumberRules {
  min: number;
  max: number;
  /** Exige número inteiro (ex.: ids). */
  integer?: boolean;
  invalid: string;
  tooLow?: string;
  tooHigh?: string;
}

/**
 * Número finito entre min e max, com uma única mensagem adequada ao problema.
 * Com { each: true }, a mensagem vem do primeiro item inválido da lista.
 */
export function IsNumberInRange(
  rules: NumberRules,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const isNumber = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!rules.integer || Number.isInteger(value));
  const isValid = (value: unknown) =>
    isNumber(value) && value >= rules.min && value <= rules.max;

  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isNumberInRange',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: isValid,
        // Com { each: true } o class-validator entrega aqui a lista inteira, não o item
        defaultMessage: ({ value }: ValidationArguments) => {
          const item: unknown = Array.isArray(value)
            ? value.find((entry) => !isValid(entry))
            : value;
          if (!isNumber(item)) return rules.invalid;
          if (item < rules.min) return rules.tooLow ?? rules.invalid;
          return rules.tooHigh ?? rules.invalid;
        },
      },
    });
  };
}

/** Maior valor de uma coluna integer do PostgreSQL (ids). */
export const MAX_DB_INT = 2_147_483_647;

/**
 * Texto de no máximo `max` bytes em UTF-8 (letras acentuadas ocupam 2 bytes; emojis, 4).
 * Uso típico: senhas, porque o bcrypt só considera os primeiros 72 bytes.
 * Valores que não são texto ficam para os outros validadores do campo.
 */
export function MaxUtf8Bytes(
  max: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'maxUtf8Bytes',
      target: target.constructor,
      propertyName: propertyName as string,
      constraints: [max],
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= max,
        defaultMessage: () => `O texto pode ter no máximo ${max} bytes.`,
      },
    });
  };
}
