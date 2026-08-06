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
import { TargetsService } from '@/targets/targets.service';
const ADMIN_ROOM = 'admin';
/** Per-lane room. A shooter tablet joins exactly one of these. */
const laneRoom = (laneId: number | string) => `lane:${laneId}`;

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
  private sessionsSub?: Subscription;
  private targetsSub?: Subscription;
  private gateSub?: Subscription;

  constructor(
    private readonly sensor: SensorService,
    private readonly jwt: JwtService,
    private readonly sessions: SessionsService,
    private readonly targets: TargetsService,
    private readonly gate: SensorGateService,
  ) { }

  onModuleInit(): void {
    this.shotsSub = this.sensor.shots$.subscribe((event) => {
      this.server.to(laneRoom(event.laneId)).emit('shot', event);
      this.server.to(ADMIN_ROOM).emit('shot', event);
    });

    this.sessionsSub = this.sessions.events$.subscribe((event) => {
      this.server.to(laneRoom(event.laneId)).emit(event.type, event);
      this.server.to(ADMIN_ROOM).emit(event.type, event);
    });

    this.targetsSub = this.targets.calibrations$.subscribe((event) => {
      this.server.to(laneRoom(event.laneId)).emit('target:calibrated', event);
      this.server.to(ADMIN_ROOM).emit('target:calibrated', event);
    });

    // Range-wide, not lane-scoped — admin console only, unlike the other three.
    this.gateSub = this.gate.changes$.subscribe((status) => {
      this.server.to(ADMIN_ROOM).emit('sensor:gate', status);
    });
  }

  onModuleDestroy(): void {
    this.shotsSub?.unsubscribe();
    this.sessionsSub?.unsubscribe();
    this.targetsSub?.unsubscribe();
    this.gateSub?.unsubscribe();
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
