import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm'; // Importante
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity'; // Importante

@Module({
  imports: [TypeOrmModule.forFeature([User])], // <--- Libera o uso do repositório
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}