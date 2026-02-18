import { Controller, Get } from '@nestjs/common';
import { PromotionsService } from './promotions.service';

@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get('football')
  getBanner() {
    return this.promotionsService.getFootballBanner();
  }
}