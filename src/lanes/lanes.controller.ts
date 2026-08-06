import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { LanesService } from './lanes.service';
import { CreateLaneDto } from './dto/create-lane.dto';
import { UpdateLaneDto } from './dto/update-lane.dto';
import { SetActiveTargetDto } from './dto/set-active-target.dto';
import { Roles } from '@/auth/decorators/roles.decorator';

@Controller('lanes')
export class LanesController {
  constructor(private readonly lanesService: LanesService) { }

  @Roles('SUPER_ADMIN')
  @Post()
  create(@Body() createLaneDto: CreateLaneDto) {
    return this.lanesService.create(createLaneDto);
  }

  @Get()
  findAll() {
    return this.lanesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.lanesService.findOne(+id);
  }

  @Roles('SUPER_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateLaneDto: UpdateLaneDto) {
    return this.lanesService.update(+id, updateLaneDto);
  }

  // Deleting a lane entirely is structural, same tier as create/update —
  // SUPER_ADMIN only. Different from setActiveTarget below, which is
  // day-to-day and open to ADMIN too.
  @Roles('SUPER_ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.lanesService.remove(+id);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Patch(':id/active-target')
  setActiveTarget(@Param('id') id: string, @Body() dto: SetActiveTargetDto) {
    return this.lanesService.setActiveTarget(+id, dto.targetId);
  }
}
