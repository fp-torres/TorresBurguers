import { Logger } from '@nestjs/common';
import { PLATFORM_MAIL_COLOR, mailPalette, storeMailBrand } from './mail-brand';
import { MISSING_LINK_TEXT } from './mail-layout';
import {
  emailChangeConfirmMail,
  emailChangedNoticeMail,
  emailChangeInUseMail,
  emailChangeRevertedMail,
  emailVerificationMail,
  invitationMail,
  passwordChangedMail,
  passwordResetMail,
  testMail,
} from './mail-templates';

/** Site e API públicos de um ambiente de produção (APP_WEB_URL e PUBLIC_API_URL). */
const ENV = {
  NODE_ENV: 'test',
  APP_WEB_URL: 'https://app.comestra.com.br',
  PUBLIC_API_URL: 'https://api.comestra.com.br',
};
const NO_PUBLIC_API = { NODE_ENV: 'test', APP_WEB_URL: ENV.APP_WEB_URL };

const RESET_URL = 'https://app.comestra.com.br/redefinir-senha/TOKEN_reset-1';
const INVITE_URL = 'https://app.comestra.com.br/convite/TOKEN_convite-1';

/** Todos os endereços do HTML (href e src): os únicos permitidos são o link do site e o logo. */
function urlsOf(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map(
    (match) => match[1],
  );
}

