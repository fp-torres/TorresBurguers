import { Global, Module } from '@nestjs/common';
import { MailService } from '../notifications/mail.service';
import { RateLimitService } from './rate-limit/rate-limit.service';

/** Serviços transversais sem estado de banco (globais): limite de tentativas e e-mail. */
@Global()
@Module({
  providers: [RateLimitService, MailService],
  exports: [RateLimitService, MailService],
})
export class SharedModule {}
