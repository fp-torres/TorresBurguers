import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';

@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);
  private readonly API_URL = 'https://api.football-data.org/v4/matches';
  
  // Competições permitidas no plano Free
  private readonly COMPETITIONS = 'BSA,CL,PL,PD,SA,FL1,BL1,PPL,ELC,DED,WC,EC'; 

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  async getFootballBanner() {
    // =================================================================
    // 🎛️ ÁREA DE SIMULAÇÃO
    // =================================================================
    // null = Data Real. 
    // Mude para 0-6 para testar promos de outros dias (0=Dom, 1=Seg, ... 6=Sab)
    const simulacaoDia: number | null = null; 
    // =================================================================

    const today = new Date();
    const currentDay = simulacaoDia !== null ? simulacaoDia : today.getDay();
    const dateStr = today.toISOString().split('T')[0];

    // 1. Tenta pegar do Cache (Seja futebol ou promo do dia)
    const cachedData = await this.cacheManager.get('home_banner');
    if (cachedData) {
      this.logger.log("📦 Banner recuperado do Cache");
      return cachedData;
    }

    // 2. TENTATIVA PRINCIPAL: API DE FUTEBOL
    try {
      this.logger.log(`🔍 Verificando jogos na API...`);
      
      const token = process.env.FOOTBALL_DATA_TOKEN;
      if (!token) throw new Error('Token API Futebol ausente');

      const response = await axios.get(this.API_URL, {
        headers: { 'X-Auth-Token': token },
        params: {
          dateFrom: dateStr,
          dateTo: dateStr,
          competitions: this.COMPETITIONS,
        },
        timeout: 5000 // Timeout curto para não travar o site
      });

      const matches = response.data.matches;

      if (matches && matches.length > 0) {
        // --- CENÁRIO A: TEM JOGO! ---
        const highlight = matches[0]; // Pega o primeiro jogo relevante
        
        this.logger.log(`✅ Futebol Encontrado: ${highlight.homeTeam.name} vs ${highlight.awayTeam.name}`);

        const matchTime = new Date(highlight.utcDate).toLocaleTimeString('pt-BR', { 
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
        });

        const bannerData = {
          type: 'football', // Tipo Futebol
          message: `Hoje tem Jogão! ${highlight.homeTeam.shortName || highlight.homeTeam.name} x ${highlight.awayTeam.shortName || highlight.awayTeam.name} às ${matchTime}`,
          subMessage: `Acompanhe com o melhor burger da cidade. ⚽🍔`,
          details: {
            home: highlight.homeTeam.name,
            away: highlight.awayTeam.name,
            tournament: highlight.competition.name,
            time: matchTime
          }
        };

        // Cache de 4 horas para Futebol
        await this.cacheManager.set('home_banner', bannerData, 14400000);
        return bannerData;
      }

    } catch (error: any) {
      this.logger.warn(`⚠️ Sem futebol ou API falhou: ${error.message}. Carregando Promoção do Dia.`);
    }

    // 3. FALLBACK: PROMOÇÃO DO DIA (Se não tiver jogo ou der erro)
    // --- CENÁRIO B: PROMOÇÃO DA LOJA ---
    const promoData = this.getStorePromotion(currentDay);
    
    this.logger.log(`🏷️ Exibindo Promoção: ${promoData.title}`);
    
    // Cache de 12 horas para Promoção do Dia (muda pouco)
    await this.cacheManager.set('home_banner', promoData, 43200000);
    
    return promoData;
  }

  // --- CONFIGURAÇÃO DAS PROMOÇÕES SEMANAIS ---
  private getStorePromotion(day: number) {
    const promos: Record<number, any> = {
      0: { // Domingo
        type: 'promo',
        theme: 'orange',
        title: 'Domingo em Família 👨‍👩‍👧‍👦',
        message: 'Combo Família com 15% OFF! 3 X-Saladas + Batata Grande.',
        coupon: 'DOMINGO15'
      },
      1: { // Segunda
        type: 'promo',
        theme: 'yellow',
        title: 'Segunda sem Carne? Aqui não! 🥩',
        message: 'Comece a semana com energia. Qualquer Smash Burger por R$ 19,90.',
        coupon: 'SEGUNDOU'
      },
      2: { // Terça
        type: 'promo',
        theme: 'red',
        title: 'Terça em Dobro 🍔🍔',
        message: 'Comprou um Torres Burger, o segundo sai pela metade do preço!',
        coupon: 'DOBRO25'
      },
      3: { // Quarta (Se não tiver futebol)
        type: 'promo',
        theme: 'green',
        title: 'Quarta do Frete Grátis 🛵',
        message: 'Peça acima de R$ 40,00 e a entrega é por nossa conta.',
        coupon: 'FRETEFREE'
      },
      4: { // Quinta
        type: 'promo',
        theme: 'purple',
        title: 'Quinta da Bebida 🥤',
        message: 'Na compra de qualquer Combo, o refrigerante é GRÁTIS!',
        coupon: 'REFRINAFAIXA'
      },
      5: { // Sexta
        type: 'promo',
        theme: 'blue',
        title: 'Sextou com Bacon! 🥓',
        message: 'Adicional de Bacon Grátis em todos os lanches hoje.',
        coupon: 'SEXTOUBACON'
      },
      6: { // Sábado
        type: 'promo',
        theme: 'red',
        title: 'Sabadão Matador de Fome 🔥',
        message: 'Monster Burger (3 carnes) com desconto especial.',
        coupon: 'MONSTER'
      }
    };

    return promos[day] || promos[0]; // Retorna a do dia ou Domingo como padrão
  }
}