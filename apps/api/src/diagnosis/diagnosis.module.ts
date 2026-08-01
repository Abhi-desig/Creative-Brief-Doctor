import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PromptsModule } from '../prompts/prompts.module.js';
import { DiagnosisController } from './diagnosis.controller.js';
import { QuotaController } from './quota.controller.js';
import { ExamplesController } from './examples.controller.js';
import { DiagnosisService } from './diagnosis.service.js';

@Module({
  imports: [AiModule, PromptsModule],
  controllers: [DiagnosisController, QuotaController, ExamplesController],
  providers: [DiagnosisService],
  exports: [DiagnosisService],
})
export class DiagnosisModule {}
