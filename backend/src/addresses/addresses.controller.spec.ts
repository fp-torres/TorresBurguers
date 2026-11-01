import type { Request } from 'express';
import { AddressesController } from './addresses.controller';
import type { AddressesService } from './addresses.service';

describe('AddressesController', () => {
  it('busca de CEP: limite por IP com a chave dos outros limites (IPv6 pela rede /64)', async () => {
    const service = { findCep: jest.fn().mockResolvedValue({}) };
    const controller = new AddressesController(
      service as unknown as AddressesService,
    );
    for (const ip of ['2001:db8:aa:bb:1::1', '2001:db8:aa:bb:ffff::2'])
      await controller.findCep('20040002', {
        ip,
        headers: {},
      } as unknown as Request);
    const [[, first], [, second]] = service.findCep.mock.calls as [
      string,
      string,
    ][];
    expect(first).toBe(second);
    expect(first).not.toContain('::1');

    await controller.findCep('20040002', {
      ip: '::ffff:203.0.113.9',
      headers: {},
    } as unknown as Request);
    expect(service.findCep).toHaveBeenLastCalledWith('20040002', '203.0.113.9');
  });
});
