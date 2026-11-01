import {
  describeMailError,
  isValidMailFrom,
  mailConfig,
  mailStatusView,
  mailWarnings,
  redactSecrets,
  smtpReady,
} from './mail-config';

const SMTP_ENV = {
  NODE_ENV: 'test',
  MAIL_DRIVER: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'Comestra <nao-responda@example.com>',
};

describe('mailConfig', () => {
  it('padrão: driver de log, SMTP não configurado (faltam SMTP_HOST e MAIL_FROM)', () => {
    const config = mailConfig({ NODE_ENV: 'test' });
    expect(config).toMatchObject({
      driver: 'log',
      unknownDriver: null,
      from: null,
      smtp: null,
    });
    expect(config.smtpIssues).toEqual([
      'SMTP_HOST não definido.',
      expect.stringContaining('MAIL_FROM não definido'),
    ]);
    expect(smtpReady(config)).toBe(false);
  });

  it('MAIL_DRIVER aceita log e smtp (sem diferenciar maiúsculas); outro valor → log com aviso', () => {
    expect(mailConfig({ MAIL_DRIVER: ' SMTP ' }).driver).toBe('smtp');
    expect(mailConfig({ MAIL_DRIVER: 'Log' }).driver).toBe('log');
    const typo = mailConfig({ NODE_ENV: 'test', MAIL_DRIVER: 'smpt' });
    expect(typo).toMatchObject({ driver: 'log', unknownDriver: 'smpt' });
    expect(mailWarnings(typo, { NODE_ENV: 'test' })).toEqual([
      expect.stringContaining('MAIL_DRIVER="smpt" não é reconhecido'),
    ]);
  });

  it('SMTP completo: porta 587 sem TLS direto por padrão; 465 liga o TLS; SMTP_SECURE manda', () => {
    const config = mailConfig(SMTP_ENV);
    expect(config.smtpIssues).toEqual([]);
    expect(smtpReady(config)).toBe(true);
    expect(config.smtp).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: null,
      password: null,
    });
    expect(config.from).toBe('Comestra <nao-responda@example.com>');

    const port = (env: Record<string, string>) => {
      const smtp = mailConfig({ ...SMTP_ENV, ...env }).smtp;
      return smtp && { port: smtp.port, secure: smtp.secure };
    };
    expect(port({ SMTP_SECURE: 'true' })).toEqual({ port: 465, secure: true });
    expect(port({ SMTP_PORT: '465' })).toEqual({ port: 465, secure: true });
    expect(port({ SMTP_PORT: '465', SMTP_SECURE: 'false' })).toEqual({
      port: 465,
      secure: false,
    });
    expect(port({ SMTP_PORT: '2525' })).toEqual({ port: 2525, secure: false });
    expect(port({ SMTP_PORT: '2525', SMTP_SECURE: 'sim' })).toEqual({
      port: 2525,
      secure: true,
    });
  });

  it('SMTP_PORT inválida, usuário sem senha (e vice-versa) e MAIL_FROM inválido viram problemas', () => {
    for (const value of ['abc', '0', '70000', '25.5', '-1']) {
      const config = mailConfig({ ...SMTP_ENV, SMTP_PORT: value });
      expect(config.smtp).toBeNull();
      expect(config.smtpIssues).toEqual([
        expect.stringContaining('SMTP_PORT inválida'),
      ]);
    }
    expect(mailConfig({ ...SMTP_ENV, SMTP_USER: 'conta' }).smtpIssues).toEqual([
      'SMTP_USER definido sem SMTP_PASSWORD.',
    ]);
    expect(
      mailConfig({ ...SMTP_ENV, SMTP_PASSWORD: 'segredo' }).smtpIssues,
    ).toEqual(['SMTP_PASSWORD definida sem SMTP_USER.']);
    const badFrom = mailConfig({ ...SMTP_ENV, MAIL_FROM: 'sem-arroba' });
    expect(badFrom.from).toBeNull();
    expect(badFrom.smtpIssues).toEqual([
      expect.stringContaining('MAIL_FROM inválido'),
    ]);
  });

  it('MAIL_FROM: endereço ou "Nome <endereço>", sem quebra de linha', () => {
    for (const valid of [
      'nao-responda@comestra.com.br',
      'Comestra <nao-responda@comestra.com.br>',
      '"Comestra Bot" <bot@mail.example.co>',
    ]) {
      expect([valid, isValidMailFrom(valid)]).toEqual([valid, true]);
    }
    for (const invalid of [
      '',
      'abc',
      'a@b',
      'Nome <a@b.com',
      'a b@c.com',
      'a@b.com\r\nBcc: x@y.com',
      `${'a'.repeat(200)}@b.com`,
    ]) {
      expect([invalid, isValidMailFrom(invalid)]).toEqual([invalid, false]);
    }
  });
});

