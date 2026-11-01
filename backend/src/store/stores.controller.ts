import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicStore, PublicStoreRoute } from '../tenancy/decorators';
import type { TenantContext } from '../tenancy/tenant-context';
import { StoreListQueryDto } from './dto/store-list-query.dto';
import { StoreDirectoryService } from './store-directory.service';
import { presentStoreStatus } from './store-presenter';

/**
 * Vitrine pública das lojas (/stores). A loja vem do :storeSlug da URL (PublicStoreGuard): inexistente
 * ou desativada → 404. Rotas literais ("default") ficam antes de ":storeSlug".
 */
@ApiTags('stores')
@Controller('stores')
export class StoresController {
  constructor(private readonly directory: StoreDirectoryService) {}

  /** Diretório das lojas que estão vendendo: ?search=&page=&pageSize= → { items, total, page, pageSize }. */
  @Get()
  list(@Query() query: StoreListQueryDto) {
    return this.directory.list(query);
  }

  /** Perfil público da loja padrão (a das rotas antigas) ou 404. */
  @Get('default')
  defaultStore() {
    return this.directory.defaultProfile();
  }

  // O slug da URL decide a loja (o token não é lido aqui: auth 'none')
  @Get(':storeSlug')
  @PublicStoreRoute({ auth: 'none' })
  profile(@PublicStore() store: TenantContext) {
    return this.directory.profile(store);
  }

  /** Mesmo formato de GET /store/status. */
  @Get(':storeSlug/status')
  @PublicStoreRoute({ auth: 'none' })
  status(@PublicStore() store: TenantContext) {
    return presentStoreStatus(store.store);
  }
}
