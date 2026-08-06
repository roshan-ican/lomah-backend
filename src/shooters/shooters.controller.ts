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
  create(@Body() dto: CreateShooterDto) {
    return this.shooters.create(dto);
  }

  @Get()
  findAll() {
    return this.shooters.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.shooters.findOne(id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateShooterDto) {
    return this.shooters.update(id, dto);
  }

  // Deleting a person from the roster is destructive and refused outright once
  // they have session history — SUPER_ADMIN only.
  @Roles('SUPER_ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.shooters.remove(id);
  }
}
