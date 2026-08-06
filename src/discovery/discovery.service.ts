import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dgram from 'node:dgram';
import * as os from 'node:os';

/**
 * Periodic UDP broadcast so a shooter tablet finds this server without
 * anyone typing an IP address in. Ported from the old backend's beacon in
 * server.ts — same wire format (`LOMAH-ADMIN|<port>`), same broadcast
 * strategy (limited broadcast + every non-internal interface's directed
 * broadcast, since which one actually reaches the tablet depends on the
 * range's network setup).
 */
@Injectable()
export class DiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscoveryService.name);

  private socket?: dgram.Socket;
  private interval?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const httpPort = this.config.get<number>('PORT', 3001);
    const beaconPort = this.config.get<number>('DISCOVERY_PORT', 5002);
    const intervalMs = this.config.get<number>('DISCOVERY_INTERVAL_MS', 2000);

    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => {
      this.logger.warn(`Beacon socket error: ${err.message}`);
    });

    this.socket.bind(() => {
      this.socket?.setBroadcast(true);
      this.logger.log(`Broadcasting LOMAH-ADMIN on UDP port ${beaconPort}`);
    });

    this.interval = setInterval(
      () => this.broadcast(beaconPort, httpPort),
      intervalMs,
    );
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.socket?.close();
  }

  private broadcast(beaconPort: number, httpPort: number): void {
    if (!this.socket) return;
    const msg = Buffer.from(`LOMAH-ADMIN|${httpPort}`);

    // Limited broadcast reaches the default route interface.
    this.socket.send(msg, beaconPort, '255.255.255.255', (err) => {
      if (err) this.logger.warn(`255.255.255.255 send failed: ${err.message}`);
    });

    // Directed broadcast on every other non-internal IPv4 interface, since a
    // multi-NIC server's default route may not be the one the range LAN is on.
    for (const addrs of Object.values(os.networkInterfaces())) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal || !addr.netmask) continue;
        const broadcast = this.broadcastAddress(addr.address, addr.netmask);
        if (!broadcast) continue;
        this.socket.send(msg, beaconPort, broadcast, (err) => {
          if (err) this.logger.warn(`${broadcast} send failed: ${err.message}`);
        });
      }
    }
  }

  private broadcastAddress(ip: string, netmask: string): string | null {
    const ipParts = ip.split('.');
    const maskParts = netmask.split('.');
    if (ipParts.length !== 4 || maskParts.length !== 4) return null;

    return ipParts
      .map((octet, i) => {
        const o = Number(octet);
        const m = Number(maskParts[i]);
        return (o | (~m & 0xff)).toString();
      })
      .join('.');
  }
}
