import { Logger } from '@nestjs/common';
import { Store } from '../store/entities/store.entity';
import { publicApiUrl } from './links';
import {
  MAIL_DARK_TEXT,
  PLATFORM_MAIL_COLOR,
  contrastRatio,
  defangLinks,
  loadStoreMailBrand,
  mailBrandForAccount,
  mailPalette,
  normalizeHexColor,
  platformMailBrand,
  storeLogoUrl,
  storeMailBrand,
} from './mail-brand';

const API = { PUBLIC_API_URL: 'https://api.example.com' };

afterEach(() => jest.restoreAllMocks());

describe('normalizeHexColor', () => {
  it('aceita só #RRGGBB (devolve em minúsculas); o resto nunca chega ao estilo do e-mail', () => {
    expect(normalizeHexColor('#E11D48')).toBe('#e11d48');
    expect(normalizeHexColor(' #1d4ed8 ')).toBe('#1d4ed8');
    for (const value of [
      null,
      undefined,
      '',
      '#FFF',
      'E11D48',
      '#E11D4',
      '#E11D488',
      'red',
      '#E11D48;background:url(https://evil.example/x.png)',
      '#E11D48"><script>',
      'expression(alert(1))',
      123,
    ]) {
      expect(normalizeHexColor(value)).toBeNull();
    }
  });
});

