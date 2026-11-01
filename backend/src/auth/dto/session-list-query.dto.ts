import { PickType } from '@nestjs/swagger';
import { StoreListQueryDto } from '../../store/dto/store-list-query.dto';

/** GET /auth/sessions?page=&pageSize= (padrão 1 × 20; no máximo 100 por página). */
export class SessionListQueryDto extends PickType(StoreListQueryDto, [
  'page',
  'pageSize',
] as const) {}
