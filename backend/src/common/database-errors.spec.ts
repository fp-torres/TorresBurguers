import { QueryFailedError } from 'typeorm';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from './database-errors';

const pgError = (code: string) =>
  new QueryFailedError(
    'SQL',
    [],
    Object.assign(new Error(`erro ${code}`), { code }),
  );

describe('database-errors (códigos do PostgreSQL)', () => {
  it('identifica cada violação pelo código', () => {
    expect(isForeignKeyViolation(pgError('23503'))).toBe(true);
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
    // check_violation: também o código das triggers de consistência entre lojas
    expect(isCheckViolation(pgError('23514'))).toBe(true);

    expect(isCheckViolation(pgError('23503'))).toBe(false);
    expect(isForeignKeyViolation(pgError('23514'))).toBe(false);
  });

  it('erros que não vêm do banco nunca são confundidos com violações', () => {
    const plain = Object.assign(new Error('x'), { code: '23514' });
    expect(isCheckViolation(plain)).toBe(false);
    expect(isCheckViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});
