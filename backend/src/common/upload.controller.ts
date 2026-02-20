import { 
  Controller, 
  Post, 
  UseInterceptors, 
  UploadedFile, 
  BadRequestException 
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { OptimizeImagePipe } from './pipes/optimize-image.pipe'; // <--- Import

@ApiTags('Uploads')
@Controller('uploads')
export class UploadController {
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file')) // <--- Sem diskStorage
  uploadFile(
    @UploadedFile(OptimizeImagePipe) file: Express.Multer.File // <--- Pipe aplicado
  ) {
    if (!file) {
      throw new BadRequestException('Arquivo não enviado.');
    }
    // Retorna o nome do arquivo já otimizado (ex: compressed-123.webp)
    return { filename: file.filename };
  }
}