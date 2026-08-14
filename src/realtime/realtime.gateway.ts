import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import { Server, Socket } from 'socket.io';

import type { JwtPayload } from '@/auth/auth.service';
import { SensorService } from '@/sensor/sensor.service';
import { SensorGateService } from '@/sensor/sensor-gate.service';
import { SessionsService } from '@/sessions/sessions.service';
import { ConnectedShootersService } from '@/auth/connected-shooters.service';
import { TargetsService } from '@/targets/targets.service';
import { recentServerLogs, serverLogs$ } from './server-log.stream';
const ADMIN_ROOM = 'admin';
/** Per-lane room. A shooter tablet joins exactly one of these. */
const laneRoom = (laneId: number | string) => `lane:${laneId}`;
const deviceRoom = (key: string) => `device:${key}`;

interface SocketUser {
  sub: string;
  username: string;
  role: JwtPayload['role'];
}


@WebSocketGateway({ cors: { origin: '*' } })
export class RealtimeGateway
  implements
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnModuleInit,
  OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);


  @WebSocketServer()
  server!: Server;

  private shotsSub?: Subscription;
  private benchHitsSub?: Subscription;
  private sessionsSub?: Subscription;
  private targetsSub?: Subscription;
  private gateSub?: Subscription;
  private logsSub?: Subscription;
  private assignmentsSub?: Subscription;

  constructor(
    private readonly sensor: SensorService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionsService,
    private readonly targets: TargetsService,
    private readonly gate: SensorGateService,
    private readonly connectedShooters: ConnectedShootersService,
  ) { }

  onModuleInit(): void {
    this.shotsSub = this.sensor.shots$.subscribe((event) => {
      this.server.to(laneRoom(event.laneId)).emit('shot', event);
      this.server.to(ADMIN_ROOM).emit('shot', event);
    });

    // Admin room only, and under a name of its own. A bench bullet is not a
    // session shot — it has no stage, no shot number in any log and no lane
    // display to belong to — so anything listening for 'shot' must not see it.
    this.benchHitsSub = this.sensor.benchHits$.subscribe((event) => {
      this.server.to(ADMIN_ROOM).emit('target:bench-hit', event);
    });

    this.sessionsSub = this.sessions.events$.subscribe((event) => {
      this.server.to(laneRoom(event.laneId)).emit(event.type, event);
      this.server.to(ADMIN_ROOM).emit(event.type, event);
    });

    this.targetsSub = this.targets.calibrations$.subscribe((event) => {
      this.server.to(laneRoom(event.laneId)).emit('target:calibrated', event);
      this.server.to(ADMIN_ROOM).emit('target:calibrated', event);
    });

    this.assignmentsSub = this.connectedShooters.assignments$.subscribe(
      (event) => {
        this.server
          .to(deviceRoom(event.key))
          .emit('device:assigned', event);
        this.server.to(ADMIN_ROOM).emit('device:assigned', event);
      },
    );

    // Range-wide, not lane-scoped — admin console only, unlike the other three.
    this.gateSub = this.gate.changes$.subscribe((status) => {
      this.server.to(ADMIN_ROOM).emit('sensor:gate', status);
    });


    this.logsSub = serverLogs$.subscribe((line) => {
      try {
        this.server?.to(ADMIN_ROOM).emit('server:log', line);
      } catch {
        // Deliberately silent — see above.
      }
    });
  }

  onModuleDestroy(): void {
    this.shotsSub?.unsubscribe();
    this.benchHitsSub?.unsubscribe();
    this.sessionsSub?.unsubscribe();
    this.targetsSub?.unsubscribe();
    this.gateSub?.unsubscribe();
    this.logsSub?.unsubscribe();
    this.assignmentsSub?.unsubscribe();
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      // Shooter tablets carry no credentials by design (see
      // auth.controller.ts's connect()) — allow the connection, but scoped:
      // an anonymous socket can only join a single lane room via join-lane
      // below, never ADMIN_ROOM. Rejecting these outright (the old behaviour)
      // meant a shooter's socket never connected at all, so it silently never
      // received session:started/shot/etc. and just sat on the idle screen.
      client.data.user = null;
      this.logger.log(`Connected ${client.id} as anonymous (lane-only)`);
      return;
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      const user: SocketUser = {
        sub: payload.sub,
        username: payload.username,
        role: payload.role,
      };

      client.data.user = user;

      if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
        await client.join(ADMIN_ROOM);
        // Backlog first, so a console opened mid-relay shows what already
        // happened instead of sitting empty until the next event.
        for (const line of recentServerLogs()) {
          client.emit('server:log', line);
        }
      }

      this.logger.log(
        `Connected ${client.id} as ${user.username} (${user.role})`,
      );
    } catch {
      // A token WAS presented but is invalid/expired — a real bad credential,
      // unlike the no-token case above, and still gets rejected.
      this.logger.warn(`Rejecting ${client.id}: invalid or expired token.`);
      client.emit('unauthorized', { reason: 'invalid_token' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const user = client.data.user as SocketUser | undefined;
    this.logger.log(
      `Disconnected ${client.id}${user ? ` (${user.username})` : ''}`,
    );
  }


  @SubscribeMessage('join-lane')
  async joinLane(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { laneId?: number | string },
  ): Promise<{ ok: boolean; room?: string; error?: string }> {
    // No identity check here — an admin socket and an anonymous shooter
    // socket (client.data.user === null, see handleConnection) are both
    // allowed to join a lane room. A shooter never gets ADMIN_ROOM regardless,
    // so this only ever grants read access to the one lane it asks for.
    const laneId = Number(body?.laneId);
    if (!Number.isInteger(laneId) || laneId < 1) {
      return { ok: false, error: 'laneId must be a positive integer' };
    }

    for (const room of client.rooms) {
      if (room !== client.id && room.startsWith('lane:')) {
        await client.leave(room);
      }
    }

    await client.join(laneRoom(laneId));
    const user = client.data.user as SocketUser | null | undefined;
    this.logger.log(`${user?.username ?? 'anonymous'} joined ${laneRoom(laneId)}`);

    return { ok: true, room: laneRoom(laneId) };
  }


  @SubscribeMessage('join-device')
  async joinDevice(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { key?: string },
  ): Promise<{ ok: boolean; room?: string; error?: string }> {
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    if (!key) return { ok: false, error: 'key is required' };

    // One device room per socket — rejoining after a reconnect or an IP change
    // must not leave the socket listening on a stale key as well.
    for (const room of client.rooms) {
      if (room !== client.id && room.startsWith('device:')) {
        await client.leave(room);
      }
    }

    await client.join(deviceRoom(key));
    this.logger.log(`Socket ${client.id} joined ${deviceRoom(key)}`);
    return { ok: true, room: deviceRoom(key) };
  }

  @SubscribeMessage('leave-lane')
  async leaveLane(
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: boolean }> {
    for (const room of client.rooms) {
      if (room !== client.id && room.startsWith('lane:')) {
        await client.leave(room);
      }
    }
    return { ok: true };
  }


  private extractToken(client: Socket): string | undefined {
    const fromAuth = client.handshake.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth.trim()) {
      return fromAuth.trim();
    }

    const header = client.handshake.headers?.authorization;
    if (typeof header === 'string') {
      // Same whitespace-tolerant parse as JwtAuthGuard — see the comment there.
      const [type, token] = header.trim().split(/\s+/);
      if (type?.toLowerCase() === 'bearer' && token) return token;
    }

    return undefined;
  }
}
