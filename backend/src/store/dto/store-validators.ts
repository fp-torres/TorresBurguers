import {
  isEmail,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { emptyToNull, trimString } from '../../common/transforms';
import {
  canonicalTimeZone,
  documentError,
  normalizeDocument,
} from '../store-rules';

/**
 * Validadores e conversores dos DTOs da loja. Os campos estruturados (zonas de entrega, horários)
 * usam as funções de leitura de store-rules.ts: a mesma regra valida e normaliza, e a explicação
 * do erro vira a mensagem do 400.
 */

type Parser = (value: unknown) => unknown;

/** @Transform: troca o valor pelo normalizado quando ele é válido; inválido segue para o validador reprovar. */
export function normalizedBy(parse: Parser) {
  return ({ value }: { value: unknown }): unknown => {
    const input = emptyToNull(value);
    if (input === null || input === undefined) return input;
    try {
      return parse(input);
    } catch {
      return input;
    }
  };
}

/** Valida com uma função de leitura que lança Error explicando o problema (a explicação vai na mensagem). */
export function IsParsedBy(
  parse: Parser,
  prefix: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isParsedBy',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => {
          try {
            parse(value);
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage: ({ value }: ValidationArguments) => {
          try {
            parse(value);
            return `${prefix}.`;
          } catch (error) {
            const reason = error instanceof Error ? error.message : '';
            return reason ? `${prefix}: ${reason}` : `${prefix}.`;
          }
        },
      },
    });
  };
}

/** CPF/CNPJ sem pontuação; vazio/"null" → null (remove o documento). */
export function toDocument(value: unknown): unknown {
  const text = emptyToNull(value);
  if (typeof text === 'number') return String(text);
  return typeof text === 'string' ? normalizeDocument(text) : text;
}

/** CPF (11 dígitos) ou CNPJ (14 caracteres) com os dígitos verificadores corretos. */
export function IsStoreDocument(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isStoreDocument',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && documentError(value) === null,
        defaultMessage: ({ value }: ValidationArguments) =>
          (typeof value === 'string' && documentError(value)) ||
          'Documento inválido. Informe o CPF (11 dígitos) ou o CNPJ (14 caracteres).',
      },
    });
  };
}

/** Fuso no nome canônico ("america/sao_paulo" → "America/Sao_Paulo"); inválido segue para o validador. */
export function toTimeZone(value: unknown): unknown {
  const text = trimString(value);
  if (typeof text !== 'string') return text;
  return canonicalTimeZone(text) ?? text;
}

/** Fuso IANA reconhecido (ex.: America/Sao_Paulo). */
export function IsTimeZone(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isTimeZone',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && canonicalTimeZone(value) === value,
        defaultMessage: () =>
          'Fuso horário inválido. Use um nome como America/Sao_Paulo.',
      },
    });
  };
}

/** Somente os dígitos de um telefone; com o código do país (55) na frente, ele é removido. */
export function toPhone(value: unknown): unknown {
  const text = emptyToNull(value);
  if (typeof text === 'number') return String(text);
  if (typeof text !== 'string') return text;
  const digits = text.replace(/\D/g, '');
  if (!digits) return text; // sem número nenhum: o validador reprova
  return /^55\d{10,11}$/.test(digits) ? digits.slice(2) : digits;
}

/** CEP só com os dígitos ("20040-003" → "20040003"). */
export function toZipCode(value: unknown): unknown {
  const text = emptyToNull(value);
  if (typeof text === 'number') return String(text).padStart(8, '0');
  return typeof text === 'string' ? text.replace(/\D/g, '') : text;
}

/** Texto em maiúsculas (UF, cor). */
export function toUpper(value: unknown): unknown {
  const text = emptyToNull(value);
  return typeof text === 'string' ? text.toUpperCase() : text;
}

/** E-mail sem espaços e em minúsculas; vazio → null. */
export function toEmail(value: unknown): unknown {
  const text = emptyToNull(value);
  return typeof text === 'string' ? text.toLowerCase() : text;
}

/** E-mail de contato da loja (até `maxLength` caracteres), com uma única mensagem por problema. */
export function IsStoreEmail(
  maxLength: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isStoreEmail',
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          value.length <= maxLength &&
          isEmail(value),
        defaultMessage: ({ value }: ValidationArguments) =>
          typeof value === 'string' && value.length > maxLength
            ? `O e-mail da loja pode ter no máximo ${maxLength} caracteres.`
            : 'E-mail da loja inválido.',
      },
    });
  };
}
