import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { skipAllExcept } from '../common/throttle-tiers.js';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PromptsService } from '../prompts/prompts.service.js';
import { AdminAuthGuard, type AdminRequest } from './admin-auth.guard.js';
import { AdminCsrfGuard } from './csrf.guard.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { Req } from './req.decorator.js';

class CreateDraftDto extends createZodDto(
  z.object({
    label: z.string().min(1).max(40),
    changeNote: z.string().min(1).max(500),
    content: z.string().min(50).optional(),
    forkFromVersionId: z.string().min(1).optional(),
  }).strict(),
) {}

class UpdateDraftDto extends createZodDto(
  z.object({
    label: z.string().min(1).max(40).optional(),
    changeNote: z.string().min(1).max(500).optional(),
    content: z.string().min(50).optional(),
  }).strict(),
) {}

class ActivateDto extends createZodDto(
  z.object({ reason: z.string().min(1).max(500) }).strict(),
) {}

@ApiExcludeController()
// `global` only at the class level. `promptTest` (20/hour) was active here by
// omission and throttled listing and editing drafts — neither of which calls a
// model. It is opted back into on the one route that does spend a generation, the
// test-draft endpoint, which is where it was always meant to go.
@SkipThrottle(skipAllExcept('global'))
@Controller('v1/admin/prompts')
@UseGuards(AdminAuthGuard, AdminCsrfGuard)
@UseInterceptors(AuditInterceptor)
export class AdminPromptsController {
  constructor(private readonly prompts: PromptsService) {}

  @Get()
  list() {
    return this.prompts.list();
  }

  @Get('activations')
  activations() {
    return this.prompts.activations();
  }

  @Post()
  create(@Body() dto: CreateDraftDto, @Req() request: AdminRequest) {
    return this.prompts.createDraft({
      label: dto.label,
      changeNote: dto.changeNote,
      ...(dto.content !== undefined ? { content: dto.content } : {}),
      ...(dto.forkFromVersionId !== undefined
        ? { forkFromVersionId: dto.forkFromVersionId }
        : {}),
      actor: request.adminSession?.email ?? 'unknown',
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDraftDto) {
    return this.prompts.updateDraft(id, dto);
  }

  @Post(':id/activate')
  activate(
    @Param('id') id: string,
    @Body() dto: ActivateDto,
    @Req() request: AdminRequest,
  ) {
    return this.prompts.activate(id, request.adminSession?.email ?? 'unknown', dto.reason);
  }
}
