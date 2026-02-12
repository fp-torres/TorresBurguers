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
    // Descomente a linha do dia que deseja simular.
    // Para voltar ao automático, deixe apenas 'simulacaoDia = null' ativo.
    // =================================================================
    
    // const simulacaoDia = null; // 🟢 MODO AUTOMÁTICO (Usa data real)
    // const simulacaoDia = 0;    // 🔴 Simula DOMINGO
    // const simulacaoDia = 1;    // 🔴 Simula SEGUNDA
    // const simulacaoDia = 2;    // 🔴 Simula TERÇA
    const simulacaoDia = 3;    // 🟢 Simula QUARTA (Libera API Futebol)
    // const simulacaoDia = 4;    // 🔴 Simula QUINTA
    // const simulacaoDia = 5;    // 🔴 Simula SEXTA
    // const simulacaoDia = 6;    // 🔴 Simula SÁBADO

    // =================================================================

    const today = new Date();
    const currentDay = simulacaoDia !== null ? simulacaoDia : today.getDay();

    // Se não for Quarta (3), retorna null e não gasta processamento
    if (currentDay !== 3) {
      return null; 
    }

    // Tenta pegar do cache primeiro
    const cachedMatch = await this.cacheManager.get('football_highlight');
    if (cachedMatch) {
      return cachedMatch;
    }

    try {
      const dateStr = today.toISOString().split('T')[0];

      // Tenta buscar na API Oficial
      const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
        params: {
          date: dateStr,
          timezone: 'America/Sao_Paulo',
          league: '71-72-13-2-5' 
        },
        headers: {
          'x-rapidapi-key': 'SUA_CHAVE_AQUI', // Se não tiver chave, vai cair no erro abaixo (o que é bom para teste)
          'x-rapidapi-host': 'v3.football.api-sports.io'
        }
      });

      const matches = response.data.response;

      // Se a API retornar vazio (sem jogos hoje), geramos um MOCK para não ficar sem banner
      if (!matches || matches.length === 0) {
        throw new Error("Nenhum jogo encontrado na API hoje.");
      }

      const sorted = matches.sort((a: any, b: any) => b.fixture.timestamp - a.fixture.timestamp);
      const highlight = sorted[0];

      const matchData = {
        hasGame: true,
        home: highlight.teams.home.name,
        away: highlight.teams.away.name,
        time: highlight.fixture.date.split('T')[1].slice(0, 5),
        tournament: highlight.league.name
      };

      await this.cacheManager.set('football_highlight', matchData, 14400000);
      return matchData;

    } catch (error) {
      console.log("⚠️ API de Futebol falhou ou sem jogos. Usando DADOS FICTÍCIOS para teste.");
      
      // --- DADOS DE SEGURANÇA (MOCK) ---
      // Isso garante que você veja o banner funcionando mesmo sem API Key!
      return { 
        hasGame: true, 
        home: "Flamengo", 
        away: "Palmeiras", 
        time: "21:30", 
        tournament: "Brasileirão Série A" 
      };
    }
  }
}