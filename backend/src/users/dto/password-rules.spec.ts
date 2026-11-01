import { BadRequestException, Type, ValidationPipe } from '@nestjs/common';
import { ResetPasswordDto } from '../../auth/dto/reset-password.dto';
import { LoginDto } from '../../auth/dto/login.dto';
import { ForgotPasswordDto } from '../../auth/dto/forgot-password.dto';
import { AcceptInvitationDto } from '../../invitations/dto/accept-invitation.dto';
import { StoreSignupDto } from '../../platform/dto/store-signup.dto';
import { CreateUserDto, meetsPasswordComposition } from './create-user.dto';
import { UpdateUserDto } from './update-user.dto';

// Mesmas opções do ValidationPipe global (config/app-setup.ts)
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/** Mensagens do 400 (ou [] quando o corpo é aceito) e o tempo gasto na validação. */
async function validate(
  metatype: Type<unknown>,
  body: unknown,
): Promise<{ messages: string[]; ms: number }> {
  const started = performance.now();
  try {
    await pipe.transform(body, { type: 'body', metatype });
    return { messages: [], ms: performance.now() - started };
  } catch (error) {
    const ms = performance.now() - started;
    if (!(error instanceof BadRequestException)) throw error;
    const { message } = error.getResponse() as { message: string[] };
    // Objetos aninhados (owner do autoatendimento) recebem o prefixo "owner."
    return {
      messages: message.map((text) => text.replace(/^owner\./, '')),
      ms,
    };
  }
}

const COMPOSITION_MESSAGE =
  'A senha deve conter pelo menos uma letra maiúscula e um número ou símbolo.';
const TOO_LONG_MESSAGE =
  'A senha pode ter no máximo 72 caracteres (letras acentuadas e emojis contam como 2 ou mais).';

// O corpo JSON padrão do Nest aceita ~100 KB: o pior caso que um anônimo consegue mandar
const HUGE = 'a'.repeat(102_300);
// Folga para máquina carregada: a regex antiga levava ~20 s com este tamanho (~1,7 s com 32 mil)
const BUDGET_MS = 500;

describe('Regra de senha: sem ReDoS (validação linear)', () => {
  it.each<[string, Type<unknown>, unknown]>([
    [
      'cadastro (POST /users)',
      CreateUserDto,
      { name: 'x', email: 'a@b.co', password: HUGE },
    ],
    ['edição (PATCH /users/:id)', UpdateUserDto, { password: HUGE }],
    [
      'redefinição (POST /auth/reset-password)',
      ResetPasswordDto,
      { token: 'x', password: HUGE },
    ],
    [
      'convite (POST /invitations/:token/accept)',
      AcceptInvitationDto,
      { name: 'x', password: HUGE },
    ],
    [
      'autoatendimento (POST /stores/signup)',
      StoreSignupDto,
      {
        store: { name: 'x', slug: 'abc' },
        owner: { name: 'x', email: 'a@b.co', password: HUGE },
        accept_terms: true,
      },
    ],
  ])(
    '%s: senha de ~100 KB é recusada sem travar a API',
    async (_label, metatype, body) => {
      const { messages, ms } = await validate(metatype, body);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(messages).toEqual(
        expect.arrayContaining([TOO_LONG_MESSAGE, COMPOSITION_MESSAGE]),
      );
    },
  );

  it.each<[string, Type<unknown>, unknown]>([
    [
      'nome, e-mail e telefone do cadastro',
      CreateUserDto,
      {
        name: HUGE,
        email: `${HUGE}@b.co`,
        phone: HUGE,
        avatar: HUGE,
        password: 'Senha#2026',
      },
    ],
    [
      'nome, e-mail, telefone e senha atual da edição',
      UpdateUserDto,
      {
        name: HUGE,
        email: `${HUGE}@b.co`,
        phone: HUGE,
        current_password: HUGE,
      },
    ],
    ['login', LoginDto, { email: `${HUGE}@b.co`, password: HUGE }],
    ['esqueci a senha', ForgotPasswordDto, { email: `a@${HUGE}.co` }],
    [
      'token da redefinição',
      ResetPasswordDto,
      { token: HUGE, password: 'Senha#2026' },
    ],
  ])(
    '%s: textos de ~100 KB são validados em tempo linear',
    async (_label, metatype, body) => {
      const { messages, ms } = await validate(metatype, body);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(messages.length).toBeGreaterThan(0);
    },
  );

  it('pior caso para a regra antiga (sem maiúscula nem símbolo, várias linhas) continua linear', () => {
    const inputs = [
      HUGE,
      'A'.repeat(102_300),
      '.'.repeat(102_300),
      'a\n'.repeat(51_150),
      `${'a'.repeat(102_299)}A`,
    ];
    const started = performance.now();
    for (const input of inputs) meetsPasswordComposition(input);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});

describe('Regra de senha: mesmo contrato de antes', () => {
  // A regra antiga, só para comparação em textos curtos (até 72 bytes, onde o custo é desprezível)
  const LEGACY = /((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z]).*$/;

  it.each([
    'SenhaForte123!',
    'NovaSenha#2026',
    'Senha@12345',
    'abcdefgh.A',
    '....Abcdefg', // os pontos do início não contam como símbolo (comportamento antigo)
    '....Abcdef1',
    'Abcdefghi',
    'abcdefgh1',
    'ABCDEFGHI',
    'ABCDEFGH1',
    'Abc\ndefgh1',
    'abc1\nDefghi',
    'Abc1\ndefghi',
    'Abc1\rdefghi',
    'Abcdefgh ',
    'Abcdefgh_',
    'Abcdefghé',
    'Abcdefgh😀',
    'Ab cdefgh',
    '\nAbcdefg1',
    'Abcdefg1\n',
    '.\n.A1',
    '',
  ])('%j: mesmo resultado da regra antiga', (password) => {
    expect(meetsPasswordComposition(password)).toBe(LEGACY.test(password));
  });

  it('textos aleatórios curtos: mesmo resultado da regra antiga', () => {
    const alphabet = 'aZ9._-\n\r !é😀  \tB0';
    const symbols = Array.from(alphabet);
    let seed = 20261031;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 20_000; i++) {
      const length = Math.floor(random() * 20);
      let text = '';
      for (let j = 0; j < length; j++) {
        text += symbols[Math.floor(random() * symbols.length)];
      }
      expect([text, meetsPasswordComposition(text)]).toEqual([
        text,
        LEGACY.test(text),
      ]);
    }
  });

  it('valores que não são texto são recusados', () => {
    expect(meetsPasswordComposition(undefined)).toBe(false);
    expect(meetsPasswordComposition(123456789)).toBe(false);
    expect(meetsPasswordComposition(['Senha#2026'])).toBe(false);
  });

  it('senha válida continua aceita no cadastro', async () => {
    const { messages } = await validate(CreateUserDto, {
      name: 'Maria',
      email: 'maria@email.com',
      password: 'SenhaForte123!',
    });
    expect(messages).toEqual([]);
  });

  it('senha sem maiúscula continua com a mesma mensagem', async () => {
    const { messages } = await validate(ResetPasswordDto, {
      token: 'x',
      password: 'senhafraca1',
    });
    expect(messages).toEqual([COMPOSITION_MESSAGE]);
  });
});
