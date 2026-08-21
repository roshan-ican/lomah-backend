import { Controller, Get, Post, Body, Param, Patch, Query } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { FeedbackDto } from './dto/feedback.dto';
import { Roles } from '@/auth/decorators/roles.decorator';
import { Public } from '@/auth/decorators/public.decorator';
import { CalibrateShotDto } from './dto/calibrate-shot.dto';
import { CurrentUser } from '@/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@/auth/auth.service';

@Roles('SUPER_ADMIN', 'ADMIN')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) { }

  @Post()
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: JwtPayload) {
    return this.sessionsService.create(dto, user);
  }

  // Public and unauthenticated on purpose — see SessionsService.findActiveByLane.
  // @Roles() here (no args) overrides the class-level restriction for just this
  // route; @Public() alone is not enough since RolesGuard would still read
  // request.user, which a @Public() route never populates.
  @Public()
  @Roles()
  @Get('by-lane/:laneId')
  findActiveForLane(@Param('laneId') laneId: string) {
    return this.sessionsService.findActiveByLane(+laneId);
  }

  /** Live sessions only by default — see SessionsService.findAll.
   *  `?all=true` returns finished ones too. */
  @Get()
  findAll(@Query('all') all?: string) {
    return this.sessionsService.findAll(all === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sessionsService.findOne(id);
  }

  @Post(':id/start')
  start(@Param('id') id: string) {
    return this.sessionsService.start(id);
  }

  @Post(':id/advance')
  advance(@Param('id') id: string) {
    return this.sessionsService.advance(id);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.sessionsService.pause(id);
  }

  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.sessionsService.resume(id);
  }

  /** Finish a relay with a valid scorecard. Contrast /stop, which cancels. */
  @Post(':id/end')
  end(@Param('id') id: string) {
    return this.sessionsService.end(id);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.sessionsService.stop(id);
  }

  @Patch(':id/feedback')
  feedback(@Param('id') id: string, @Body() dto: FeedbackDto) {
    return this.sessionsService.addFeedback(id, dto.feedback, dto.notes);
  }

  @Post(':id/stages/:stageId/shots/:shotNumber/calibrate')
  calibrateShot(
    @Param('id') id: string,
    @Param('stageId') stageId: string,
    @Param('shotNumber') shotNumber: string,
    @Body() dto: CalibrateShotDto,
  ) {
    return this.sessionsService.calibrateShot(
      id,
      stageId,
      Number(shotNumber),
      dto.x,
      dto.y,
    );
  }

  /**
   * Destructive: deletes the stage's shots so it can be re-fired. SUPER_ADMIN
   * only — the class-level @Roles allows ADMIN, and this method's decorator
   * narrows it. Losing recorded shots is not day-to-day range operation.
   */
  @Roles('SUPER_ADMIN')
  @Post(':id/stages/:stageId/reset')
  resetStage(@Param('id') id: string, @Param('stageId') stageId: string) {
    return this.sessionsService.resetStageShots(id, stageId);
  }
}
