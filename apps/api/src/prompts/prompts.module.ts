import { Module } from '@nestjs/common';
import { PromptsService } from './prompts.service.js';

@Module({ providers: [PromptsService], exports: [PromptsService] })
export class PromptsModule {}
