import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { corsOrigins, type Env } from './config/env.schema.js';
import { STREAMING_ROUTE_PATTERN } from './common/sse.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: process.env.NODE_ENV === 'production' }),
    // From the framework's own SSE sample: open event-stream connections
    // otherwise hold the process open on shutdown.
    forceCloseConnections: true,
    bufferLogs: true,
  });

  // The CLASS, not the string 'ConfigService' — a string token only resolves
  // if a provider was registered under that exact name, which ConfigModule does
  // not do. Getting this wrong fails at boot, not at compile time.
  const env = app.get(ConfigService<Env, true>);

  /**
   * helmet BEFORE any other app.use(). Middleware runs in registration order, so
   * anything registered earlier serves responses without the security headers.
   */
  app.use(
    helmet({
      // The API serves JSON and SSE, never HTML, so CSP has nothing to protect
      // and its default breaks the Swagger UI.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  /**
   * compression buffers SSE, which is breakage mode #2. Skipped on the streaming
   * path by filter rather than by disabling it everywhere.
   */
  app.use(
    compression({
      filter: (req, res) => {
        if (STREAMING_ROUTE_PATTERN.test(req.path)) return false;
        if (res.getHeader('Content-Type') === 'text/event-stream') return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.enableCors({
    origin: corsOrigins({ CORS_ORIGIN: env.get('CORS_ORIGIN', { infer: true }) } as Env),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  /**
   * Behind Railway / Render / Fly / nginx, `req.ip` is the PROXY's address
   * unless this is set — which silently turns every per-IP throttle tier into
   * one global bucket shared by all users. Trusting one hop is correct for a
   * single reverse proxy; raise it if there are more.
   */
  app.set('trust proxy', 1);

  app.enableShutdownHooks();

  /**
   * Swagger via the lazy factory form, so the document is built on first request
   * rather than at boot. /v1/admin/* is excluded from the public document — the
   * controllers carry @ApiExcludeController.
   */
  const config = new DocumentBuilder()
    .setTitle('Creative Brief Doctor API')
    .setDescription(
      'Paste a brief, get a score across five dimensions with quoted evidence '
      + 'and a ready-to-send list of follow-up questions.',
    )
    .setVersion('1.0')
    .addTag('briefs')
    .addTag('health')
    .build();
  SwaggerModule.setup('api', app, () => SwaggerModule.createDocument(app, config));

  // The Nest starter hardcodes 3000. Read the platform-injected value.
  const port = env.get('PORT', { infer: true }) ?? 3000;
  await app.listen(port);

  new Logger('Bootstrap').log(`API listening on ${await app.getUrl()}`);
}

void bootstrap();