describe('mailWarnings e mailStatusView', () => {
  it('produção com o driver de log (padrão ou explícito) → aviso; development/test → nada', () => {
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'production', MAIL_DRIVER: 'log' },
      {},
    ]) {
      expect(mailWarnings(mailConfig(env), env)).toEqual([
        expect.stringContaining('driver de log em produção'),
      ]);
    }
    for (const env of [{ NODE_ENV: 'development' }, { NODE_ENV: 'test' }]) {
      expect(mailWarnings(mailConfig(env), env)).toEqual([]);
    }
    const production = { ...SMTP_ENV, NODE_ENV: 'production' };
    expect(mailWarnings(mailConfig(production), production)).toEqual([]);
  });

  it('driver smtp incompleto → aviso com o que falta', () => {
    const env = { NODE_ENV: 'production', MAIL_DRIVER: 'smtp' };
    expect(mailWarnings(mailConfig(env), env)).toEqual([
      expect.stringMatching(
        /^MAIL_DRIVER=smtp com a configuração incompleta: SMTP_HOST não definido\. MAIL_FROM não definido.*Nenhum e-mail será enviado/,
      ),
    ]);
  });

  it('a situação do superpainel nunca traz usuário nem senha', () => {
    const env = {
      ...SMTP_ENV,
      SMTP_USER: 'conta-smtp@example.com',
      SMTP_PASSWORD: 'Senha-Muito-Secreta-123',
    };
    const view = mailStatusView(mailConfig(env), env);
    expect(view).toEqual({
      driver: 'smtp',
      smtp_configured: true,
      from: 'Comestra <nao-responda@example.com>',
      smtp: { host: 'smtp.example.com', port: 587, secure: false, auth: true },
      issues: [],
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain('conta-smtp');
    expect(json).not.toContain('Senha-Muito-Secreta-123');
    expect(json).not.toMatch(/pass|senha|hash/i);
  });
});

describe('describeMailError e redactSecrets', () => {
  const SECRETS = { user: 'conta@example.com', password: 's3cr3t-pass' };

  it('código conhecido → motivo em português com a referência; a mensagem original vai mascarada para o log', () => {
    const error = Object.assign(
      new Error(
        `Invalid login: 535 5.7.8 Authentication failed for ${SECRETS.user} (${SECRETS.password}) ${Buffer.from(SECRETS.password).toString('base64')}`,
      ),
      { code: 'EAUTH', responseCode: 535 },
    );
    const failure = describeMailError(error, SECRETS);
    expect(failure).toMatchObject({
      code: 'EAUTH',
      responseCode: 535,
      summary:
        'O servidor SMTP recusou o usuário ou a senha (confira SMTP_USER e SMTP_PASSWORD) (EAUTH 535).',
    });
    expect(failure.detail).toBe(
      'Invalid login: 535 5.7.8 Authentication failed for *** (***) ***',
    );
  });

  it('código desconhecido, sem código ou erro que não é objeto → motivo genérico', () => {
    expect(
      describeMailError(Object.assign(new Error('x'), { code: 'EWHAT' }), null)
        .summary,
    ).toBe('O envio pelo servidor SMTP falhou (EWHAT).');
    expect(describeMailError(new Error('falhou'), null)).toMatchObject({
      code: null,
      responseCode: null,
      summary: 'O envio pelo servidor SMTP falhou.',
      detail: 'falhou',
    });
    expect(describeMailError('texto', null).detail).toBe('texto');
  });

  it('mascara também o AUTH PLAIN em base64 e ignora valores curtos demais', () => {
    const plain = Buffer.from(
      `\u0000${SECRETS.user}\u0000${SECRETS.password}`,
    ).toString('base64');
    expect(
      redactSecrets(`AUTH PLAIN ${plain}`, [SECRETS.user, SECRETS.password]),
    ).toBe('AUTH PLAIN ***');
    expect(redactSecrets('a b ab', ['ab', null, undefined])).toBe('a b ab');
  });
});
