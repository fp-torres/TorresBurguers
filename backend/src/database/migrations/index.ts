import { BaselineSchema1791764966404 } from './1791764966404-BaselineSchema';
import { MultiTenantFoundation1791765597480 } from './1791765597480-MultiTenantFoundation';
import { TenancyIndexes1791773437187 } from './1791773437187-TenancyIndexes';
import { MaintenanceJobs1792299658658 } from './1792299658658-MaintenanceJobs';
import { PlatformIntegrity1792800000000 } from './1792800000000-PlatformIntegrity';
import { OrderNumbersAndCustomerBlocks1792963851057 } from './1792963851057-OrderNumbersAndCustomerBlocks';
import { AuthSessions1792964108700 } from './1792964108700-AuthSessions';
import { AddressZoneLocation1793476392120 } from './1793476392120-AddressZoneLocation';
import { PlanStorageLimit1793477263977 } from './1793477263977-PlanStorageLimit';
import { StoreSlugHistoryAndCancelOrigin1793485300000 } from './1793485300000-StoreSlugHistoryAndCancelOrigin';
import { PerformanceIndexes1793490000000 } from './1793490000000-PerformanceIndexes';
import { AccountEmailVerification1793491000000 } from './1793491000000-AccountEmailVerification';
import { AuthSessionRefresh1793492000000 } from './1793492000000-AuthSessionRefresh';

/**
 * Migrations do banco, em ordem de execução. Lista explícita (sem glob): funciona igual no
 * ts-node (CLI), no Jest e no build (dist), e uma migration nunca é esquecida por causa do caminho.
 *
 * Nunca edite uma migration que já possa ter rodado em outro ambiente: crie uma nova.
 */
export const MIGRATIONS = [
  BaselineSchema1791764966404,
  MultiTenantFoundation1791765597480,
  TenancyIndexes1791773437187,
  MaintenanceJobs1792299658658,
  PlatformIntegrity1792800000000,
  OrderNumbersAndCustomerBlocks1792963851057,
  AuthSessions1792964108700,
  AddressZoneLocation1793476392120,
  PlanStorageLimit1793477263977,
  StoreSlugHistoryAndCancelOrigin1793485300000,
  PerformanceIndexes1793490000000,
  AccountEmailVerification1793491000000,
  AuthSessionRefresh1793492000000,
];
