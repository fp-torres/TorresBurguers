import { Logger } from '@nestjs/common';
import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { createTransport, type JSONSentMessageInfo } from 'nodemailer';
import { invitationMail, passwordResetMail, testMail } from './mail-templates';
import {
  MailService,
  type MailTransport,
  type MailTransportFactory,
} from './mail.service';

const SMTP_ENV = {
  NODE_ENV: 'test',
  MAIL_DRIVER: 'smtp',
  SMTP_HOST: '127.0.0.1',
  MAIL_FROM: 'Comestra <nao-responda@example.com>',
};
const SECRETS = {
  SMTP_USER: 'conta-smtp@example.com',
  SMTP_PASSWORD: 'Senha-Muito-Secreta-123',
};

/** Ambiente dos modelos: site padrão de desenvolvimento (http://localhost:5173), sem PUBLIC_API_URL. */
const TEMPLATE_ENV = { NODE_ENV: 'test' };

const RESET = passwordResetMail(
  {
    to: 'maria@example.com',
    name: 'Maria',
    url: 'http://localhost:5173/redefinir-senha/TOKEN-SECRETO',
    minutes: 60,
  },
  TEMPLATE_ENV,
);

/** Transporte JSON do nodemailer (nada sai da máquina) que guarda as mensagens montadas. */
function jsonFactory() {
  const sent: JSONSentMessageInfo[] = [];
  const factory = jest.fn((): MailTransport => {
    const transport = createTransport({ jsonTransport: true });
    return {
      sendMail: async (mail) => {
        const info = await transport.sendMail(mail);
        sent.push(info);
        return info;
      },
    };
  });
  return { factory, sent };
}

function logSpies() {
  return {
    log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {}),
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}),
    error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {}),
  };
}

const logged = (spy: jest.SpyInstance<void, unknown[]>) =>
  spy.mock.calls.map((call) => String(call[0])).join('\n');

afterEach(() => jest.restoreAllMocks());

