import { test, expect } from '@playwright/test';
import { Actors, createAddress, expectNestError, expectStatus, type Actor, type Json } from './helpers';

/** Mesmo valor de MAX_ADDRESSES_PER_USER (backend/src/addresses/addresses.service.ts). */
const MAX_ADDRESSES = 20;
const LIMIT_MESSAGE = `Limite de endereços atingido: cada conta pode ter até ${MAX_ADDRESSES} endereços. Exclua um endereço que não usa mais para cadastrar outro.`;

/**
 * Endereços são globais (da conta) e o cadastro de clientes é livre: cada conta tem um teto de endereços
 * ativos (os excluídos não contam) e a lista tem tamanho limitado.
 */
test.describe('Endereços: limite por conta', () => {
  const actors = new Actors();
  let client: Actor;

  test.beforeAll(async () => {
    client = await actors.newClient('Cliente Enderecos');
  });

  test.afterAll(async () => {
    await actors.dispose();
  });

  test(`até ${MAX_ADDRESSES} endereços ativos por conta; acima → 400 com mensagem clara; excluir libera a vaga`, async () => {
    const created: Json[] = [];
    for (let i = 0; i < MAX_ADDRESSES; i++) created.push(await createAddress(client.ctx, `Bairro ${i + 1}`));

    const blocked = await client.ctx.post('/addresses', {
      data: { zipCode: '20040-002', street: 'Rua Extra', number: '1', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ' },
    });
    await expectNestError(blocked, 400, LIMIT_MESSAGE);

    const list = await client.ctx.get('/addresses');
    await expectStatus(list, 200);
    expect(((await list.json()) as Json[]).map((a) => a.id)).toEqual(created.map((a) => a.id));

    // Excluído não conta: a conta volta a cadastrar
    await expectStatus(await client.ctx.delete(`/addresses/${created[0].id}`), 200);
    const again = await createAddress(client.ctx, 'Depois da exclusão');
    expect(again.id).toBeGreaterThan(created[created.length - 1].id);
    await expectNestError(
      await client.ctx.post('/addresses', {
        data: { zipCode: '20040-002', street: 'Rua Extra', number: '2', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ' },
      }),
      400,
      LIMIT_MESSAGE,
    );

    // Editar continua permitido no limite
    const edited = await client.ctx.patch(`/addresses/${again.id}`, { data: { number: '99' } });
    await expectStatus(edited, 200);
    expect((await edited.json()).number).toBe('99');
  });
});