/** HTML sem nada executável nem recursos externos além do logo (confere cada marcação de verdade). */
function expectInertHtml(html: string): void {
  expect(html).not.toMatch(/<(script|iframe|object|embed|form|link|base)\b/i);
  expect(html).not.toMatch(/@import|url\(|expression\(/i);
  for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
    // Cada atributo (nome="valor", com as aspas do valor escapadas): nenhum on*, nenhum esquema perigoso
    const attributes = [
      ...tag.matchAll(/\s([a-z][a-z0-9:-]*)(?:="([^"]*)")?/gi),
    ];
    expect(attributes.length).toBeGreaterThanOrEqual(
      (tag.match(/="/g) ?? []).length,
    );
    for (const [, name, value = ''] of attributes) {
      expect(name).not.toMatch(/^on/i);
      expect(value).not.toMatch(/^\s*(javascript|vbscript|data):/i);
    }
  }
}

/** Estrutura de acessibilidade comum a todos os e-mails. */
function expectAccessibleHtml(html: string): void {
  expect(html).toMatch(/^<!DOCTYPE html>\n<html lang="pt-BR" dir="ltr"/);
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).toContain(
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  expect(html).toContain('<div role="article" aria-roledescription="email"');
  // Toda tabela é de layout (role="presentation"), inclusive a do Outlook
  const tables = html.match(/<table\b[^>]*>/g) ?? [];
  expect(tables.length).toBeGreaterThan(0);
  for (const table of tables) expect(table).toContain('role="presentation"');
  // Imagens sempre com alt
  for (const img of html.match(/<img\b[^>]*>/g) ?? []) {
    expect(img).toMatch(/\salt="[^"]*"/);
  }
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  // Texto de pré-visualização oculto
  expect(html).toMatch(/<div style="display:none;[^"]*mso-hide:all;">/);
}

afterEach(() => jest.restoreAllMocks());

describe('passwordResetMail', () => {
  it('conta sem loja (cliente ou plataforma): marca da Comestra, texto e HTML com o mesmo link', () => {
    const mail = passwordResetMail(
      { to: 'maria@example.com', name: 'Maria', url: RESET_URL, minutes: 60 },
      ENV,
    );
    expect(mail.to).toBe('maria@example.com');
    expect(mail.subject).toBe('Redefinição de senha');
    expect(mail.text).toBe(
      [
        'Olá, Maria!',
        '',
        'Recebemos um pedido para redefinir a senha da sua conta na Comestra. Para criar uma nova senha, use o link abaixo.',
        '',
        RESET_URL,
        '',
        'O link vale por 60 minutos e só pode ser usado uma vez.',
        '',
        'Se você não pediu a redefinição, ignore este e-mail: a sua senha atual continua valendo.',
        '',
        '-- ',
        'Mensagem automática da Comestra. Não é preciso respondê-la.',
        '',
      ].join('\n'),
    );

    const html = mail.html ?? '';
    expectAccessibleHtml(html);
    expectInertHtml(html);
    expect(html).toContain('<title>[Comestra] Redefinição de senha</title>');
    expect(html).toContain('>Redefinição de senha</h1>');
    expect(html).toContain('>Olá, Maria!</p>');
    // Botão + endereço por extenso (se o botão não funcionar)
    expect(html).toContain(`<a href="${RESET_URL}"`);
    expect(html).toContain('>Criar nova senha</a>');
    expect(html).toContain(`>${RESET_URL}</a>`);
    expect(urlsOf(html)).toEqual([RESET_URL, RESET_URL]);
    // Marca da plataforma: nome, laranja e monograma (a plataforma não tem logo em imagem)
    expect(html).toContain('>Comestra</td>');
    expect(html).toContain(`background-color:${PLATFORM_MAIL_COLOR}`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<img');
    expect(html).toContain(
      'Mensagem automática da Comestra. Não é preciso respondê-la.',
    );
  });

  it('conta da equipe: marca da loja (nome, cor e logo) no texto e no HTML', () => {
    const brand = storeMailBrand(
      {
        name: 'Pizzaria Bella',
        primary_color: '#16A34A',
        logo: 's7-logo.webp',
      },
      ENV,
    );
    const mail = passwordResetMail(
      {
        to: 'cozinha@example.com',
        name: 'Ana',
        url: RESET_URL,
        minutes: 60,
        brand,
      },
      ENV,
    );
    expect(mail.subject).toBe('Redefinição de senha');
    expect(mail.text).toContain(
      'redefinir a senha da sua conta da equipe de Pizzaria Bella na Comestra.',
    );
    expect(mail.text).toContain(
      'Mensagem automática enviada pela Comestra em nome de Pizzaria Bella.',
    );
    const html = mail.html ?? '';
    expectAccessibleHtml(html);
    expectInertHtml(html);
    expect(html).toContain('>Pizzaria Bella</td>');
    expect(html).toContain(
      '<img src="https://api.comestra.com.br/uploads/s7-logo.webp" width="48" alt=""',
    );
    expect(urlsOf(html)).toEqual([
      'https://api.comestra.com.br/uploads/s7-logo.webp',
      RESET_URL,
      RESET_URL,
    ]);
    const palette = mailPalette('#16a34a');
    expect(html).toContain(`background-color:${palette.accent}`);
    expect(html).toContain(`background-color:${palette.button}`);
    expect(html).toContain(`color:${palette.buttonText}`);
  });

  it('nome vazio → "Olá!"', () => {
    const mail = passwordResetMail(
      { to: 'x@example.com', name: '  ', url: RESET_URL, minutes: 60 },
      ENV,
    );
    expect(mail.text.startsWith('Olá!\n\n')).toBe(true);
  });
});

describe('invitationMail', () => {
  const STORE = {
    name: 'Lanchonete do Bairro',
    primary_color: '#FACC15',
    logo: '/uploads/s3-compressed-logo.webp',
  };

  it('marca da loja: nome no assunto, cor (amarelo → texto escuro no botão) e logo pela URL pública', () => {
    const mail = invitationMail(
      {
        to: 'novo@example.com',
        store: STORE,
        role: 'EMPLOYEE',
        url: INVITE_URL,
        days: 7,
      },
      ENV,
    );
    expect(mail.subject).toBe('Convite para a equipe de Lanchonete do Bairro');
    expect(mail.text).toBe(
      [
        'Olá!',
        '',
        'Você foi convidado(a) para a equipe de Lanchonete do Bairro na Comestra, com o perfil Atendente. Para aceitar e criar o seu acesso, use o link abaixo.',
        '',
        INVITE_URL,
        '',
        'O convite vale por 7 dias e só pode ser usado uma vez.',
        '',
        'Se você não esperava este convite, ignore este e-mail.',
        '',
        '-- ',
        'Mensagem automática enviada pela Comestra em nome de Lanchonete do Bairro. Não é preciso respondê-la.',
        '',
      ].join('\n'),
    );
    const html = mail.html ?? '';
    expectAccessibleHtml(html);
    expectInertHtml(html);
    expect(html).toContain(
      '<title>[Comestra] Convite para a equipe de Lanchonete do Bairro</title>',
    );
    expect(html).toContain('>Aceitar o convite</a>');
    expect(html).toContain(
      'Lanchonete do Bairro convidou você para a equipe, com o perfil Atendente.',
    );
    expect(urlsOf(html)).toEqual([
      'https://api.comestra.com.br/uploads/s3-compressed-logo.webp',
      INVITE_URL,
      INVITE_URL,
    ]);
    // Amarelo: botão na cor da loja com texto escuro; links escurecidos (legíveis no branco)
    const palette = mailPalette('#facc15');
    expect(palette.buttonText).toBe('#111827');
    expect(html).toContain(
      `bgcolor="#facc15" style="border-radius:8px;background-color:#facc15;`,
    );
    expect(html).toContain(`color:${palette.link};text-decoration:underline`);
  });

  it('sem PUBLIC_API_URL: sem logo (monograma com a inicial da loja)', () => {
    const mail = invitationMail(
      {
        to: 'novo@example.com',
        store: STORE,
        role: 'COURIER',
        url: INVITE_URL,
        days: 7,
      },
      NO_PUBLIC_API,
    );
    const html = mail.html ?? '';
    expect(html).not.toContain('<img');
    expect(html).not.toContain('api.comestra.com.br');
    expect(html).toMatch(/aria-hidden="true"[^>]*>L<\/td>/);
    expect(urlsOf(html)).toEqual([INVITE_URL, INVITE_URL]);
    expect(mail.text).toContain('com o perfil Entregador.');
  });

  it('loja sem cor e sem logo: cor da plataforma; perfil desconhecido aparece como veio', () => {
    const mail = invitationMail(
      {
        to: 'novo@example.com',
        store: { name: 'Loja Nova', primary_color: null, logo: null },
        role: 'OUTRO',
        url: INVITE_URL,
        days: 7,
      },
      ENV,
    );
    expect(mail.html).toContain(`bgcolor="${PLATFORM_MAIL_COLOR}"`);
    expect(mail.html).not.toContain('<img');
    expect(mail.text).toContain('com o perfil OUTRO.');
  });
});

describe('testMail', () => {
  it('marca da plataforma, sem links, com o operador e o horário de Brasília', () => {
    const mail = testMail(
      {
        to: 'ops@example.com',
        operatorName: 'Operadora',
        sentAt: new Date('2026-10-25T12:00:00Z'),
      },
      ENV,
    );
    expect(mail.subject).toBe('E-mail de teste');
    expect(mail.text).toContain(
      'Este é um e-mail de teste enviado pelo superpainel da Comestra por Operadora, em 25/10/2026, 09:00:00 (horário de Brasília).',
    );
    expect(mail.text).toContain('Nenhuma ação é necessária.');
    const html = mail.html ?? '';
    expectAccessibleHtml(html);
    expectInertHtml(html);
    expect(urlsOf(html)).toEqual([]);
    expect(html).not.toContain('<a ');
    expect(html).toContain('>E-mail de teste</h1>');
    expect(html).toContain('>Comestra</td>');
  });
});

describe('dados da loja e das pessoas nunca viram HTML', () => {
  const EVIL = `<script>alert("x")</script> & "Loja" 'Bar' <img src=x onerror=alert(1)>`;

  it('nome da loja, nome da pessoa e do operador: escapados no HTML (conteúdo, <title> e preview)', () => {
    const invitation = invitationMail(
      {
        to: 'novo@example.com',
        store: { name: EVIL, primary_color: '#1D4ED8' },
        role: 'ADMIN',
        url: INVITE_URL,
        days: 7,
      },
      ENV,
    );
    const reset = passwordResetMail(
      {
        to: 'x@example.com',
        name: EVIL,
        url: RESET_URL,
        minutes: 60,
        brand: storeMailBrand({ name: EVIL }, ENV),
      },
      ENV,
    );
    const test = testMail(
      { to: 'ops@example.com', operatorName: EVIL, sentAt: new Date() },
      ENV,
    );
    for (const mail of [invitation, reset, test]) {
      const html = mail.html ?? '';
      expectInertHtml(html);
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain(
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;Loja&quot; &#39;Bar&#39; &lt;img src=x onerror=alert(1)&gt;',
      );
      // Só os endereços gerados pela API
      for (const url of urlsOf(html)) {
        expect([INVITE_URL, RESET_URL]).toContain(url);
      }
      // Texto puro: o nome aparece como veio (não é HTML), mas em uma linha
      expect(mail.text).toContain(EVIL);
    }
    expect(invitation.subject).toBe(`Convite para a equipe de ${EVIL}`);
    expect(invitation.html).toContain(
      '<title>[Comestra] Convite para a equipe de &lt;script&gt;',
    );
    // Monograma: a primeira letra do nome, escapada
    expect(invitation.html).toMatch(/aria-hidden="true"[^>]*>S<\/td>/);
  });

  it('quebras de linha, controles e marcas de direção nos nomes não criam linhas nem invertem o texto', () => {
    const [nul, rlo] = [0x00, 0x202e].map((code) => String.fromCharCode(code));
    const name = `Maria\r\n\r\nAcesse http://evil.example${nul}${rlo}txt.exe`;
    const mail = passwordResetMail(
      { to: 'x@example.com', name, url: RESET_URL, minutes: 60 },
      ENV,
    );
    const firstLine = mail.text.split('\n')[0];
    expect(firstLine).toBe('Olá, Maria Acesse http://evil.example txt.exe!');
    for (const char of [nul, rlo, '\r']) {
      expect(mail.text).not.toContain(char);
      expect(mail.html).not.toContain(char);
    }
    const invitation = invitationMail(
      {
        to: 'x@example.com',
        store: { name: 'Loja\nX' },
        role: 'ADMIN',
        url: INVITE_URL,
        days: 7,
      },
      ENV,
    );
    expect(invitation.subject).toBe('Convite para a equipe de Loja X');
  });
});

describe('links: só http(s) do próprio site (APP_WEB_URL)', () => {
  const invite = (url: string, env: NodeJS.ProcessEnv = ENV) =>
    invitationMail(
      {
        to: 'novo@example.com',
        store: { name: 'Loja' },
        role: 'EMPLOYEE',
        url,
        days: 7,
      },
      env,
    );

  it('link de outro endereço é descartado (texto e HTML), com erro no log', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://evil.example/convite/abc',
      'https://app.comestra.com.br@evil.example/convite/abc',
      'https://app.comestra.com.br.evil.example/convite/abc',
      'http://app.comestra.com.br/convite/abc',
      'https://app.comestra.com.br:8443/convite/abc',
      'ftp://app.comestra.com.br/convite/abc',
      '/convite/abc',
      'nada',
    ]) {
      const mail = invite(url);
      expect(urlsOf(mail.html ?? '')).toEqual([]);
      expect(mail.html).toContain(MISSING_LINK_TEXT);
      expect(mail.html).not.toContain('evil.example');
      expect(mail.text).toContain(MISSING_LINK_TEXT);
      expect(mail.text).not.toContain('evil.example');
      expect(mail.text).not.toContain('javascript:');
      // Sem link, sem a observação de validade dele
      expect(mail.text).not.toContain('O convite vale por');
    }
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0][0])).toContain(
      'Link fora do site (APP_WEB_URL) descartado',
    );
  });

  it('APP_WEB_URL com caminho base: só links dentro dele', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const env = {
      NODE_ENV: 'test',
      APP_WEB_URL: 'https://comestra.com.br/app',
    };
    expect(
      urlsOf(invite('https://comestra.com.br/app/convite/x', env).html ?? ''),
    ).toEqual([
      'https://comestra.com.br/app/convite/x',
      'https://comestra.com.br/app/convite/x',
    ]);
    expect(
      urlsOf(invite('https://comestra.com.br/apple/convite/x', env).html ?? ''),
    ).toEqual([]);
    expect(
      urlsOf(invite('https://comestra.com.br/convite/x', env).html ?? ''),
    ).toEqual([]);
  });

  it('sem APP_WEB_URL: vale o site de desenvolvimento (o mesmo dos links gerados)', () => {
    const mail = invite('http://localhost:5173/convite/abc', {
      NODE_ENV: 'test',
    });
    expect(urlsOf(mail.html ?? '')).toEqual([
      'http://localhost:5173/convite/abc',
      'http://localhost:5173/convite/abc',
    ]);
  });
});

