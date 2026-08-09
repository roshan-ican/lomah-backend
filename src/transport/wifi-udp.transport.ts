import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import dgram from "node:dgram";
import { Subject } from "rxjs";

import { decodeDatagram } from "./protocol/frame.codec";
import {
  normalizeIp,
  type InBoundFrame,
  type TargetRef,
  type TargetTransport,
  type TransportKind,
} from "./target-transport.interface";

@Injectable()
export class WifiUdpTransport
  implements TargetTransport, OnModuleInit, OnModuleDestroy
{
  readonly kind: TransportKind = "WIFI";

  private readonly logger = new Logger(WifiUdpTransport.name);
  private readonly frames = new Subject<InBoundFrame>();
  readonly frames$ = this.frames.asObservable();

  private socket: dgram.Socket | null = null;
  private ready = false;

  private readonly listenPort: number;
  private readonly targetPort: number;
  private readonly recvBuffer: number;

  constructor(config: ConfigService) {
    this.listenPort = config.get<number>("SENSOR_UDP_LISTEN_PORT", 14555);
    this.targetPort = config.get<number>("SENSOR_UDP_TARGET_PORT", 14550);
    this.recvBuffer = config.get<number>("SENSOR_UDP_RECV_BUFFER", 1 << 20);
  }

  onModuleInit(): void {
    const socket = dgram.createSocket("udp4");
    this.socket = socket;

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        this.logger.error(`UDP ${this.listenPort} already in use.`);
      } else {
        this.logger.warn(`socket error: ${err.message}`);
      }
    });

    socket.on("listening", () => {
      // One socket carries every lane. The default buffer overflows under
      // sustained fire and drops datagrams silently — no error, no event.
      try {
        socket.setRecvBufferSize(this.recvBuffer);
      } catch (err) {
        this.logger.warn(
          `could not raise recv buffer: ${(err as Error).message}`,
        );
      }
      this.ready = true;
      const a = socket.address();
      this.logger.log(
        `listening ${a.address}:${a.port} (rcvbuf ${socket.getRecvBufferSize()})`,
      );
    });

    socket.on("message", (msg, rinfo) => {
      const sourceKey = normalizeIp(rinfo.address);
      for (const r of decodeDatagram(msg)) {
        if (!r.ok) {
          if (r.reason === "CRC_MISMATCH")
            this.logger.warn(`CRC mismatch from ${sourceKey}`);
          continue;
        }
        this.frames.next({
          sourceKey,
          transport: this.kind,
          command: r.frame.command,
          bulletCounter: r.frame.bulletCounter,
          rawX: r.frame.rawX,
          rawY: r.frame.rawY,
          payload: r.frame.payload,
          bytes: r.frame.bytes,
          receivedAt: new Date(),
        });
      }
    });

    socket.bind({ port: this.listenPort, exclusive: false });
  }

  onModuleDestroy(): void {
    this.socket?.close();
    this.socket = null;
    this.ready = false;
    this.frames.complete();
  }

  isReady(): boolean {
    return this.ready;
  }

  async send(target: TargetRef, frame: Buffer): Promise<void> {
    // Commands go to the override when there is one, and only then. The
    // fallback is `ipAddress`, which is also what inbound datagrams are
    // matched on — so a target with no override behaves exactly as before.
    const host = normalizeIp(target.commandHost) || normalizeIp(target.ipAddress);
    if (!host) {
      throw new Error(
        `Target "${target.label}" (lane ${target.laneId}) has no IP bound. Assign one before arming.`,
      );
    }
    if (!this.socket) throw new Error("UDP socket not open");

    const port = target.commandPort ?? this.targetPort;

    await new Promise<void>((resolve, reject) => {
      this.socket!.send(frame, port, host, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}
