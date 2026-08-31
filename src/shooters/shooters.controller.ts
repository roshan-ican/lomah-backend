import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { Roles } from '@/auth/decorators/roles.decorator';
import { CurrentUser } from '@/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@/auth/auth.service';

import { CreateShooterDto } from './dto/create-shooter.dto';
import { UpdateShooterDto } from './dto/update-shooter.dto';
import { ShootersService } from './shooters.service';

@Controller('shooters')
export class ShootersController {
  constructor(private readonly shooters: ShootersService) {}

  // Roster management is day-to-day range operation, not commissioning — an
  // ADMIN enrols shooters. Contrast lanes and targets, which are SUPER_ADMIN.
  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateShooterDto) {
    return this.shooters.create(user, dto);
  }

  // No @Roles here, so any authenticated caller reaches these — what makes
  // that safe is the owner filter in the service, not the guard.
  @Get()
  findAll(@CurrentUser() user: JwtPayload) {
    return this.shooters.findAll(user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.shooters.findOne(id, user);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateShooterDto,
  ) {
    return this.shooters.update(id, user, dto);
  }

  // ADMIN may delete a shooter from their own roster. The service applies the
  // owner scope and still refuses deletion once the shooter has session history.
  @Roles('SUPER_ADMIN', 'ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.shooters.remove(id, user);
  }
}
