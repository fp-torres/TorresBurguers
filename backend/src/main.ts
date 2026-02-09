import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Configuração de Validação Global (Nível Sênior)
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, // Remove chaves que não estão no DTO (Segurança)
    forbidNonWhitelisted: true, // Retorna erro se mandar dados extras
    transform: true, // Tenta converter tipos automaticamente
  }));

  // 2. Configuração do Swagger (Documentação Automática)
  const config = new DocumentBuilder()
    .setTitle('TorresBurgers API')
    .setDescription('API para gestão de hamburgueria e pedidos')
    .setVersion('1.0')
    .addBearerAuth() // Botão para colar o Token JWT na doc
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document); // Rota: http://localhost:3000/api

  // 3. Libera o Frontend (CORS) - Configuração Explícita
  app.enableCors({
    origin: true, // Aceita qualquer origem (em produção, troque pelo domínio real)
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true, // Permite envio de Cookies e Headers de Auth
  });
  
  await app.listen(3000);
}
bootstrap();