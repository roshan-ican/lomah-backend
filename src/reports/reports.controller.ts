import { Controller, Get, Param, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportRangeDto } from './dto/report-range.dto';
import { ShooterShotsQueryDto } from './dto/shooter-shots-query.dto';
import { Roles } from '@/auth/decorators/roles.decorator';
import { CurrentUser } from '@/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@/auth/auth.service';

@Roles('SUPER_ADMIN', 'ADMIN')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('sessions')
  listSessions() {
    return this.reportsService.listSessions();
  }

  @Get('session/:id')
  getSession(@Param('id') id: string) {
    return this.reportsService.getSession(id);
  }

  @Get('shooters/:username/shots')
  getShooterShots(
    @Param('username') username: string,
    @CurrentUser() user: JwtPayload,
    @Query() query: ShooterShotsQueryDto,
  ) {
    return this.reportsService.getShooterShots(
      username,
      user,
      query.date,
      query.from,
      query.to,
    );
  }

  @Get('shooters/:username')
  getShooterReport(
    @Param('username') username: string,
    @CurrentUser() user: JwtPayload,
    @Query() query: ReportRangeDto,
  ) {
    return this.reportsService.getShooterReport(username, user, query.from, query.to);
  }
}
