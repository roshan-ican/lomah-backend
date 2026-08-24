import { Body, Controller, Get, Post } from '@nestjs/common';

import { Roles } from '@/auth/decorators/roles.decorator';

import { CreateAdminDto } from './dto/create-admin.dto';
import { UsersService } from './users.service';


@Roles('SUPER_ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  findAll() {
    return this.users.findAll();
  }

  @Post()
  create(@Body() dto: CreateAdminDto) {
    return this.users.create(dto);
  }
}