describe('e-mails da conta (verificação, troca de e-mail e avisos de segurança)', () => {
  const VERIFY_URL = 'https://app.comestra.com.br/verificar-email/TOKEN_v-1';
  const CHANGE_URL = 'https://app.comestra.com.br/confirmar-email/TOKEN_c-1';
  const REVERT_URL =
    'https://app.comestra.com.br/desfazer-troca-de-email/TOKEN_r-1';
  const FORGOT_URL = 'https://app.comestra.com.br/esqueci-senha';
  const AT = new Date('2026-10-31T17:30:05Z');
  const evil = 'Maria <img src=x onerror=alert(1)> & "Cia"';
  const store = storeMailBrand(
    { name: 'Loja <b>X</b>', primary_color: '#16A34A', logo: null },
    ENV,
  );

  const all = () => [
    emailVerificationMail(
      { to: 'a@b.com', name: evil, url: VERIFY_URL, hours: 48 },
      ENV,
    ),
    emailChangeConfirmMail(
      { to: 'n@b.com', name: evil, url: CHANGE_URL, hours: 24, brand: store },
      ENV,
    ),
    emailChangeInUseMail({ to: 'n@b.com' }, ENV),
    emailChangedNoticeMail(
      {
        to: 'a@b.com',
        name: evil,
        newEmailMasked: 'no***@b.com',
        changedAt: AT,
        revertUrl: REVERT_URL,
        days: 7,
      },
      ENV,
    ),
    emailChangeRevertedMail(
      { to: 'n@b.com', name: evil, restoredEmailMasked: 'a***@b.com' },
      ENV,
    ),
    passwordChangedMail(
      { to: 'a@b.com', name: evil, changedAt: AT, forgotUrl: FORGOT_URL },
      ENV,
    ),
  ];

  it('assunto em uma linha, HTML acessível e inerte, nome escapado e só links do site', () => {
    for (const mail of all()) {
      expect(mail.subject).not.toMatch(/[\r\n]/);
      const html = mail.html ?? '';
      expectAccessibleHtml(html);
      expectInertHtml(html);
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<b>X</b>');
      for (const url of urlsOf(html)) {
        expect(url.startsWith('https://app.comestra.com.br/')).toBe(true);
      }
    }
    const [verify, change, inUse, notice, reverted, password] = all();
    expect(verify.html).toContain(
      'Olá, Maria &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Cia&quot;!',
    );
    expect(urlsOf(verify.html ?? '')).toEqual([VERIFY_URL, VERIFY_URL]);
    expect(verify.text).toContain('O link vale por 48 horas');
    expect(urlsOf(change.html ?? '')).toEqual([CHANGE_URL, CHANGE_URL]);
    expect(change.text).toContain(
      'da sua conta da equipe de Loja <b>X</b> na Comestra',
    );
    expect(change.html).toContain('Loja &lt;b&gt;X&lt;/b&gt;');
    // Aviso de e-mail em uso: sem link nenhum
    expect(urlsOf(inUse.html ?? '')).toEqual([]);
    expect(inUse.text).not.toMatch(/https?:\/\//);
    expect(urlsOf(notice.html ?? '')).toEqual([REVERT_URL, REVERT_URL]);
    expect(notice.text).toContain(
      'para no***@b.com, em 31/10/2026, 14:30:05 (horário de Brasília)',
    );
    expect(notice.html).toContain('>Não fui eu: desfazer a troca</a>');
    expect(urlsOf(reverted.html ?? '')).toEqual([]);
    expect(urlsOf(password.html ?? '')).toEqual([FORGOT_URL, FORGOT_URL]);
  });

  it('troca feita pelo ADMIN da loja: aviso informativo, sem o "Não fui eu" mesmo se um link vier', () => {
    const mail = emailChangedNoticeMail(
      {
        to: 'ze@loja.com',
        newEmailMasked: 'no***@loja.com',
        changedAt: AT,
        revertUrl: REVERT_URL,
        days: 7,
        byStoreAdmin: true,
        brand: store,
      },
      ENV,
    );
    expect(mail.text).toContain(
      'Um administrador de Loja <b>X</b> alterou o e-mail de acesso',
    );
    expect(urlsOf(mail.html ?? '')).toEqual([]);
    expect(mail.text).not.toContain('desfazer-troca-de-email');
  });

  it('link fora do site (APP_WEB_URL) é descartado no "Não fui eu"', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const mail = emailChangedNoticeMail(
      {
        to: 'a@b.com',
        newEmailMasked: 'no***@b.com',
        changedAt: AT,
        revertUrl: 'https://evil.example/desfazer-troca-de-email/x',
        days: 7,
      },
      ENV,
    );
    expect(mail.text).toContain(MISSING_LINK_TEXT);
    expect(mail.html).not.toContain('evil.example');
    expect(error).toHaveBeenCalled();
  });
});
