import path from 'node:path';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import { HttpAdapterHost } from '@nestjs/core';
import { validateEnv } from './config/env.schema.js';
import { TIERS } from './common/throttle-tiers.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { AiModule } from './ai/ai.module.js';
import { AdminModule } from './admin/admin.module.js';
import { PromptsModule } from './prompts/prompts.module.js';
import { DiagnosisModule } from './diagnosis/diagnosis.module.js';
import { HealthModule } from './health/health.module.js';
import { AIErrorFilter } from './ai/ai-error.filter.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      /**
       * The .env lives at the REPO ROOT, not next to this file.
       *
       * Nothing loaded it before: ConfigModule's default is `<cwd>/.env`, the CLI
       * runs from apps/api, and there is no .env there — so a fresh checkout
       * could not boot without the developer exporting every variable by hand,
       * and the failure surfaced as a Prisma "database does not exist" rather
       * than anything mentioning configuration.
       *
       * Both paths are listed so it works whether the process is started from
       * apps/api (`pnpm dev`) or from the monorepo root (`turbo run dev`). A
       * missing file is not an error — in production the platform supplies the
       * environment and no .env exists at all.
       */
      envFilePath: [
        path.resolve(process.cwd(), '.env'),
        path.resolve(process.cwd(), '../../.env'),
      ],
      // Infrastructure only. No provider key is required at boot.
      validate: validateEnv,
      cache: true,
    }),

    /**
     * Four throttle tiers, protecting four different things. The definitions live
     * in common/throttle-tiers.ts alongside the skip helpers, because a skip set
     * that omits a tier silently leaves that tier active — so the tier list and
     * the skip builders must be derived from one another, not maintained apart.
     *
     * The in-memory store is per-instance, so a multi-replica deployment needs a
     * Redis ThrottlerStorage. Noted rather than built.
     */
    ThrottlerModule.forRoot({ throttlers: [...TIERS] }),

    PrismaModule,
    SettingsModule,
    AiModule,
    PromptsModule,
    DiagnosisModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global zod validation. packages/contracts schemas validate HTTP input and
    // generate OpenAPI with no duplicated class-validator DTOs.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Order matters: the fallthrough filter is registered FIRST so the more
    // specific AIError filter takes precedence.
    {
      provide: APP_FILTER,
      useFactory: (host: HttpAdapterHost) => new AllExceptionsFilter(host),
      inject: [HttpAdapterHost],
    },
    {
      provide: APP_FILTER,
      useFactory: (host: HttpAdapterHost) => new AIErrorFilter(host),
      inject: [HttpAdapterHost],
    },
  ],
})
export class AppModule {}
