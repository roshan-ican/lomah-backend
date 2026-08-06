import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { BroadcastLogger } from './realtime/broadcast.logger';

async function bootstrap(): Promise<void> {
  // Same console output as the default logger, plus a copy of every line on
  // serverLogs$ for the admin console's activity log.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    logger: new BroadcastLogger(),
  });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3001);

  // 0.0.0.0, not 127.0.0.1.
  //
  // Binding decides which network interfaces will accept connections. Loopback
  // only would mean shooter tablets and target boards on the range LAN could
  // never reach this server — the single most common reason a range server
  // "works on my machine" and nowhere else.
  const host = config.get<string>('HOST', '0.0.0.0');

  await app.listen(port, host);
  new Logger('Bootstrap').log(`LOMAH backend listening on http://${host}:${port}`);
}

void bootstrap();
