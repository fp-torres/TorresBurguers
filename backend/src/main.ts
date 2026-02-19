import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Configuração de Validação Global
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, // Remove chaves que não estão no DTO
    forbidNonWhitelisted: true, // Erro se mandar dados extras
    transform: true, // Converte tipos (ex: string '1' virar number 1)
  }));

  // 2. Configuração do Swagger
  const config = new DocumentBuilder()
    .setTitle('TorresBurgers API')
    .setDescription('API para gestão de hamburgueria e pedidos')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // 3. Libera o Frontend (CORS)
  app.enableCors({
    origin: true, // Aceita qualquer origem
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });
  
  await app.listen(3000);
}
bootstrap();