import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PromptsModule } from '../prompts/prompts.module.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminCsrfGuard } from './csrf.guard.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AdminProvidersController } from './providers.controller.js';
import { AdminPromptsController } from './prompts.controller.js';
import { AdminStatusController } from './status.controller.js';

@Module({
  imports: [AiModule, PromptsModule],
  controllers: [
    AdminAuthController,
    AdminProvidersController,
    AdminPromptsController,
    AdminStatusController,
  ],
  providers: [AdminAuthService, AdminAuthGuard, AdminCsrfGuard, AuditInterceptor],
  exports: [AdminAuthService],
})
export class AdminModule {}
