import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { MailMessage, MailService } from '../notifications/mail.service';
import { Store } from '../store/entities/store.entity';
import type { User } from '../users/entities/user.entity';
import { AccountNoticesService } from './account-notices.service';

function setup() {
  const mail = {
    send: jest.fn().mockResolvedValue({ delivered: true, driver: 'smtp' }),
  };
  const manager = {
    findOne: jest.fn((entity: unknown) =>
      Promise.resolve(
        entity === Store
          ? {
              id: 5,
              name: 'Lanche <b>Bom</b>',
              logo: null,
              primary_color: '#112233',
            }
          : null,
      ),
    ),
  };
  const users = { manager } as unknown as Repository<User>;
  const service = new AccountNoticesService(
    mail as unknown as MailService,
    new RateLimitService(),
    users,
  );
  return { service, mail, manager };
}

const sent = (mail: { send: jest.Mock }, call = 0): MailMessage =>
  (mail.send.mock.calls as MailMessage[][])[call][0];

describe('AccountNoticesService', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.APP_WEB_URL = 'https://app.comestra.com.br';
    delete process.env.RATE_LIMIT_ACCOUNT_EMAIL_TARGET;
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('links das páginas do site: verificar, confirmar troca e "Não fui eu"; senha alterada aponta para /esqueci-senha', async () => {
    const { service, mail } = setup();
    const client = { name: 'Maria', store_id: null };
    await service.verification(client, 'maria@email.com', 'TOKEN_verifica');
    await service.changeConfirm(client, 'novo@email.com', 'TOKEN_troca');
    await service.emailChanged(client, {
      oldEmail: 'maria@email.com',
      newEmail: 'novo@email.com',
      revertToken: 'TOKEN_desfaz',
    });
    await service.passwordChanged(client, 'maria@email.com');
    expect(sent(mail, 0).text).toContain(
      'https://app.comestra.com.br/verificar-email/TOKEN_verifica',
    );
    expect(sent(mail, 1).to).toBe('novo@email.com');
    expect(sent(mail, 1).text).toContain(
      'https://app.comestra.com.br/confirmar-email/TOKEN_troca',
    );
    expect(sent(mail, 2).to).toBe('maria@email.com');
    expect(sent(mail, 2).text).toContain(
      'https://app.comestra.com.br/desfazer-troca-de-email/TOKEN_desfaz',
    );
    // O endereço novo vai mascarado para a caixa antiga
    expect(sent(mail, 2).text).toContain('no***@email.com');
    expect(sent(mail, 2).text).not.toContain('novo@email.com');
    expect(sent(mail, 3).text).toContain(
      'https://app.comestra.com.br/esqueci-senha',
    );
  });

  it('limite silencioso por destino (ACCOUNT_EMAIL_TARGET: 3 por hora) só nos e-mails para endereços informados', async () => {
    const { service, mail } = setup();
    const client = { name: 'Maria', store_id: null };
    for (let i = 0; i < 3; i++) {
      await expect(
        service.changeConfirm(client, 'Alvo@Email.com', `T${i}`),
      ).resolves.toBe(true);
    }
    await expect(service.changeInUse('alvo@email.com')).resolves.toBe(false);
    await expect(
      service.verification(client, 'alvo@email.com', 'T9'),
    ).resolves.toBe(false);
    expect(mail.send).toHaveBeenCalledTimes(3);
    // Avisos de segurança ao titular sempre saem
    await expect(
      service.passwordChanged(client, 'alvo@email.com'),
    ).resolves.toBe(true);
    await expect(
      service.emailChanged(client, {
        oldEmail: 'alvo@email.com',
        newEmail: 'x@y.com',
        revertToken: null,
      }),
    ).resolves.toBe(true);
    expect(mail.send).toHaveBeenCalledTimes(5);
  });

  it('equipe: marca da loja, nome escapado no HTML; aviso do ADMIN sem "Não fui eu"', async () => {
    const { service, mail } = setup();
    const member = { name: 'Zé <script>', store_id: 5 };
    await service.emailChanged(member, {
      oldEmail: 'ze@loja.com',
      newEmail: 'novo@loja.com',
      revertToken: 'IGNORADO',
      byStoreAdmin: true,
    });
    const message = sent(mail);
    expect(message.html).toContain('Lanche &lt;b&gt;Bom&lt;/b&gt;');
    expect(message.html).not.toContain('<script>');
    expect(message.text).not.toContain('desfazer-troca-de-email');
    expect(message.text).toContain('Um administrador de Lanche <b>Bom</b>');
  });

  it('falha ao montar ou enviar nunca lança (o fluxo da conta continua)', async () => {
    const { service, mail, manager } = setup();
    manager.findOne.mockRejectedValueOnce(new Error('banco fora do ar'));
    mail.send.mockRejectedValueOnce(new Error('smtp caiu'));
    await expect(
      service.passwordChanged({ name: 'A', store_id: null }, 'a@b.com'),
    ).resolves.toBe(false);
    await expect(
      service.passwordChanged({ name: 'A', store_id: 5 }, 'a@b.com'),
    ).resolves.toBe(true);
  });
});
