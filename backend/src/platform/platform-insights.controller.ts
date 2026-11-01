import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { platformInsightsCacheMs } from '../config/env';
import { PlatformRoute } from '../tenancy/decorators';
import { AuditQueryDto } from './dto/platform-audit.dto';
import { FinanceQueryDto } from './dto/platform-finance.dto';
import { PlatformAuditService } from './platform-audit.service';
import { InsightsCache } from './platform-insights-cache';
import { PlatformInsightsService } from './platform-insights.service';

/**
 * Superpainel › Dashboard, Financeiro e Auditoria (somente leitura). Receita da plataforma (faturas
 * da assinatura pagas) e volume das lojas (GMV) vêm em blocos separados e nunca são somados.
 */
@ApiTags('Superpainel — indicadores e auditoria')
@Controller('platform')
@PlatformRoute()
export class PlatformInsightsController {
  /** Cache curto (PLATFORM_INSIGHTS_CACHE_MS): ver platform-insights-cache.ts. */
  private readonly cache = new InsightsCache(platformInsightsCacheMs());

  constructor(
    private readonly insights: PlatformInsightsService,
    private readonly auditLogs: PlatformAuditService,
  ) {}

  /** Lojas, assinaturas, MRR/ARR, churn, pedidos, GMV, receita, planos e alertas. */
  @Get('dashboard')
  dashboard() {
    return this.cache.get('dashboard', () => this.insights.dashboard());
  }

  /** ?from=AAAA-MM-DD&to=AAAA-MM-DD (padrão: os últimos 12 meses do calendário). */
  @Get('finance')
  finance(@Query() query: FinanceQueryDto) {
    const key = `finance|${query.from ?? ''}|${query.to ?? ''}`;
    return this.cache.get(key, () => this.insights.finance(query));
  }

  /** ?store_id=&actor_id=&action=&result=&actor_scope=&from=&to=&page=&pageSize= */
  @Get('audit')
  audit(@Query() query: AuditQueryDto) {
    return this.auditLogs.list(query);
  }
}
