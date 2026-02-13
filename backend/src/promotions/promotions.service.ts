import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';

@Injectable()
export class PromotionsService {
  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  async getFootballBanner() {
    // =================================================================
    // 🎛️ ÁREA DE SIMULAÇÃO (BACKEND)
    // =================================================================
    
    const simulacaoDia = 3; // Força ser Quarta-feira
    
    // Data com jogos reais (para testar a API). 
    // Quando for pra produção, mude para: const simulacaoData = null;
    // const simulacaoData = '2025-02-12';
    const simulacaoData = null; 

    // =================================================================

    const today = new Date();
    const currentDay = simulacaoDia !== null ? simulacaoDia : today.getDay();

    if (currentDay !== 3) return null;

    // Tenta pegar do cache primeiro (Isso evita o erro 429 - Too Many Requests)
    const cachedMatch = await this.cacheManager.get('football_highlight');
    if (cachedMatch) {
      console.log("📦 Retornando dados do Cache (Economizando API)");
      return cachedMatch;
    }

    try {
      const dateStr = simulacaoData || today.toISOString().split('T')[0];
      console.log(`🔍 Buscando na API para a data: ${dateStr}...`);

      const response = await axios.get('https://api-football-v1.p.rapidapi.com/v3/fixtures', {
        params: {
          date: dateStr,
          timezone: 'America/Sao_Paulo',
          // Inclui Premier League (39) e La Liga (140) e Estaduais (475, 479)
          league: '71-72-13-2-39-140-475-479' 
        },
        headers: {
          'x-rapidapi-key': 'adcf14f53amsh526811539e882d0p16e623jsnfcad9b566cdb',
          'x-rapidapi-host': 'api-football-v1.p.rapidapi.com'
        }
      });

      const matches = response.data.response;

      if (!matches || matches.length === 0) {
        // Se a API responder mas não tiver jogos (ex: erro de permissão silencioso ou data vazia)
        throw new Error("Lista de jogos vazia ou erro de permissão.");
      }

      // Ordena pelo jogo mais tarde
      const sorted = matches.sort((a: any, b: any) => b.fixture.timestamp - a.fixture.timestamp);
      const highlight = sorted[0];

      console.log(`✅ Jogo encontrado: ${highlight.teams.home.name} x ${highlight.teams.away.name}`);

      const matchData = {
        hasGame: true,
        home: highlight.teams.home.name,
        away: highlight.teams.away.name,
        time: highlight.fixture.date.split('T')[1].slice(0, 5),
        tournament: highlight.league.name
      };

      // Salva no cache por 4 horas
      await this.cacheManager.set('football_highlight', matchData, 14400000);
      return matchData;

    } catch (error: any) {
      // Loga o erro mas NÃO QUEBRA o sistema
      console.log(`⚠️ Falha na API (${error.response?.status || '?'}). Usando Mock.`);
      
      // MOCK DE SEGURANÇA (Para você ver funcionando enquanto resolve a assinatura)
      return { 
        hasGame: true, 
        home: "São Paulo (Mock)", 
        away: "Palmeiras (Mock)", 
        time: "21:30", 
        tournament: "Paulistão 2025" 
      };
    }
  }
}