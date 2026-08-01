import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { skipAllExcept } from '../common/throttle-tiers.js';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PromptsService } from '../prompts/prompts.service.js';
import { PromptTestService } from '../prompts/prompt-test.service.js';
import { MAX_BRIEF_CHARS } from '../diagnosis/diagnosis.service.js';
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

class TestDraftDto extends createZodDto(
  z.object({
    // The same floor and ceiling the public endpoint enforces, so a draft is
    // never validated against a brief the real path would have rejected.
    briefText: z.string().min(40).max(MAX_BRIEF_CHARS),
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
  constructor(
    private readonly prompts: PromptsService,
    private readonly promptTest: PromptTestService,
  ) {}

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

  /**
   * Run a version against one brief without activating it.
   *
   * The only route on this controller that spends a generation, and therefore the
   * only one the `promptTest` tier should ever have governed — it was previously
   * applied to every read on here by omission and to this, the route it was named
   * for, not at all. Opted back in explicitly, because the class-level skip would
   * otherwise win.
   *
   * `@HttpCode(200)`: this returns a result to read, it does not create a resource
   * the caller will address. The `PromptTestRun` row is bookkeeping.
   */
  @Post(':id/test')
  @SkipThrottle({ promptTest: false })
  @Throttle({ promptTest: { limit: 20, ttl: 60 * 60 * 1000 } })
  @HttpCode(200)
  test(
    @Param('id') id: string,
    @Body() dto: TestDraftDto,
    @Req() request: AdminRequest,
  ) {
    return this.promptTest.testDraft({
      versionId: id,
      briefText: dto.briefText,
      actor: request.adminSession?.email ?? 'unknown',
    });
  }

  /** Recent runs for a version, for the history panel under the editor. */
  @Get(':id/test-runs')
  testRuns(@Param('id') id: string) {
    return this.promptTest.history(id);
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
