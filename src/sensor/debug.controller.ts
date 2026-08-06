import { Body, Controller, Post } from '@nestjs/common';

import { Public } from '@/auth/decorators/public.decorator';

import { SensorService } from './sensor.service';
import { SimulateShotDto } from './dto/simulate-shot.dto';

/**
 * Bench-test injection, ported from the old (pre-NestJS) backend's
 * POST /api/debug/simulate-shot. Public/unauthenticated by design, matching
 * the old route (backend/http/routes/debug.routes.ts registered it with no
 * verifySession middleware) — this is what lets the shooter terminal's
 * click-to-shoot and "Simulate Shot" button call it directly with no admin
 * token, same as StationTerminal's other debug affordances.
 */
@Controller('debug')
export class DebugController {
  constructor(private readonly sensor: SensorService) {}

  @Public()
  @Post('simulate-shot')
  simulateShot(@Body() dto: SimulateShotDto) {
    return this.sensor.simulateHit(dto.laneId, dto.x, dto.y);
  }
}
