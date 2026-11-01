import { createHmac } from 'crypto';
import {
  normalizeDataId,
  parseSignatureHeader,
  signatureManifest,
  SIGNATURE_TOLERANCE_MS,
  verifyMercadoPagoSignature,
} from './mercado-pago-signature';

const SECRET = 'segredo-do-webhook';
const TS = 1_791_000_000; // segundos
const NOW_MS = TS * 1000 + 30_000;

/** Assinatura como o Mercado Pago calcula (documentação oficial). */
function sign(manifest: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

function header(dataId: string, requestId: string | null, ts = TS) {
  const v1 = sign(signatureManifest(dataId, requestId, String(ts)));
  return `ts=${ts},v1=${v1}`;
}

describe('verifyMercadoPagoSignature', () => {
  it('aceita o manifesto id;request-id;ts assinado com o segredo', () => {
    expect(sign('id:123456;request-id:req-1;ts:1791000000;')).toBe(
      createHmac('sha256', SECRET)
        .update('id:123456;request-id:req-1;ts:1791000000;')
        .digest('hex'),
    );
    expect(
      verifyMercadoPagoSignature({
        signature: header('123456', 'req-1'),
        requestId: 'req-1',
        dataId: '123456',
        secret: SECRET,
        now: NOW_MS,
      }),
    ).toEqual({ valid: true, timestampMs: TS * 1000 });
  });

  it('data.id alfanumérico entra em minúsculas no manifesto', () => {
    const signature = header('2c938084726fca480172750000000000', 'req-2');
    expect(
      verifyMercadoPagoSignature({
        signature,
        requestId: 'req-2',
        dataId: '2C938084726FCA480172750000000000',
        secret: SECRET,
        now: NOW_MS,
      }).valid,
    ).toBe(true);
  });

  it('sem x-request-id, a parte sai do manifesto (regra do Mercado Pago)', () => {
    expect(signatureManifest('99', null, '1')).toBe('id:99;ts:1;');
    expect(
      verifyMercadoPagoSignature({
        signature: header('99', null),
        requestId: undefined,
        dataId: '99',
        secret: SECRET,
        now: NOW_MS,
      }).valid,
    ).toBe(true);
  });

  it('recusa segredo errado, data.id trocado e request-id trocado', () => {
    const signature = header('123', 'req-1');
    const base = {
      signature,
      requestId: 'req-1',
      dataId: '123',
      secret: SECRET,
      now: NOW_MS,
    };
    expect(verifyMercadoPagoSignature({ ...base, secret: 'outro' })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
    expect(verifyMercadoPagoSignature({ ...base, dataId: '124' })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
    expect(
      verifyMercadoPagoSignature({ ...base, requestId: 'req-2' }).valid,
    ).toBe(false);
  });

  it('recusa assinatura fora da tolerância de 5 minutos (reenvio antigo)', () => {
    const signature = header('123', 'req-1');
    const base = {
      signature,
      requestId: 'req-1',
      dataId: '123',
      secret: SECRET,
    };
    expect(
      verifyMercadoPagoSignature({
        ...base,
        now: TS * 1000 + SIGNATURE_TOLERANCE_MS + 1,
      }),
    ).toEqual({ valid: false, reason: 'expired' });
    expect(
      verifyMercadoPagoSignature({
        ...base,
        now: TS * 1000 - SIGNATURE_TOLERANCE_MS - 1,
      }).valid,
    ).toBe(false);
    // ts em milissegundos também é aceito
    const msSignature = header('123', 'req-1', TS * 1000);
    expect(
      verifyMercadoPagoSignature({
        ...base,
        signature: msSignature,
        now: NOW_MS,
      }).valid,
    ).toBe(true);
  });

  it('cabeçalho ausente ou malformado', () => {
    const base = { requestId: 'r', dataId: '1', secret: SECRET, now: NOW_MS };
    expect(
      verifyMercadoPagoSignature({ ...base, signature: undefined }),
    ).toEqual({ valid: false, reason: 'missing' });
    expect(verifyMercadoPagoSignature({ ...base, signature: 'ts=1' })).toEqual({
      valid: false,
      reason: 'missing',
    });
    expect(
      verifyMercadoPagoSignature({ ...base, signature: 'ts=abc,v1=zz' }),
    ).toEqual({ valid: false, reason: 'malformed' });
    expect(
      verifyMercadoPagoSignature({
        ...base,
        signature: header('1', 'r'),
        secret: '',
      }),
    ).toEqual({ valid: false, reason: 'missing' });
  });

  it('parse do cabeçalho e do data.id', () => {
    expect(parseSignatureHeader(' ts=1 , v1=ABC ')).toEqual({
      ts: '1',
      v1: 'ABC',
    });
    expect(parseSignatureHeader(['ts=2,v1=x'])).toEqual({ ts: '2', v1: 'x' });
    expect(normalizeDataId(123)).toBe('123');
    expect(normalizeDataId('AbC')).toBe('abc');
    expect(normalizeDataId('abc-DEF_1')).toBe('abc-DEF_1');
    for (const invalid of [
      '',
      ' ',
      '1;ts:2',
      '../x',
      'a'.repeat(81),
      null,
      {},
    ]) {
      expect(normalizeDataId(invalid)).toBeNull();
    }
  });
});
