import { Controller, Get } from '@nestjs/common';
import { Public } from '@/auth/decorators/public.decorator';

/**
 * Liveness probe, and the source of truth for the range's clock.
 *
 * Excluded from the global 'api' prefix in main.ts, so this is /health, not
 * /api/health. @Public because a client has to be able to reach it before it
 * has a token — and because the shooter tablets poll it to measure clock skew.
 *
 * `serverTime` is load-bearing: session countdowns are driven by a startedAt
 * issued by this machine but ticked against each device's own clock. Range
 * PCs are rarely NTP-synced, so without correcting for the offset the admin
 * and shooter timers drift apart by exactly however far the clocks disagree.
 */
@Public()
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
