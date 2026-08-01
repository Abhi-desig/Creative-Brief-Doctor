import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
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
import { AIError } from '@cbd/ai';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { KeyVaultService, fromPrismaBytes, toPrismaBytes } from '../ai/key-vault.service.js';
import { buildAdapter } from '../ai/adapter.factory.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminCsrfGuard } from './csrf.guard.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { PROVIDER_PUBLIC_SELECT } from './redact.js';

/**
 * Provider CRUD.
 *
 * The load-bearing property: **keys are write-only over HTTP.** POST and PATCH
 * accept one; no endpoint returns one. That is enforced by every read using
 * PROVIDER_PUBLIC_SELECT, which does not name the credential columns — so there
 * is no code path that could serve a key, rather than a convention that one
 * should not. There is no reveal endpoint because there is nothing to build one
 * out of.
 */

const ProviderKindSchema = z.enum(['GOOGLE', 'ANTHROPIC']);

class CreateProviderDto extends createZodDto(
  z
    .object({
      kind: ProviderKindSchema,
      label: z.string().min(1).max(80),
      baseUrl: z.string().url().optional(),
      /** Write-only. Never echoed back. */
      apiKey: z.string().min(8).max(512),
    })
    .strict(),
) {}

class UpdateProviderDto extends createZodDto(
  z
    .object({
      label: z.string().min(1).max(80).optional(),
      baseUrl: z.string().url().nullish(),
      /** Supplying this rotates the key and increments keyVersion. */
      apiKey: z.string().min(8).max(512).optional(),
      status: z.enum(['UNTESTED', 'OK', 'FAILING', 'DISABLED']).optional(),
    })
    .strict(),
) {}

class TestConnectionDto extends createZodDto(
  z.object({ model: z.string().min(1).optional() }).strict(),
) {}

@ApiExcludeController()
// `global` only. `promptTest` was left active here by omission, capping all
// provider reads and writes at 20/hour. /v1/admin/* is excluded from the public
// OpenAPI document.
@SkipThrottle(skipAllExcept('global'))
@Controller('v1/admin/providers')
@UseGuards(AdminAuthGuard, AdminCsrfGuard)
@UseInterceptors(AuditInterceptor)
export class AdminProvidersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: KeyVaultService,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  async list() {
    // No credential column is selected, so none can be returned.
    return this.prisma.aiProvider.findMany({
      select: PROVIDER_PUBLIC_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const provider = await this.prisma.aiProvider.findUnique({
      where: { id },
      select: PROVIDER_PUBLIC_SELECT,
    });
    if (!provider) throw new NotFoundException('Provider not found.');
    return provider;
  }

  @Post()
  async create(@Body() dto: CreateProviderDto) {
    // The row is created first so its id exists to bind as AAD — the ciphertext
    // is meaningless without it, which is the whole point of the binding.
    const created = await this.prisma.aiProvider.create({
      data: { kind: dto.kind, label: dto.label, baseUrl: dto.baseUrl ?? null },
      select: { id: true },
    });

    const sealed = this.vault.seal(dto.apiKey, created.id);
    const provider = await this.prisma.aiProvider.update({
      where: { id: created.id },
      data: {
        keyCiphertext: toPrismaBytes(sealed.keyCiphertext),
        keyIv: toPrismaBytes(sealed.keyIv),
        keyTag: toPrismaBytes(sealed.keyTag),
        keyLast4: sealed.keyLast4,
      },
      select: PROVIDER_PUBLIC_SELECT,
    });

    this.settings.invalidate();
    return provider;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateProviderDto) {
    const existing = await this.prisma.aiProvider.findUnique({
      where: { id },
      select: { id: true, keyVersion: true },
    });
    if (!existing) throw new NotFoundException('Provider not found.');

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.baseUrl !== undefined) data.baseUrl = dto.baseUrl;
    if (dto.status !== undefined) data.status = dto.status;

    if (dto.apiKey !== undefined) {
      // Rotation: a new key writes a new version and increments keyVersion. The
      // old ciphertext is overwritten, not archived — an archived credential is
      // a credential someone can still steal.
      const sealed = this.vault.seal(dto.apiKey, id);
      data.keyCiphertext = toPrismaBytes(sealed.keyCiphertext);
      data.keyIv = toPrismaBytes(sealed.keyIv);
      data.keyTag = toPrismaBytes(sealed.keyTag);
      data.keyLast4 = sealed.keyLast4;
      data.keyVersion = existing.keyVersion + 1;
      data.status = 'UNTESTED';
    }

    const provider = await this.prisma.aiProvider.update({
      where: { id },
      data,
      select: PROVIDER_PUBLIC_SELECT,
    });
    this.settings.invalidate();
    return provider;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    const setting = await this.prisma.appSetting.findUnique({
      where: { id: 'singleton' },
      select: { activeProviderId: true },
    });
    if (setting?.activeProviderId === id) {
      throw new BadRequestException(
        'This provider is currently active. Select a different provider first.',
      );
    }
    await this.prisma.aiProvider.delete({ where: { id } });
    this.settings.invalidate();
  }

  /**
   * Test connection: calls `ping()` and reports latency and the resolved model
   * list. This is how a bad key is discovered immediately rather than through a
   * failed diagnosis hours later.
   */
  @Post(':id/test-connection')
  async testConnection(@Param('id') id: string, @Body() dto: TestConnectionDto) {
    const row = await this.prisma.aiProvider.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Provider not found.');
    if (!row.keyCiphertext) throw new BadRequestException('This provider has no API key stored.');

    const startedAt = Date.now();
    try {
      const apiKey = this.vault.open(
        {
          keyCiphertext: fromPrismaBytes(row.keyCiphertext),
          keyIv: fromPrismaBytes(row.keyIv),
          keyTag: fromPrismaBytes(row.keyTag),
          ...(row.keyLast4 ? { keyLast4: row.keyLast4 } : {}),
        },
        row.id,
      );

      const adapter = buildAdapter({
        kind: row.kind,
        apiKey,
        baseUrl: row.baseUrl ?? undefined,
      });
      const result = await adapter.ping();
      const latencyMs = Date.now() - startedAt;

      await this.prisma.aiProvider.update({
        where: { id },
        data: { status: result.ok ? 'OK' : 'FAILING', lastPingAt: new Date(), lastPingMs: latencyMs },
      });
      this.settings.invalidate();

      return {
        ok: result.ok,
        latencyMs,
        // The resolved model list. Note a model appearing here is not proof it
        // is callable — retired models keep being listed and then 404.
        models: (result.models ?? []).map((m) => ({ id: m.id, displayName: m.displayName })),
        capabilities: adapter.capabilities,
        selectedModel: dto.model ?? null,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      await this.prisma.aiProvider.update({
        where: { id },
        data: { status: 'FAILING', lastPingAt: new Date(), lastPingMs: latencyMs },
      });
      this.settings.invalidate();

      // The reason is surfaced to the admin — this is the one place a provider
      // failure is useful to a human — but never the credential itself.
      return {
        ok: false,
        latencyMs,
        models: [],
        error: AIError.is(error) ? { kind: error.kind, message: error.message } : {
          kind: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
