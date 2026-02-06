import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Validação automática (DTOs)
  app.useGlobalPipes(new ValidationPipe());

  // 2. Libera o Frontend para acessar o Backend
  app.enableCors();
  await app.listen(3000);
}
bootstrap();