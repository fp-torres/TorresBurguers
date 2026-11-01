import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { PaymentService } from './payment.service';

/** Intervalo da conciliação dos pagamentos sem pedido. */
export const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Conciliação periódica: a cada 60 s revê os pagamentos pendentes (Mercado Pago real) e os PIX do
 * sandbox que já passaram do prazo de aprovação, criando os pedidos dos que foram aprovados — mesmo
 * que o cliente tenha fechado o app e nenhuma notificação tenha chegado.
 * Rotina do sistema: cobre todas as lojas, cada pagamento consultado com a credencial da própria loja
 * (o problema de uma loja não interrompe as outras — ver PaymentService.reconcile).
 * Várias instâncias da API podem rodar juntas: a criação do pedido é idempotente (payment_id único).
 */
@Injectable()
export class PaymentReconciler
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(PaymentReconciler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly payments: PaymentService) {}

  onApplicationBootstrap(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), RECONCILE_INTERVAL_MS);
    // Não segura o processo aberto (npm run seed, testes e desligamento)
    this.timer.unref();
  }

  // app.close() (seed, testes) e sinais de desligamento: o timer para junto com a aplicação
  onModuleDestroy(): void {
    this.stop();
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma rodada (nunca duas ao mesmo tempo). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.payments.reconcile();
    } catch (error) {
      this.logger.warn(
        `Conciliação de pagamentos falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
