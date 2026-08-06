import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminSessionService } from './admin-session.service';
import { ConnectedShootersService } from './connected-shooters.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '12h') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AdminSessionService,
    ConnectedShootersService,
    // APP_GUARD registers these as GLOBAL guards, run on every request in the
    // app, not just this module's own routes. Order matters: Nest runs them
    // in registration order, and RolesGuard reads request.user, which only
    // exists once JwtAuthGuard has already verified the token and set it.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  // JwtModule is re-exported so RealtimeGateway can verify tokens on the socket
  // handshake. Gateways are not covered by the global JwtAuthGuard above — that
  // guard runs in an HTTP context and reads req.headers, which a WebSocket
  // connection does not have — so the gateway does its own verification and
  // needs the same configured JwtService.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
