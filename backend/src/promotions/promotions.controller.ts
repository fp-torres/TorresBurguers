import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PromotionsService } from './promotions.service';

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
