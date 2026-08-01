import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AiModule } from '../ai/ai.module.js';
import { HealthController } from './health.controller.js';
import {
  ActiveProviderHealthIndicator,
  PrismaHealthIndicator,
  PromptIntegrityHealthIndicator,
} from './health.indicators.js';

@Module({
  imports: [TerminusModule, AiModule],
  controllers: [HealthController],
  providers: [
    PrismaHealthIndicator,
    ActiveProviderHealthIndicator,
    PromptIntegrityHealthIndicator,
  ],
})
export class HealthModule {}
