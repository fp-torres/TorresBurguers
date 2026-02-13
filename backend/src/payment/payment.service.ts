import { Injectable } from '@nestjs/common';
import { MercadoPagoConfig, Payment } from 'mercadopago';

@Injectable()
export class PaymentService {
  private client: MercadoPagoConfig;
  private payment: Payment;

  constructor() {
    this.client = new MercadoPagoConfig({ 
      accessToken: 'TEST-5184213553580994-021313-b2bab03476b9aed5a5162c1dbfbfe0a6-1066557772', 
      options: { timeout: 5000 } 
    });
    
    this.payment = new Payment(this.client);
  }

  // --- PAGAMENTO VIA CARTÃO DE CRÉDITO ---
  async processCardPayment(data: any) {
    try {
      const uniqueEmail = `comprador_${Date.now()}@gmail.com`;

      console.log('Processando Pagamento:', {
        amount: data.amount,
        method: data.paymentMethodId, // Verifica o que chegou do front
        token: data.token
      });

      const paymentData = {
        body: {
          transaction_amount: Number(data.amount),
          token: data.token,
          description: 'Pedido TorresBurgers',
          installments: Number(data.installments || 1),
          // IMPORTANTE: Usa o ID que veio do frontend (ex: 'master', 'visa')
          // Se não vier nada, NÃO tenta 'credit_card', pois gera erro bin_not_found para master
          payment_method_id: data.paymentMethodId, 
          payer: {
            email: uniqueEmail,
            identification: {
              type: 'CPF',
              number: data.docNumber
            }
          }
        }
      };

      const result = await this.payment.create(paymentData);
      
      return {
        id: result.id,
        status: result.status,
        status_detail: result.status_detail,
      };

    } catch (error: any) {
      console.error('Erro detalhado no Cartão:', JSON.stringify(error, null, 2));
      throw new Error(error.message || 'Erro no processamento do cartão');
    }
  }

  // --- PAGAMENTO VIA PIX ---
  async processPixPayment(data: any) {
    try {
      const uniqueEmail = `pix_user_${Date.now()}@gmail.com`;

      const paymentData = {
        body: {
          transaction_amount: Number(data.amount),
          description: 'Pedido TorresBurgers - PIX',
          payment_method_id: 'pix',
          payer: {
            email: uniqueEmail, 
            identification: {
              type: 'CPF',
              number: '19119119100'
            }
          }
        }
      };

      const result = await this.payment.create(paymentData);

      return {
        id: result.id,
        status: result.status,
        qr_code: result.point_of_interaction?.transaction_data?.qr_code, 
        qr_code_base64: result.point_of_interaction?.transaction_data?.qr_code_base64,
        ticket_url: result.point_of_interaction?.transaction_data?.ticket_url
      };

    } catch (error: any) {
      console.error('Erro detalhado no PIX:', JSON.stringify(error, null, 2));
      throw new Error(error.message || 'Erro ao gerar QR Code PIX');
    }
  }

  // --- VERIFICAR STATUS (Polling) ---
  async getPaymentStatus(paymentId: number) {
    try {
        const result = await this.payment.get({ id: paymentId });
        return { 
            id: result.id, 
            status: result.status, 
            status_detail: result.status_detail 
        };
    } catch (error) {
        return { status: 'error' };
    }
  }
}