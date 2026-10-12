import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { DefaultUsersSeeder } from './default-users.seeder';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [DefaultUsersSeeder],
})
export class DatabaseModule {}
