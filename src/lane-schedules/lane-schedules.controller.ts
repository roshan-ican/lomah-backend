import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '@/auth/auth.service';
import { CurrentUser } from '@/auth/decorators/current-user.decorator';
import { Roles } from '@/auth/decorators/roles.decorator';
import { CreateLaneScheduleDto } from './dto/create-lane-schedule.dto';
import { LaneScheduleRangeDto } from './dto/lane-schedule-range.dto';
import { UpdateLaneScheduleDto } from './dto/update-lane-schedule.dto';
import { LaneSchedulesService } from './lane-schedules.service';

@Roles('ADMIN')
@Controller('lane-schedules')
export class LaneSchedulesController {
  constructor(private readonly schedules: LaneSchedulesService) {}

  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateLaneScheduleDto,
  ) {
    return this.schedules.create(user.sub, dto);
  }

  @Get()
  findRange(
    @CurrentUser() user: JwtPayload,
    @Query() query: LaneScheduleRangeDto,
  ) {
    return this.schedules.findRange(user.sub, query);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateLaneScheduleDto,
  ) {
    return this.schedules.update(id, user.sub, dto);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.schedules.cancel(id, user.sub);
  }
}
