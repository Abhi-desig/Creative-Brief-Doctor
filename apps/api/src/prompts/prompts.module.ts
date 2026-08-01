import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PromptsService } from './prompts.service.js';
import { PromptTestService } from './prompt-test.service.js';

/**
 * `PromptTestService` pulls in AiModule for the provider, quota and pricing it
 * needs to run a draft. PromptsService itself stays dependency-light — it only
 * touches the database — so the version CRUD is still usable in tests without an
 * AI stack.
 */
@Module({
  imports: [AiModule],
  providers: [PromptsService, PromptTestService],
  exports: [PromptsService, PromptTestService],
})
export class PromptsModule {}
