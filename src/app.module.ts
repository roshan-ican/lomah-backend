import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';

import { PrismaModule } from './common/prisma/prisma.module';
import { TransportModule } from './transport/transport.module';
import { TargetsModule } from './targets/targets.module';
import { AuthModule } from './auth/auth.module';
import { LanesModule } from './lanes/lanes.module';
import { SessionsModule } from './sessions/sessions.module';
import { SensorModule } from './sensor/sensor.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ShootersModule } from './shooters/shooters.module';
import { ReportsModule } from './reports/reports.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { SystemModule } from './system/system.module';

/**
 * The frontend build sits in a different place depending on how this process
 * was started, mirroring frontend/electron-app/main.ts's resolveFrontendDir.
 * Resolved off process.cwd(), not __dirname: `nest start --watch` bundles
 * everything through webpack HMR into one file, which makes __dirname
 * unreliable, but cwd is pinned in every launch path — `npm run start:dev`
 * runs from lomah-nest/, and the Electron-spawned `node dist/src/main.js` is
 * spawned with `cwd: BACKEND_DIR` explicitly.
 *   - packaged Electron build: backend and frontend are sibling folders under
 *     resourcesPath/app (cwd …/app/backend, frontend at …/app/dist)
 *   - dev / unpackaged: cwd is <repo>/lomah-nest, frontend build is a sibling
 *     folder at <repo>/frontend/dist
 */
function resolveFrontendDist(): string {
  const packagedDist = join(process.cwd(), '..', 'dist');
  if (existsSync(join(packagedDist, 'index.html'))) return packagedDist;
  return join(process.cwd(), '..', 'frontend', 'dist');
}

/**
 * Module layout mirrors the domain, not the file types.
 *
 *   transport/  every wire and radio concern, and nothing else
 *   sensor/     attribution + ingestion: frame -> target -> lane -> shot
 *   lanes/      lane layout, owned by SUPER_ADMIN at commissioning
 *   targets/    physical targets, their addresses and calibration
 *   sessions/   the firing lifecycle
 *   realtime/   socket.io gateway, admin and lane rooms
 *   discovery/  UDP beacon so shooter tablets find this server unaided
 *
 * Feature modules below are scaffolded incrementally — see README §Next steps.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '.env.local'] }),
    ScheduleModule.forRoot(),
    // Serves the built admin/shooter SPA for everything outside /api and
    // /health. Without this, the shooter's post-assignment redirect to
    // http://<admin>:3001/station/:laneId (see ShooterWait.tsx) 404s — this
    // backend is the only thing listening on that port, so it has to be the
    // one to hand back index.html and let React Router take it from there.
    ServeStaticModule.forRoot({
      rootPath: resolveFrontendDist(),
      exclude: ['/api/(.*)', '/health'],
    }),
    PrismaModule,
    TransportModule,
    TargetsModule,
    AuthModule,
    LanesModule,
    SessionsModule,
    SensorModule,
    RealtimeModule,
    ShootersModule,
    ReportsModule,
    DiscoveryModule,
    SystemModule,
  ],
})
export class AppModule {}
