import { Injectable, PipeTransform, BadRequestException } from '@nestjs/common';
import * as path from 'path';
import sharp from 'sharp'; // <--- Mudança aqui: importação padrão
import * as fs from 'fs';

@Injectable()
export class OptimizeImagePipe implements PipeTransform<Express.Multer.File> {
  async transform(image: Express.Multer.File): Promise<Express.Multer.File> {
    if (!image || !image.buffer) return image;

    // Validação básica de tipo
    if (!image.mimetype.match(/\/(jpg|jpeg|png|webp)$/)) {
      throw new BadRequestException('Formato de arquivo inválido. Apenas JPG, PNG ou WebP.');
    }

    // Garante que a pasta uploads existe
    const uploadPath = './uploads';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    // Gera nome único com extensão .webp
    const filename = `compressed-${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
    const fullPath = path.join(uploadPath, filename);

    try {
      // A MÁGICA ACONTECE AQUI:
      // 1. Pega o buffer da imagem
      // 2. Redimensiona para ter no máximo 800px de largura
      // 3. Converte para WebP (muito leve)
      // 4. Qualidade 80% (equilíbrio entre tamanho e visual)
      await sharp(image.buffer)
        .resize({ width: 800, withoutEnlargement: true }) 
        .webp({ quality: 80 }) 
        .toFile(fullPath);

      // Atualiza as propriedades do arquivo para o Controller usar
      // O filename agora terá a extensão .webp
      image.filename = filename;
      image.path = fullPath;
      image.mimetype = 'image/webp';

      return image;
    } catch (error) {
      console.error('Erro ao otimizar imagem:', error);
      throw new BadRequestException('Erro ao processar imagem.');
    }
  }
}