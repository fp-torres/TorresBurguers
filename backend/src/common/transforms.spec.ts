import {
  emptyToNull,
  IMAGE_REF_PATTERN,
  omitUndefined,
  parseDecimal,
  toBoolean,
  toImageRef,
  toIntArray,
  toMoney,
  toSlug,
  toStringArray,
} from './transforms';

describe('transforms (FormData → tipos do DTO)', () => {
  it('parseDecimal aceita os formatos de preço usados no Brasil', () => {
    expect(parseDecimal('29.9')).toBe(29.9);
    expect(parseDecimal('29,90')).toBe(29.9);
    expect(parseDecimal('R$ 1.234,56')).toBe(1234.56);
    expect(parseDecimal('1,234.56')).toBe(1234.56);
    expect(parseDecimal('1.234.567')).toBe(1234567);
    expect(parseDecimal('abc')).toBeNaN();
    expect(parseDecimal('')).toBeNaN();
  });

  it('toMoney arredonda em 2 casas e trata vazio/null/undefined', () => {
    expect(toMoney('25.9')).toBe(25.9);
    expect(toMoney(10.005)).toBe(10.01);
    expect(toMoney('')).toBeNull();
    expect(toMoney('null')).toBeNull();
    expect(toMoney('undefined')).toBeUndefined();
    expect(toMoney(true)).toBe(true); // tipo inválido segue para a validação reprovar
  });

  it('toBoolean converte textos do FormData', () => {
    expect(toBoolean('true')).toBe(true);
    expect(toBoolean('FALSE')).toBe(false);
    expect(toBoolean('1')).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean('')).toBeUndefined();
    expect(toBoolean('talvez')).toBe('talvez');
  });

  it('toIntArray aceita campo único, repetido, JSON e lista com vírgula', () => {
    expect(toIntArray('12')).toEqual([12]); // campo único no FormData (antes virava [1, 2])
    expect(toIntArray(['1', '2'])).toEqual([1, 2]);
    expect(toIntArray('[3,4]')).toEqual([3, 4]);
    expect(toIntArray('5, 6')).toEqual([5, 6]);
    expect(toIntArray(7)).toEqual([7]);
    expect(toIntArray('')).toEqual([]);
    expect(toIntArray(null)).toEqual([]);
    expect(toIntArray('undefined')).toBeUndefined();
    expect(toIntArray(['x'])).toEqual([NaN]);
  });

  it('toStringArray normaliza ingredientes', () => {
    expect(toStringArray('Pão, Carne ,Queijo')).toEqual([
      'Pão',
      'Carne',
      'Queijo',
    ]);
    expect(toStringArray(['Pão', ' Carne '])).toEqual(['Pão', 'Carne']);
    expect(toStringArray('["Molho, especial","Alface"]')).toEqual([
      'Molho',
      'especial',
      'Alface',
    ]);
    expect(toStringArray('')).toEqual([]);
  });

  it('toSlug, emptyToNull e toImageRef', () => {
    expect(toSlug(' Hambúrgueres ')).toBe('hamburgueres');
    expect(emptyToNull('  ')).toBeNull();
    expect(emptyToNull(' Oi ')).toBe('Oi');
    expect(toImageRef('/uploads/foto.webp')).toBe('foto.webp');
    expect(toImageRef('uploads/s12-compressed-1.webp')).toBe(
      's12-compressed-1.webp',
    );
    expect(toImageRef('')).toBeNull();
    expect(toImageRef('null')).toBeNull();
    expect(toImageRef(undefined)).toBeUndefined();
  });

  it('IMAGE_REF_PATTERN: nome de arquivo simples ou URL https:// (http:// e caminhos não)', () => {
    for (const ok of [
      'foto.webp',
      's12-compressed-1760000000000-ab12cd34.webp',
      '1770667391414-269457043.jpg',
      'https://cdn.exemplo.com/fotos/x-burger.png?w=800',
      'HTTPS://CDN.EXEMPLO.COM/X.PNG',
    ]) {
      expect(IMAGE_REF_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of [
      'http://cdn.exemplo.com/foto.png',
      '../../etc/passwd',
      'pasta/foto.webp',
      '.env',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'foto com espaço.png',
      'https://',
    ]) {
      expect(IMAGE_REF_PATTERN.test(bad)).toBe(false);
    }
  });

  it('omitUndefined remove só as chaves ausentes', () => {
    expect(omitUndefined({ a: 1, b: undefined, c: null })).toEqual({
      a: 1,
      c: null,
    });
  });
});
