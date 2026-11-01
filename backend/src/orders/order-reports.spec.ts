import { OrderStatus, PaymentStatus } from './order.enums';
import { buildOrdersReport, type ReportOrderRow } from './order-reports';

const ZONE = 'America/Sao_Paulo';

function row(overrides: Partial<ReportOrderRow>): ReportOrderRow {
  return {
    id: 1,
    created_at: new Date('2026-10-01T15:00:00Z'),
    status: OrderStatus.DONE,
    payment_status: PaymentStatus.PAID,
    payment_method: 'PIX',
    total_price: '10.00',
    ...overrides,
  };
}

describe('order-reports', () => {
  const period = { from: '2026-10-01', to: '2026-10-02', days: 2 };

  it('sem pedidos: todos os dias e status aparecem zerados (ticket médio 0)', () => {
    const report = buildOrdersReport([], period, ZONE);
    expect(report.summary).toEqual({
      orders: 0,
      canceledOrders: 0,
      paidOrders: 0,
      revenue: 0,
      averageTicket: 0,
    });
    expect(report.revenueByDay).toEqual([
      { date: '2026-10-01', orders: 0, paidOrders: 0, revenue: 0 },
      { date: '2026-10-02', orders: 0, paidOrders: 0, revenue: 0 },
    ]);
    expect(report.ordersByStatus.map((item) => item.status).sort()).toEqual(
      Object.values(OrderStatus).sort(),
    );
    expect(report.ordersByStatus.every((item) => item.count === 0)).toBe(true);
    expect(report.paymentMethods).toEqual([]);
    expect(report.topProducts).toEqual([]);
    expect(report.period).toEqual({ ...period, timeZone: ZONE });
  });

  it('faturamento só de pedidos PAGOS e não cancelados; cancelados contam só no status', () => {
    const report = buildOrdersReport(
      [
        row({ id: 1, total_price: '30.10' }),
        row({ id: 2, payment_status: PaymentStatus.PENDING, total_price: 99 }),
        row({
          id: 3,
          status: OrderStatus.CANCELED,
          payment_status: PaymentStatus.REFUNDED,
          total_price: '500.00',
        }),
        row({
          id: 4,
          status: OrderStatus.CANCELED,
          payment_status: PaymentStatus.PAID,
          total_price: '70.00',
        }),
        row({ id: 5, payment_method: 'MONEY', total_price: '19.90' }),
      ],
      period,
      ZONE,
    );
    expect(report.summary).toEqual({
      orders: 5,
      canceledOrders: 2,
      paidOrders: 2,
      revenue: 50,
      averageTicket: 25,
    });
    expect(report.revenueByDay[0]).toEqual({
      date: '2026-10-01',
      orders: 3,
      paidOrders: 2,
      revenue: 50,
    });
    expect(report.paymentMethods).toEqual([
      { method: 'PIX', orders: 2, paidOrders: 1, revenue: 30.1 },
      { method: 'MONEY', orders: 1, paidOrders: 1, revenue: 19.9 },
    ]);
  });

  it('o dia é o do calendário da loja; pedidos fora do período (no fuso da loja) são ignorados', () => {
    const report = buildOrdersReport(
      [
        // 23:30 de 30/09 em São Paulo: fora do período
        row({ id: 1, created_at: new Date('2026-10-01T02:30:00Z') }),
        // 00:30 de 01/10 em São Paulo
        row({ id: 2, created_at: new Date('2026-10-01T03:30:00Z') }),
        // 23:59 de 02/10 em São Paulo (03/10 em UTC)
        row({ id: 3, created_at: '2026-10-03T02:59:00Z' }),
        // 00:00 de 03/10 em São Paulo: fora
        row({ id: 4, created_at: '2026-10-03T03:00:00Z' }),
      ],
      period,
      ZONE,
    );
    expect(report.summary.orders).toBe(2);
    expect(report.revenueByDay.map((day) => day.paidOrders)).toEqual([1, 1]);
  });

  it('ticket médio arredondado em centavos e no máximo 10 produtos mais vendidos', () => {
    const report = buildOrdersReport(
      [
        row({ id: 1, total_price: '10.00' }),
        row({ id: 2, total_price: '10.00' }),
        row({ id: 3, total_price: '10.01' }),
      ],
      period,
      ZONE,
      Array.from({ length: 12 }, (_, index) => ({
        name: `Produto ${index + 1}`,
        quantity: String(20 - index) as unknown as number,
      })),
    );
    expect(report.summary.averageTicket).toBe(10);
    expect(report.topProducts).toHaveLength(10);
    expect(report.topProducts[0]).toEqual({ name: 'Produto 1', quantity: 20 });
  });

  it('formas de pagamento empatadas no faturamento: mais pedidos primeiro, depois o nome', () => {
    const report = buildOrdersReport(
      [
        row({ id: 1, payment_method: 'PIX', total_price: '10.00' }),
        row({
          id: 2,
          payment_method: 'MONEY',
          payment_status: PaymentStatus.PENDING,
        }),
        row({
          id: 3,
          payment_method: 'MONEY',
          payment_status: PaymentStatus.PENDING,
        }),
        row({
          id: 4,
          payment_method: 'DEBIT_CARD',
          payment_status: PaymentStatus.PENDING,
        }),
        row({
          id: 5,
          payment_method: 'CREDIT_CARD',
          payment_status: PaymentStatus.PENDING,
        }),
      ],
      period,
      ZONE,
    );
    expect(report.paymentMethods.map((item) => item.method)).toEqual([
      'PIX',
      'MONEY',
      'CREDIT_CARD',
      'DEBIT_CARD',
    ]);
  });
});
