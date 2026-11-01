import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicStore, PublicStoreRoute } from '../tenancy';
import type { TenantContext } from '../tenancy';
import { PromotionsService } from './promotions.service';

/** Banner global das rotas antigas (app mobile e versões antigas do site): fuso de Brasília. */
@ApiTags('promotions')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  /** Banner da página inicial: jogo do dia ou promoção do dia (público). */
  @Get('banner')
  getBanner() {
    return this.promotionsService.getBanner();
  }

  /** Alias mantido para versões antigas do app/site. */
  @Get('football')
  getFootballBanner() {
    return this.promotionsService.getBanner();
  }
}

/** Banner da vitrine de uma loja (fuso da loja). Loja inexistente ou desativada → 404. */
@ApiTags('promotions')
@Controller('stores/:storeSlug/promotions')
export class StorePromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  // A loja vem só do slug: o token (se houver) não muda nada, então nem é lido
  @Get('banner')
  @PublicStoreRoute({ auth: 'none' })
  getBanner(@PublicStore() store: TenantContext) {
    return this.promotionsService.getStoreBanner({
      id: store.storeId,
      time_zone: store.store.time_zone,
    });
  }
}
