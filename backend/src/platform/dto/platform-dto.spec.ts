import {
  BadRequestException,
  ValidationPipe,
  type ArgumentMetadata,
} from '@nestjs/common';
import {
  CUSTOM_DOMAIN_FORMAT_MESSAGE,
  SLUG_FORMAT_MESSAGE,
  SLUG_RESERVED_MESSAGE,
} from '../store-identity-rules';
import { AuditQueryDto, StoreAuditQueryDto } from './platform-audit.dto';
import { FinanceQueryDto } from './platform-finance.dto';
import { UpdatePlatformSettingsDto } from './platform-settings.dto';
import {
  CreatePlatformStoreDto,
  PlatformStoreListQueryDto,
  StoreStatusReasonDto,
  UpdatePlatformStoreDto,
} from './platform-stores.dto';
import {
  AuthEventsQueryDto,
  BlockUserDto,
  PlatformUserListQueryDto,
} from './platform-users.dto';
import { StoreSignupDto } from './store-signup.dto';
import { StartSupportSessionDto } from './support-sessions.dto';

// Mesmas opções do setupApp (config/app-setup.ts)
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

type Metatype = ArgumentMetadata['metatype'];

async function parse<T>(
  metatype: new () => T,
  value: unknown,
  type: ArgumentMetadata['type'] = 'body',
): Promise<T> {
  return (await pipe.transform(value, {
    type,
    metatype: metatype as Metatype,
    data: '',
  })) as T;
}

async function errorsOf(
  metatype: new () => unknown,
  value: unknown,
  type: ArgumentMetadata['type'] = 'body',
): Promise<string[]> {
  try {
    await parse(metatype, value, type);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as {
      message: string | string[];
    };
    return Array.isArray(response.message)
      ? response.message
      : [response.message];
  }
}

const VALID_STORE = {
  name: '  Lanchonete do Bairro ',
  slug: ' Lanchonete-Do-Bairro ',
  plan_id: '2',
  document: '11.222.333/0001-81',
  phone: '(21) 99999-0000',
  owner: { email: ' Dono@Loja.COM ', name: 'Maria' },
};

