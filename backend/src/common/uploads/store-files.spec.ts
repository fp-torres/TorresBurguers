import {
  isAllowedStoreImageRef,
  isAnyStoreFile,
  isHttpsUrl,
  isStoreFile,
  storeFilePrefix,
} from './store-files';

describe('arquivos da loja (prefixo s<id>-)', () => {
  it('prefixo e posse do arquivo', () => {
    expect(storeFilePrefix(12)).toBe('s12-');
    expect(isStoreFile('s12-compressed-1-ab.webp', 12)).toBe(true);
    // s1- não é dono de s12-, nem s12- de s1-
    expect(isStoreFile('s12-compressed-1-ab.webp', 1)).toBe(false);
    expect(isStoreFile('s1-compressed-1-ab.webp', 12)).toBe(false);
    expect(isStoreFile('compressed-1-ab.webp', 12)).toBe(false);
    expect(isStoreFile('s12-../segredo', 12)).toBe(false);
    expect(isAnyStoreFile('s3-x.webp')).toBe(true);
    expect(isAnyStoreFile('foto.webp')).toBe(false);
  });

  it('isHttpsUrl: só https com servidor', () => {
    expect(isHttpsUrl('https://cdn.exemplo.com/x.png')).toBe(true);
    expect(isHttpsUrl('http://cdn.exemplo.com/x.png')).toBe(false);
    expect(isHttpsUrl('https://')).toBe(false);
    expect(isHttpsUrl('https:// espaço')).toBe(false);
    expect(isHttpsUrl('ftp://cdn.exemplo.com/x.png')).toBe(false);
  });

  it('isAllowedStoreImageRef: arquivo da loja, https:// ou a imagem atual do registro', () => {
    expect(isAllowedStoreImageRef('s7-compressed-1.webp', 7)).toBe(true);
    expect(isAllowedStoreImageRef('https://cdn.exemplo.com/x.png', 7)).toBe(
      true,
    );
    // Arquivo de outra loja, sem dono ou http:// → recusado
    expect(isAllowedStoreImageRef('s8-compressed-1.webp', 7)).toBe(false);
    expect(isAllowedStoreImageRef('compressed-1.webp', 7)).toBe(false);
    expect(isAllowedStoreImageRef('http://cdn.exemplo.com/x.png', 7)).toBe(
      false,
    );
    // Imagem antiga (sem prefixo) que o registro já tinha continua valendo
    expect(
      isAllowedStoreImageRef('foto-antiga.jpg', 7, 'foto-antiga.jpg'),
    ).toBe(true);
    expect(
      isAllowedStoreImageRef('outra-antiga.jpg', 7, 'foto-antiga.jpg'),
    ).toBe(false);
    expect(isAllowedStoreImageRef('foto-antiga.jpg', 7, null)).toBe(false);
  });
});
