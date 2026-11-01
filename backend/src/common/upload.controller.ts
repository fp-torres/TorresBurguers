import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, StaffRoute } from '../tenancy';
import type { TenantContext } from '../tenancy';
import { UserRole } from '../users/entities/user.entity';
import { withOptimizedImage } from './pipes/optimize-image.pipe';
import { ImageFileInterceptor } from './uploads/image-upload';
import { storeFilePrefix } from './uploads/store-files';

@ApiTags('uploads')
@Controller('uploads')
export class UploadController {
  /**
   * Envia uma imagem avulsa da loja (JPG, PNG ou WebP até 5 MB), otimizada e salva como .webp com o
   * prefixo da loja (s<id>-compressed-...). Devolve só o nome do arquivo (servido em /uploads/<nome>),
   * que o cadastro de produtos e adicionais DESTA loja aceita no campo "image".
   */
  @Post()
  @StaffRoute(UserRole.ADMIN)
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
  uploadFile(
    @CurrentTenant() tenant: TenantContext,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Nenhuma imagem enviada. Envie o arquivo no campo "file".',
      );
    }
    return withOptimizedImage(
      file,
      (filename) => Promise.resolve({ filename: filename as string }),
      { prefix: storeFilePrefix(tenant.storeId) },
    );
  }
}