describe('DTOs do superpainel', () => {
  describe('POST /platform/stores', () => {
    it('normaliza nome, slug, plano, documento, telefone e e-mail do responsável', async () => {
      const dto = await parse(CreatePlatformStoreDto, VALID_STORE);
      expect(dto).toMatchObject({
        name: 'Lanchonete do Bairro',
        slug: 'lanchonete-do-bairro',
        plan_id: 2,
        document: '11222333000181',
        phone: '21999990000',
        owner: { email: 'dono@loja.com', name: 'Maria' },
      });
    });

    it('slug reservado ou fora do formato → 400 com a explicação', async () => {
      expect(
        await errorsOf(CreatePlatformStoreDto, {
          ...VALID_STORE,
          slug: 'admin',
        }),
      ).toEqual([SLUG_RESERVED_MESSAGE]);
      expect(
        await errorsOf(CreatePlatformStoreDto, {
          ...VALID_STORE,
          slug: 'loja legal',
        }),
      ).toEqual([SLUG_FORMAT_MESSAGE]);
      expect(
        await errorsOf(CreatePlatformStoreDto, { ...VALID_STORE, slug: 'ab' }),
      ).toEqual([SLUG_FORMAT_MESSAGE]);
    });

    it('documento com dígito verificador errado, responsável ausente e plano inválido', async () => {
      const messages = await errorsOf(CreatePlatformStoreDto, {
        name: 'Loja',
        slug: 'loja-x',
        plan_id: 'abc',
        document: '11.222.333/0001-80',
      });
      expect(messages).toEqual(
        expect.arrayContaining([
          'CNPJ inválido: confira os números.',
          'Informe o plano inicial (plan_id) com um id válido.',
          'Informe o responsável pela loja (owner.email).',
        ]),
      );
    });

    it('responsável em lista (inclusive vazia) → 400', async () => {
      for (const owner of [[], [VALID_STORE.owner]]) {
        expect(
          await errorsOf(CreatePlatformStoreDto, { ...VALID_STORE, owner }),
        ).toContain(
          'owner deve ser um objeto com o responsável pela loja (owner.email).',
        );
      }
    });

    it('campos fora da lista (inclusive no responsável e a situação da loja) → 400', async () => {
      const messages = await errorsOf(CreatePlatformStoreDto, {
        ...VALID_STORE,
        account_status: 'INACTIVE',
        mp_access_token_encrypted: 'x',
        owner: { email: 'dono@loja.com', role: 'ADMIN' },
      });
      expect(messages.join(' ')).toContain(
        'property account_status should not exist',
      );
      expect(messages.join(' ')).toContain(
        'property mp_access_token_encrypted should not exist',
      );
      expect(messages.join(' ')).toContain('role should not exist');
    });

    it('e-mail do responsável inválido', async () => {
      expect(
        await errorsOf(CreatePlatformStoreDto, {
          ...VALID_STORE,
          owner: { email: 'sem-arroba' },
        }),
      ).toEqual([
        'owner.Informe um e-mail válido para o responsável (owner.email).',
      ]);
    });
  });

  describe('PATCH /platform/stores/:id', () => {
    it('domínio próprio normalizado; null remove; responsável pode ser null', async () => {
      const dto = await parse(UpdatePlatformStoreDto, {
        custom_domain: ' Pedidos.MinhaLoja.com.br ',
        owner_user_id: null,
      });
      expect(dto.custom_domain).toBe('pedidos.minhaloja.com.br');
      expect(dto.owner_user_id).toBeNull();
      expect(
        (await parse(UpdatePlatformStoreDto, { custom_domain: '' }))
          .custom_domain,
      ).toBeNull();
    });

    it('domínio com protocolo, nome vazio e slug nulo são recusados', async () => {
      const messages = await errorsOf(UpdatePlatformStoreDto, {
        custom_domain: 'https://loja.com',
        name: '',
        slug: null,
      });
      expect(messages).toEqual(
        expect.arrayContaining([
          CUSTOM_DOMAIN_FORMAT_MESSAGE,
          'Informe o nome do estabelecimento.',
          SLUG_FORMAT_MESSAGE,
        ]),
      );
    });
  });

  it('suspender/desativar exigem motivo; bloquear também', async () => {
    expect(await errorsOf(StoreStatusReasonDto, {})).toEqual([
      'Informe o motivo (ele aparece para a equipe da loja e fica na auditoria).',
    ]);
    expect(await errorsOf(BlockUserDto, { reason: '   ' })).toEqual([
      'Informe o motivo do bloqueio.',
    ]);
  });

  it('sessão de suporte: motivo de 10 a 300 caracteres', async () => {
    expect(await errorsOf(StartSupportSessionDto, { reason: 'curto' })).toEqual(
      ['Descreva o motivo com pelo menos 10 caracteres.'],
    );
    expect(
      await errorsOf(StartSupportSessionDto, { reason: 'x'.repeat(301) }),
    ).toEqual(['O motivo pode ter no máximo 300 caracteres.']);
    expect(await errorsOf(StartSupportSessionDto, {})).toEqual([
      'Informe o motivo da sessão de suporte.',
    ]);
    const dto = await parse(StartSupportSessionDto, {
      reason: '  Chamado 123: conferir entrega  ',
    });
    expect(dto.reason).toBe('Chamado 123: conferir entrega');
  });

  describe('filtros das listas (whitelist de valores)', () => {
    it('lojas: situação, assinatura, ordenação e ordem', async () => {
      const dto = await parse(
        PlatformStoreListQueryDto,
        {
          account_status: 'suspended',
          subscription_status: 'none',
          sort: 'NAME',
          order: 'DESC',
          plan_id: '3',
          page: '2',
          pageSize: '500',
        },
        'query',
      );
      expect(dto).toMatchObject({
        account_status: 'SUSPENDED',
        subscription_status: 'NONE',
        sort: 'name',
        order: 'desc',
        plan_id: 3,
        page: 2,
        pageSize: 500, // limitado a 100 na paginação (pageRequest)
      });
      expect(
        await errorsOf(
          PlatformStoreListQueryDto,
          { sort: 'mp_access_token_encrypted', order: 'sideways' },
          'query',
        ),
      ).toEqual([
        'Ordenação inválida. Use created_at, name ou slug.',
        'Ordem inválida. Use asc ou desc.',
      ]);
    });

    it('usuários: perfil, papel global, booleanos e lixeira', async () => {
      const dto = await parse(
        PlatformUserListQueryDto,
        {
          role: 'admin',
          platform_role: 'super_admin',
          blocked: 'true',
          include_deleted: 'sim',
          sort: 'last_login_at',
        },
        'query',
      );
      expect(dto).toMatchObject({
        role: 'ADMIN',
        platform_role: 'SUPER_ADMIN',
        blocked: true,
        include_deleted: true,
        sort: 'last_login_at',
      });
      expect(
        await errorsOf(
          PlatformUserListQueryDto,
          { platform_role: 'ROOT', blocked: 'talvez', store_id: '-1' },
          'query',
        ),
      ).toEqual([
        'store_id deve ser um id válido (número inteiro positivo).',
        'Papel na plataforma inválido. Use SUPER_ADMIN ou NONE.',
        'blocked deve ser true ou false.',
      ]);
    });

    it('auditoria: prefixo de ação, resultado, escopo e datas com fuso', async () => {
      const dto = await parse(
        AuditQueryDto,
        {
          action: 'Platform.Store',
          result: 'denied',
          actor_scope: 'platform',
          from: '2026-10-01',
          to: '2026-10-11T15:00:00-03:00',
          store_id: '7',
        },
        'query',
      );
      expect(dto).toMatchObject({
        action: 'platform.store',
        result: 'DENIED',
        actor_scope: 'PLATFORM',
        store_id: 7,
      });
      const messages = await errorsOf(
        AuditQueryDto,
        { action: "x' OR 1=1 --", from: '2026-10-11T15:00', result: 'OK' },
        'query',
      );
      expect(messages).toHaveLength(3);
      expect(messages.join(' ')).toContain('Ação inválida');
      expect(messages.join(' ')).toContain('from inválido');
      // A auditoria da loja não aceita store_id (a loja vem da rota)
      expect(
        await errorsOf(StoreAuditQueryDto, { store_id: '9' }, 'query'),
      ).toEqual(['property store_id should not exist']);
    });

    it('eventos de autenticação: e-mail normalizado', async () => {
      const dto = await parse(
        AuthEventsQueryDto,
        { email: ' Maria@Email.com ', user_id: '12' },
        'query',
      );
      expect(dto).toMatchObject({ email: 'maria@email.com', user_id: 12 });
      expect(
        await errorsOf(AuthEventsQueryDto, { email: 'nao-e-email' }, 'query'),
      ).toEqual(['email deve ser um e-mail válido.']);
    });

    it('financeiro: datas AAAA-MM-DD', async () => {
      expect(
        await errorsOf(FinanceQueryDto, { from: '2026-1-1' }, 'query'),
      ).toEqual(['from deve ser uma data no formato AAAA-MM-DD.']);
      expect(
        await parse(FinanceQueryDto, { from: '', to: '2026-10-31' }, 'query'),
      ).toMatchObject({ from: undefined, to: '2026-10-31' });
    });
  });

  it('configurações: faixas, booleanos e ids anuláveis', async () => {
    const dto = await parse(UpdatePlatformSettingsDto, {
      grace_period_days: '10',
      support_session_minutes: 45,
      store_self_signup_enabled: 'sim',
      self_signup_plan_id: null,
      default_store_id: '3',
    });
    expect(dto).toMatchObject({
      grace_period_days: 10,
      support_session_minutes: 45,
      store_self_signup_enabled: true,
      self_signup_plan_id: null,
      default_store_id: 3,
    });
    expect(
      await errorsOf(UpdatePlatformSettingsDto, {
        grace_period_days: 61,
        support_session_minutes: 4,
        store_self_signup_enabled: null,
        default_store_id: 'abc',
      }),
    ).toEqual([
      'default_store_id deve ser um id válido (número inteiro positivo).',
      'grace_period_days deve ser um número inteiro de 0 a 60.',
      'support_session_minutes deve ser um número inteiro de 5 a 240.',
      'store_self_signup_enabled deve ser verdadeiro ou falso.',
    ]);
  });

  describe('POST /stores/signup', () => {
    const VALID_SIGNUP = {
      store: { name: ' Pizzaria São João ', slug: 'Pizzaria-Sao-Joao' },
      owner: {
        name: ' João ',
        email: ' Joao@Pizzaria.com ',
        password: 'SenhaForte1',
        phone: '21999990000',
      },
      accept_terms: true,
    };

    it('aceita o cadastro válido (mesmas regras do cadastro de clientes)', async () => {
      const dto = await parse(StoreSignupDto, VALID_SIGNUP);
      expect(dto).toMatchObject({
        store: { name: 'Pizzaria São João', slug: 'pizzaria-sao-joao' },
        owner: { name: 'João', email: 'joao@pizzaria.com' },
        accept_terms: true,
      });
    });

    it('termos não aceitos, senha fraca, slug reservado e campos extras → 400', async () => {
      const messages = await errorsOf(StoreSignupDto, {
        store: { name: 'Loja', slug: 'signup', plan_id: 1 },
        owner: {
          name: 'A',
          email: 'a@b.com',
          password: 'fraca',
          role: 'ADMIN',
        },
        accept_terms: false,
      });
      const text = messages.join(' | ');
      expect(text).toContain(
        'É preciso aceitar os termos de uso para cadastrar o estabelecimento.',
      );
      expect(text).toContain(SLUG_RESERVED_MESSAGE);
      expect(text).toContain('A senha deve ter no mínimo 9 caracteres');
      expect(text).toContain('plan_id should not exist');
      expect(text).toContain('role should not exist');
    });

    it('sem loja ou sem responsável', async () => {
      const messages = await errorsOf(StoreSignupDto, { accept_terms: 'true' });
      expect(messages).toEqual([
        'Informe os dados do estabelecimento (store.name e store.slug).',
        'Informe os dados do responsável (owner.name, owner.email e owner.password).',
      ]);
    });

    it('loja ou responsável em lista (inclusive vazia) → 400, nunca chega ao serviço como array', async () => {
      const ownerMessage =
        'owner deve ser um objeto com os dados do responsável (owner.name, owner.email e owner.password).';
      const storeMessage =
        'store deve ser um objeto com os dados do estabelecimento (store.name e store.slug).';
      for (const owner of [[], [VALID_SIGNUP.owner]]) {
        const messages = await errorsOf(StoreSignupDto, {
          ...VALID_SIGNUP,
          owner,
        });
        expect(messages).toContain(ownerMessage);
      }
      // Item inválido: o ValidationPipe mostra os erros dos itens (o pedido continua recusado)
      expect(
        await errorsOf(StoreSignupDto, {
          ...VALID_SIGNUP,
          owner: [{ email: 'a@b.com' }],
        }),
      ).not.toEqual([]);
      for (const store of [[], [VALID_SIGNUP.store]]) {
        const messages = await errorsOf(StoreSignupDto, {
          ...VALID_SIGNUP,
          store,
        });
        expect(messages).toContain(storeMessage);
      }
      for (const value of ['texto', 12, null]) {
        expect(
          (await errorsOf(StoreSignupDto, { ...VALID_SIGNUP, owner: value }))
            .length,
        ).toBeGreaterThan(0);
      }
    });
  });
});
