import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { IsBoolean } from 'class-validator';

import { CurrentUser } from '@/auth/decorators/current-user.decorator';
import { Roles } from '@/auth/decorators/roles.decorator';
import type { JwtPayload } from '@/auth/auth.service';
import { USER_ROLES } from '@/auth/roles';

import { CreateAdminDto } from './dto/create-admin.dto';
import { UsersService } from './users.service';

class UpdateAdminPreferencesDto {
  @IsBoolean()
  faceRecognitionEnabled!: boolean;
}

@Roles(USER_ROLES.SUPER_ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Roles(USER_ROLES.ADMIN)
  @Get('me/preferences')
  preferences(@CurrentUser() user: JwtPayload) {
    return this.users.getPreferences(user.sub);
  }

  @Roles(USER_ROLES.ADMIN)
  @Patch('me/preferences')
  updatePreferences(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateAdminPreferencesDto,
  ) {
    return this.users.updatePreferences(user.sub, dto.faceRecognitionEnabled);
  }

  @Get()
  findAll() {
    return this.users.findAll();
  }

  @Post()
  create(@Body() dto: CreateAdminDto) {
    return this.users.create(dto);
  }
}
