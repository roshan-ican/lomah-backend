import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthService, JwtPayload } from './auth.service';
import { ConnectedShootersService } from './connected-shooters.service';
import { LoginDto } from './dto/login.dto';
import { ConnectDto } from './dto/connect.dto';
import { AssignConnectedDeviceDto } from './dto/assign-connected-device.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly connectedShooters: ConnectedShootersService,
  ) {}

  // The one deliberately unauthenticated route in the app — you can't be
  // asked for a token to obtain a token. SUPER_ADMIN and ADMIN only — shooters
  // never log in, see connect() below.
  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // Releases the single-active-admin lock so the next admin can log in.
  @Post('logout')
  logout(@CurrentUser() user: JwtPayload) {
    this.authService.logout(user.sub);
    return { ok: true };
  }

  // A shooter's tablet, not a person — no credentials. It announces itself,
  // gets back whatever lane an admin has assigned it to (or null if nobody
  // has yet), and polls this again periodically to notice a reassignment.
  @Public()
  @Post('connect')
  connect(@Req() req: Request, @Body() dto: ConnectDto) {
    const ip =
      (req.headers['x-forwarded-for'] as string) ||
      req.ip ||
      req.socket.remoteAddress ||
      '';
    return this.connectedShooters.connect(ip, dto.deviceId);
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Get('connected-shooters')
  listConnectedShooters() {
    return this.connectedShooters.list();
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post('connected-shooters/assign')
  assignConnectedShooter(@Body() dto: AssignConnectedDeviceDto) {
    return this.connectedShooters.assign(dto.deviceKey, dto.laneId);
  }
}
