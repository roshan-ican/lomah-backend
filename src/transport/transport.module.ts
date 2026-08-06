import { Module } from '@nestjs/common';

import { SequenceTracker } from './protocol/sequence.tracker';
import { TargetCommandService } from './target-command.service';
import { TARGET_TRANSPORTS } from './target-transport.interface';
import { TransportRegistry } from './transport.registry';
import { WifiUdpTransport } from './wifi-udp.transport';

@Module({
  providers: [
    WifiUdpTransport,
    {
      // Multi-provider: the registry depends on the ARRAY, not on a concrete
      // class. WiFi is the only transport in scope today (a LoRa path was
      // scaffolded and removed — see target-transport.interface.ts). A second
      // transport, if one is ever needed, is added here and nowhere else.
      provide: TARGET_TRANSPORTS,
      useFactory: (wifi: WifiUdpTransport) => [wifi],
      inject: [WifiUdpTransport],
    },
    TransportRegistry,
    TargetCommandService,
    // SequenceTracker stays framework-free — no @Injectable, no Nest import —
    // so it can be tested with plain `new SequenceTracker()`.
    { provide: SequenceTracker, useFactory: () => new SequenceTracker() },
  ],
  exports: [TransportRegistry, TargetCommandService, SequenceTracker],
})
export class TransportModule {}