describe('mailPalette', () => {
  it('laranja da plataforma: botão com texto branco, escurecido só o necessário para 4,5:1', () => {
    const palette = mailPalette(PLATFORM_MAIL_COLOR);
    expect(palette.accent).toBe(PLATFORM_MAIL_COLOR);
    expect(palette.buttonText).toBe('#ffffff');
    expect(palette.button).not.toBe(PLATFORM_MAIL_COLOR);
    expect(contrastRatio(palette.button, '#ffffff')).toBeGreaterThanOrEqual(
      4.5,
    );
    // Ainda é laranja (escurecido em passos de 5% rumo ao preto, não trocado por outra cor)
    expect(contrastRatio(palette.button, PLATFORM_MAIL_COLOR)).toBeLessThan(
      1.5,
    );
    expect(palette.link).toBe(palette.button);
  });

  it('cor escura já legível: usada como está; cor clara (amarelo): botão na cor, com texto escuro', () => {
    expect(mailPalette('#1D4ED8')).toEqual({
      accent: '#1d4ed8',
      button: '#1d4ed8',
      buttonText: '#ffffff',
      link: '#1d4ed8',
    });
    const yellow = mailPalette('#FACC15');
    expect(yellow).toMatchObject({
      accent: '#facc15',
      button: '#facc15',
      buttonText: MAIL_DARK_TEXT,
    });
    // O link no branco não pode ser o amarelo: escurecido até 4,5:1
    expect(contrastRatio(yellow.link, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('qualquer cor: texto do botão e links sempre com contraste AA (≥ 4,5:1)', () => {
    const levels = [0, 51, 102, 153, 204, 255];
    for (const r of levels) {
      for (const g of levels) {
        for (const b of levels) {
          const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          const palette = mailPalette(color);
          expect(
            contrastRatio(palette.button, palette.buttonText),
          ).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(palette.link, '#ffffff')).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
    }
  });

  it('cor inválida → paleta da plataforma', () => {
    expect(mailPalette('javascript:alert(1)')).toEqual(
      mailPalette(PLATFORM_MAIL_COLOR),
    );
  });
});

describe('marca da plataforma × marca da loja', () => {
  it('plataforma: nome da Comestra (APP_NAME), laranja e sem logo', () => {
    expect(platformMailBrand()).toEqual({
      scope: 'platform',
      name: 'Comestra',
      color: PLATFORM_MAIL_COLOR,
      logoUrl: null,
    });
  });

  it('loja: nome, cor própria e logo pela URL pública da API', () => {
    expect(
      storeMailBrand(
        {
          name: '  Lanchonete do Bairro ',
          primary_color: '#E11D48',
          logo: 's3-compressed-logo.webp',
        },
        API,
      ),
    ).toEqual({
      scope: 'store',
      name: 'Lanchonete do Bairro',
      color: '#e11d48',
      logoUrl: 'https://api.example.com/uploads/s3-compressed-logo.webp',
    });
  });

  it('loja sem cor (ou com cor inválida gravada) → laranja da plataforma; sem PUBLIC_API_URL → sem logo', () => {
    expect(
      storeMailBrand(
        { name: 'Loja', primary_color: 'red;x', logo: 's3-a.webp' },
        { NODE_ENV: 'test' },
      ),
    ).toEqual({
      scope: 'store',
      name: 'Loja',
      color: PLATFORM_MAIL_COLOR,
      logoUrl: null,
    });
    expect(storeMailBrand({ name: 'Loja', primary_color: null }, API)).toEqual(
      expect.objectContaining({ color: PLATFORM_MAIL_COLOR, logoUrl: null }),
    );
  });
});

describe('nome da loja nos e-mails não vira link (anti-phishing)', () => {
  it('domínios, URLs e e-mails no nome são "desarmados"; nomes comuns ficam iguais', () => {
    expect(defangLinks('Lanchonete do Bairro')).toBe('Lanchonete do Bairro');
    expect(defangLinks('Sr. Burger 2.0 & Cia.')).toBe('Sr. Burger 2.0 & Cia.');
    expect(
      defangLinks('Comestra Suporte: valide em comestra-validacao.com.br hoje'),
    ).toBe('Comestra Suporte: valide em comestra-validacao[.]com[.]br hoje');
    expect(defangLinks('https://banco.example/login')).toBe(
      'https[:]//banco[.]example/login',
    );
    expect(defangLinks('www.Banco.COM')).toBe('www[.]Banco[.]COM');
    expect(defangLinks('fale com suporte@banco.com')).toBe(
      'fale com suporte@banco[.]com',
    );
  });

  it('storeMailBrand usa o nome desarmado (assunto, texto e HTML)', () => {
    expect(
      storeMailBrand({ name: 'Pague em pix-seguro.com', primary_color: null })
        .name,
    ).toBe('Pague em pix-seguro[.]com');
  });
});

describe('storeLogoUrl', () => {
  it('aceita o que o cadastro grava ("<arquivo>", "/uploads/<arquivo>", "uploads/<arquivo>")', () => {
    for (const logo of [
      's3-compressed-1.webp',
      '/uploads/s3-compressed-1.webp',
      'uploads/s3-compressed-1.webp',
    ]) {
      expect(storeLogoUrl(logo, API)).toBe(
        'https://api.example.com/uploads/s3-compressed-1.webp',
      );
    }
    expect(
      storeLogoUrl('logo.png', {
        PUBLIC_API_URL: 'https://comestra.com.br/api/',
      }),
    ).toBe('https://comestra.com.br/api/uploads/logo.png');
  });

  it('URL externa, pastas, caminhos relativos, aspas e espaços → sem logo (nada de imagens de terceiros)', () => {
    for (const logo of [
      null,
      undefined,
      '',
      'https://evil.example/logo.png',
      '//evil.example/logo.png',
      '../../etc/passwd',
      'uploads/../segredo.webp',
      'pasta/logo.webp',
      '.env',
      'logo .webp',
      'logo".webp',
      "logo'.webp",
      'logo<b>.webp',
      `${'a'.repeat(201)}.webp`,
    ]) {
      expect(storeLogoUrl(logo, API)).toBeNull();
    }
  });
});

describe('publicApiUrl', () => {
  it('http(s) absoluto, sem barra no fim (com ou sem caminho); vazio → null sem aviso', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    expect(publicApiUrl({ PUBLIC_API_URL: ' https://api.example.com/ ' })).toBe(
      'https://api.example.com',
    );
    expect(publicApiUrl({ PUBLIC_API_URL: 'http://localhost:3000///' })).toBe(
      'http://localhost:3000',
    );
    expect(
      publicApiUrl({ PUBLIC_API_URL: 'HTTPS://Comestra.com.br/api/' }),
    ).toBe('https://comestra.com.br/api');
    expect(publicApiUrl({})).toBeNull();
    expect(publicApiUrl({ PUBLIC_API_URL: '   ' })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('inválido → null, com um aviso por valor e sem mostrar o valor', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const invalid = [
      'api.example.com',
      'ftp://api.example.com',
      'javascript:alert(1)',
      'https://usuario:senha-secreta@api.example.com',
      'https://api.example.com/?x=1',
      'https://api.example.com/#topo',
      'https://exa mple.com',
    ];
    for (const value of invalid) {
      expect(publicApiUrl({ PUBLIC_API_URL: value })).toBeNull();
      expect(publicApiUrl({ PUBLIC_API_URL: value })).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(invalid.length);
    const output = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('PUBLIC_API_URL inválido');
    expect(output).not.toContain('senha-secreta');
  });
});

describe('marca lida do banco', () => {
  const store = Object.assign(new Store(), {
    id: 7,
    name: 'Pizzaria',
    logo: 's7-logo.webp',
    primary_color: '#16A34A',
  });

  it('loja encontrada → marca da loja (só nome, logo e cor são lidos)', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue(store) };
    await expect(loadStoreMailBrand(manager, 7, API)).resolves.toEqual({
      scope: 'store',
      name: 'Pizzaria',
      color: '#16a34a',
      logoUrl: 'https://api.example.com/uploads/s7-logo.webp',
    });
    expect(manager.findOne).toHaveBeenCalledWith(Store, {
      where: { id: 7 },
      select: { id: true, name: true, logo: true, primary_color: true },
    });
  });

  it('loja inexistente ou erro na consulta → marca da plataforma (o e-mail sai mesmo assim)', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await expect(
      loadStoreMailBrand({ findOne: jest.fn().mockResolvedValue(null) }, 7),
    ).resolves.toEqual(platformMailBrand());
    await expect(
      loadStoreMailBrand(
        { findOne: jest.fn().mockRejectedValue(new Error('conexão\nperdida')) },
        7,
      ),
    ).resolves.toEqual(platformMailBrand());
    expect(String(warn.mock.calls[0][0])).toContain(
      'Marca da loja #7 indisponível para o e-mail (conexão?perdida)',
    );
  });

  it('conta: equipe (store_id) → marca da loja; cliente ou superadmin (sem loja) → plataforma, sem consulta', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue(store) };
    await expect(mailBrandForAccount(manager, 7, API)).resolves.toMatchObject({
      scope: 'store',
      name: 'Pizzaria',
    });
    await expect(mailBrandForAccount(manager, null)).resolves.toEqual(
      platformMailBrand(),
    );
    await expect(mailBrandForAccount(manager, undefined)).resolves.toEqual(
      platformMailBrand(),
    );
    expect(manager.findOne).toHaveBeenCalledTimes(1);
  });
});