describe('MailService — driver de log (padrão)', () => {
  it('sem MAIL_DRIVER: nada é enviado; em test/development o texto completo vai para o log', async () => {
    const spies = logSpies();
    const { factory } = jsonFactory();
    const mail = new MailService({ NODE_ENV: 'test' }, factory);
    mail.onModuleInit();

    expect(mail.driver).toBe('log');
    expect(mail.configured).toBe(false);
    expect(await mail.send(RESET)).toEqual({ delivered: false, driver: 'log' });
    expect(factory).not.toHaveBeenCalled();
    expect(logged(spies.log)).toContain('driver de log');
    expect(logged(spies.log)).toContain('TOKEN-SECRETO');
    // Só a versão em texto vai para o log (o HTML tem o mesmo conteúdo)
    expect(logged(spies.log)).toContain('versões em texto e HTML');
    expect(logged(spies.log)).not.toContain('<!DOCTYPE');
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it('produção: aviso na subida e, a cada e-mail, só destinatário e assunto (o link nunca vai para o log)', async () => {
    const spies = logSpies();
    const mail = new MailService({ NODE_ENV: 'production' });
    mail.onModuleInit();
    expect(logged(spies.warn)).toContain('driver de log em produção');

    expect(await mail.send(RESET)).toEqual({ delivered: false, driver: 'log' });
    const all = [logged(spies.log), logged(spies.warn), logged(spies.error)];
    expect(all.join('\n')).toContain('maria@example.com');
    expect(all.join('\n')).not.toContain('TOKEN-SECRETO');
    expect(all.join('\n')).not.toContain('<!DOCTYPE');
    expect(mail.status()).toMatchObject({
      driver: 'log',
      smtp_configured: false,
      issues: [expect.stringContaining('driver de log em produção')],
    });
  });
});

describe('MailService — PUBLIC_API_URL (logo das lojas) na subida', () => {
  it('com SMTP: informa a base do logo ou que os e-mails das lojas saem sem ele', () => {
    const spies = logSpies();
    new MailService({
      ...SMTP_ENV,
      PUBLIC_API_URL: 'https://api.example.com/',
    }).onModuleInit();
    expect(logged(spies.log)).toContain(
      'Logo das lojas nos e-mails: https://api.example.com/uploads/...',
    );

    spies.log.mockClear();
    new MailService(SMTP_ENV).onModuleInit();
    expect(logged(spies.log)).toContain(
      'Sem PUBLIC_API_URL: os e-mails das lojas saem sem o logo.',
    );
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it('inválido: aviso na subida (sem o valor, que pode ter senha), mesmo com o driver de log', () => {
    const spies = logSpies();
    new MailService({
      NODE_ENV: 'test',
      PUBLIC_API_URL: 'ftp://usuario:senha-da-api@api.example.com',
    }).onModuleInit();
    expect(logged(spies.warn)).toContain('PUBLIC_API_URL inválido');
    expect(logged(spies.warn)).not.toContain('senha-da-api');
  });
});

describe('MailService — driver smtp', () => {
  it('monta a mensagem (remetente, assunto com a marca, texto, Auto-Submitted) e cria o transporte uma vez, no primeiro envio', async () => {
    const spies = logSpies();
    const { factory, sent } = jsonFactory();
    const mail = new MailService(SMTP_ENV, factory);
    mail.onModuleInit();
    expect(factory).not.toHaveBeenCalled();
    expect(mail.configured).toBe(true);
    expect(logged(spies.log)).toContain('SMTP 127.0.0.1:587');

    const first = await mail.send(RESET);
    const second = await mail.send(
      invitationMail(
        {
          to: 'novo@example.com',
          store: { name: 'Lanchonete', primary_color: '#1D4ED8' },
          role: 'EMPLOYEE',
          url: 'http://localhost:5173/convite/abc',
          days: 7,
        },
        TEMPLATE_ENV,
      ),
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', port: 587, secure: false }),
    );
    expect(first).toEqual({
      delivered: true,
      driver: 'smtp',
      messageId: sent[0].messageId,
    });
    expect(second.delivered).toBe(true);

    type SentJson = {
      from: { address: string; name: string };
      to: Array<{ address: string }>;
      subject: string;
      text: string;
      html?: string;
      headers: Record<string, string>;
    };
    const message = JSON.parse(sent[0].message) as SentJson;
    expect(message).toMatchObject({
      from: { address: 'nao-responda@example.com', name: 'Comestra' },
      to: [{ address: 'maria@example.com' }],
      subject: '[Comestra] Redefinição de senha',
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    expect(message.text).toContain('TOKEN-SECRETO');
    // Texto e HTML na mesma mensagem (multipart/alternative)
    expect(message.html).toMatch(/^<!DOCTYPE html>/);
    expect(message.html).toContain(
      'href="http://localhost:5173/redefinir-senha/TOKEN-SECRETO"',
    );
    expect(message.html).toContain(
      '<title>[Comestra] Redefinição de senha</title>',
    );
    const invitation = JSON.parse(sent[1].message) as SentJson;
    expect(invitation.subject).toBe(
      '[Comestra] Convite para a equipe de Lanchonete',
    );
    expect(invitation.text).toContain('http://localhost:5173/convite/abc');
    expect(invitation.html).toContain('background-color:#1d4ed8');
    // O conteúdo (com o link) não vai para o log quando o e-mail sai de verdade
    expect(logged(spies.log)).toContain(
      'E-mail enviado para maria@example.com',
    );
    expect(logged(spies.log)).not.toContain('TOKEN-SECRETO');
  });

  it('falha do servidor: não lança, devolve o motivo e registra no log sem usuário nem senha', async () => {
    const spies = logSpies();
    const failing: MailTransportFactory = () => ({
      sendMail: () =>
        Promise.reject(
          Object.assign(
            new Error(
              `Invalid login: 535 Authentication failed for ${SECRETS.SMTP_USER} / ${SECRETS.SMTP_PASSWORD} ${Buffer.from(SECRETS.SMTP_PASSWORD).toString('base64')}`,
            ),
            { code: 'EAUTH', responseCode: 535 },
          ),
        ),
    });
    const mail = new MailService({ ...SMTP_ENV, ...SECRETS }, failing);

    const result = await mail.send(RESET);
    expect(result).toEqual({
      delivered: false,
      driver: 'smtp',
      error:
        'O servidor SMTP recusou o usuário ou a senha (confira SMTP_USER e SMTP_PASSWORD) (EAUTH 535).',
    });
    const output = [logged(spies.log), logged(spies.warn), logged(spies.error)]
      .join('\n')
      .toLowerCase();
    expect(output).toContain('não enviado');
    expect(output).toContain(
      'detalhe: invalid login: 535 authentication failed for *** / ***',
    );
    for (const secret of [
      SECRETS.SMTP_USER,
      SECRETS.SMTP_PASSWORD,
      Buffer.from(SECRETS.SMTP_PASSWORD).toString('base64'),
    ]) {
      expect(output).not.toContain(secret.toLowerCase());
    }
    expect(JSON.stringify(mail.status())).not.toContain(SECRETS.SMTP_PASSWORD);
  });

  it('fábrica do transporte que lança também não quebra o fluxo (tenta de novo no próximo envio)', async () => {
    logSpies();
    const factory = jest
      .fn<MailTransport, Parameters<MailTransportFactory>>()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('opção inválida'), { code: 'ECONFIG' });
      })
      .mockImplementation(() => jsonFactory().factory());
    const mail = new MailService(SMTP_ENV, factory);
    expect(await mail.send(RESET)).toEqual({
      delivered: false,
      driver: 'smtp',
      error: 'A configuração do SMTP é inválida (ECONFIG).',
    });
    expect((await mail.send(RESET)).delivered).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('configuração incompleta: nada é tentado; aviso na subida e motivo no resultado', async () => {
    const spies = logSpies();
    const { factory } = jsonFactory();
    const mail = new MailService(
      { NODE_ENV: 'production', MAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.x.com' },
      factory,
    );
    mail.onModuleInit();
    expect(logged(spies.warn)).toContain(
      'MAIL_DRIVER=smtp com a configuração incompleta',
    );
    expect(mail.configured).toBe(false);
    const result = await mail.send(RESET);
    expect(result).toMatchObject({ delivered: false, driver: 'smtp' });
    expect(result.error).toMatch(
      /^Configuração do SMTP incompleta: MAIL_FROM não definido/,
    );
    expect(factory).not.toHaveBeenCalled();
  });
});

/**
 * Servidor SMTP falso (só para os testes): responde ao diálogo básico e guarda o que recebeu. O transporte
 * real do nodemailer (createSmtpTransport) fala com ele por 127.0.0.1, sem sair da máquina.
 */
async function fakeSmtpServer(): Promise<{
  server: Server;
  port: number;
  received: string[];
}> {
  const received: string[] = [];
  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 localhost ESMTP teste\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        received.push(line);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued as TESTE123\r\n');
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO') {
          socket.write(
            '250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n',
          );
        } else if (command === 'AUTH') {
          socket.write('535 5.7.8 Authentication failed\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 2.0.0 Bye\r\n');
        } else if (['MAIL', 'RCPT', 'RSET', 'NOOP'].includes(command)) {
          socket.write('250 2.1.0 Ok\r\n');
        } else {
          // Inclui STARTTLS: este servidor não oferece TLS
          socket.write('502 5.5.2 Error: command not recognized\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, received };
}

describe('MailService — transporte SMTP real (servidor falso local)', () => {
  let fake: Awaited<ReturnType<typeof fakeSmtpServer>>;

  beforeEach(async () => {
    fake = await fakeSmtpServer();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it('sem autenticação: entrega a mensagem pelo SMTP', async () => {
    logSpies();
    const mail = new MailService({ ...SMTP_ENV, SMTP_PORT: String(fake.port) });
    const result = await mail.send(
      testMail({
        to: 'ops@example.com',
        operatorName: 'Operadora',
        sentAt: new Date('2026-10-25T12:00:00Z'),
      }),
    );
    expect(result).toMatchObject({ delivered: true, driver: 'smtp' });
    expect(result.messageId).toMatch(/^<.+>$/);
    const conversation = fake.received.join('\n');
    expect(conversation).toContain('MAIL FROM:<nao-responda@example.com>');
    expect(conversation).toContain('RCPT TO:<ops@example.com>');
    expect(conversation).toMatch(/Subject: \[Comestra\] E-mail de teste/);
    expect(conversation).toContain('Auto-Submitted: auto-generated');
    // Versões em texto e HTML (o cliente de e-mail escolhe a que sabe mostrar)
    expect(conversation).toMatch(/Content-Type: multipart\/alternative/i);
    expect(conversation).toMatch(/Content-Type: text\/plain; charset=utf-8/i);
    expect(conversation).toMatch(/Content-Type: text\/html; charset=utf-8/i);
    expect(conversation).not.toMatch(/^AUTH/m);
  });

  it('com usuário e senha, sem STARTTLS no servidor: recusa antes de mandar as credenciais', async () => {
    const spies = logSpies();
    const mail = new MailService({
      ...SMTP_ENV,
      ...SECRETS,
      SMTP_PORT: String(fake.port),
    });
    const result = await mail.send(RESET);
    expect(result).toMatchObject({ delivered: false, driver: 'smtp' });
    expect(result.error).toContain('TLS');
    // Nenhum AUTH chegou ao servidor: as credenciais não trafegaram sem criptografia
    expect(fake.received.some((line) => /^AUTH/i.test(line))).toBe(false);
    const output = [logged(spies.error), logged(spies.warn)].join('\n');
    expect(output).not.toContain(SECRETS.SMTP_PASSWORD);
    expect(output).not.toContain(SECRETS.SMTP_USER);
  });

  it('servidor fora do ar: falha registrada e o fluxo segue', async () => {
    logSpies();
    // Fecha o servidor antes do envio (o close do afterEach só recebe o aviso de que já estava fechado)
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    const mail = new MailService({ ...SMTP_ENV, SMTP_PORT: String(fake.port) });
    const result = await mail.send(RESET);
    expect(result).toMatchObject({ delivered: false, driver: 'smtp' });
    expect(result.error).toMatch(
      /conectar ao servidor SMTP|conexão|não respondeu/,
    );
  });
});
