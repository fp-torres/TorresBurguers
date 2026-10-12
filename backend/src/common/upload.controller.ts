import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { OptimizeImagePipe } from './pipes/optimize-image.pipe';
import { ImageFileInterceptor } from './uploads/image-upload';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadController {
  /** Envia uma imagem avulsa (JPG, PNG ou WebP até 5 MB). Ela é otimizada e salva como .webp. */
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(ImageFileInterceptor('file'))
  uploadFile(@UploadedFile(OptimizeImagePipe) file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException(
        'Nenhuma imagem enviada. Envie o arquivo no campo "file".',
      );
    }
    // Nome do arquivo otimizado (ex.: compressed-<data>-<código>.webp), servido em /uploads/<nome>
    return { filename: file.filename };
  }
}
