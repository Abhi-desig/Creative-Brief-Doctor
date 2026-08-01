import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService, hashContent } from '../settings/settings.service.js';
import type { PromptSnapshot } from '../diagnosis/scoring/engine.js';

/**
 * Prompt version lifecycle.
 *
 *   DRAFT --edit--> DRAFT --activate--> ACTIVE --(new activation)--> ARCHIVED
 *
 * Three rules are enforced by the DATABASE, not here, and this service is
 * written on the assumption that its own checks can be bypassed:
 *
 *   - exactly one ACTIVE per template  (partial unique index)
 *   - non-draft content is immutable   (BEFORE UPDATE trigger)
 *   - one AppSetting row               (CHECK constraint)
 *
 * So `activate` does not SELECT-then-UPDATE and hope. It archives the incumbent
 * and promotes the new version inside one transaction, and lets the unique index
 * decide the winner when two requests race. A P2002 from that index is a lost
 * race, not a bug.
 */

const UNIQUE_VIOLATION = 'P2002';
const CHECK_VIOLATION_PATTERNS = [/immutable/i, /check constraint/i];

@Injectable()
export class PromptsService {
  private readonly logger = new Logger(PromptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async list(templateKey = 'rubric') {
    const template = await this.prisma.promptTemplate.findUnique({
      where: { key: templateKey },
      include: {
        versions: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            label: true,
            contentHash: true,
            status: true,
            changeNote: true,
            createdBy: true,
            createdAt: true,
            activatedAt: true,
            activatedBy: true,
          },
        },
      },
    });
    if (!template) throw new NotFoundException(`No prompt template "${templateKey}".`);
    return template;
  }

  /** The active version, as the immutable snapshot the engine consumes. */
  async activeSnapshot(templateKey = 'rubric'): Promise<PromptSnapshot> {
    const version = await this.prisma.promptVersion.findFirst({
      where: { status: 'ACTIVE', template: { key: templateKey } },
      select: { id: true, label: true, content: true, contentHash: true },
    });
    if (!version) {
      throw new BadRequestException({
        code: 'NO_ACTIVE_PROMPT_VERSION',
        message: `Template "${templateKey}" has no active version.`,
      });
    }

    // Verified on every read, not only at boot. Cheap, and it means a diagnosis
    // can never be attributed to content that has since changed underneath it.
    const computed = hashContent(version.content);
    if (computed !== version.contentHash) {
      throw new BadRequestException({
        code: 'PROMPT_HASH_MISMATCH',
        message:
          'The active prompt version\'s content does not match its stored hash. '
          + 'Refusing to score until this is resolved.',
      });
    }

    return {
      promptVersionId: version.id,
      content: version.content,
      contentHash: version.contentHash,
      label: version.label,
    };
  }

  /**
   * Editing a non-draft forks a new DRAFT seeded from it. The service never
   * attempts an in-place update of a non-draft — the trigger would refuse — so
   * the fork is the only path, by construction.
   */
  async createDraft(input: {
    templateKey?: string;
    forkFromVersionId?: string;
    content?: string;
    label: string;
    changeNote: string;
    actor: string;
  }) {
    const templateKey = input.templateKey ?? 'rubric';
    const template = await this.prisma.promptTemplate.findUnique({ where: { key: templateKey } });
    if (!template) throw new NotFoundException(`No prompt template "${templateKey}".`);

    let content = input.content;
    if (input.forkFromVersionId) {
      const source = await this.prisma.promptVersion.findUnique({
        where: { id: input.forkFromVersionId },
        select: { content: true, templateId: true },
      });
      if (!source) throw new NotFoundException('Source version not found.');
      if (source.templateId !== template.id) {
        throw new BadRequestException('Cannot fork across templates.');
      }
      content ??= source.content;
    }
    if (!content) {
      throw new BadRequestException('Provide either content or forkFromVersionId.');
    }

    try {
      return await this.prisma.promptVersion.create({
        data: {
          templateId: template.id,
          label: input.label,
          content,
          contentHash: hashContent(content),
          status: 'DRAFT',
          changeNote: input.changeNote,
          createdBy: input.actor,
        },
        select: { id: true, label: true, status: true, contentHash: true, createdAt: true },
      });
    } catch (error) {
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`A version labelled "${input.label}" already exists.`);
      }
      throw error;
    }
  }

  /** Editing a DRAFT in place is allowed; the trigger permits it. */
  async updateDraft(
    id: string,
    input: { content?: string | undefined; changeNote?: string | undefined; label?: string | undefined },
  ) {
    const version = await this.prisma.promptVersion.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!version) throw new NotFoundException('Version not found.');
    if (version.status !== 'DRAFT') {
      throw new BadRequestException({
        code: 'NOT_A_DRAFT',
        message:
          `This version is ${version.status} and its content is immutable. `
          + 'Fork a new draft from it instead.',
      });
    }

    const data: Record<string, unknown> = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.changeNote !== undefined) data.changeNote = input.changeNote;
    if (input.content !== undefined) {
      data.content = input.content;
      data.contentHash = hashContent(input.content);
    }

    try {
      return await this.prisma.promptVersion.update({
        where: { id },
        data,
        select: { id: true, label: true, status: true, contentHash: true },
      });
    } catch (error) {
      if (isImmutabilityViolation(error)) {
        // Reaching here means the status changed between the check and the
        // update. The trigger caught what the check could not.
        throw new BadRequestException({
          code: 'NOT_A_DRAFT',
          message: 'This version stopped being a draft while you were editing it.',
        });
      }
      throw error;
    }
  }

  /**
   * Activation is an event.
   *
   * Archive the incumbent and promote the new version in one transaction. The
   * partial unique index is what makes concurrent activation safe: two racing
   * transactions cannot both leave an ACTIVE row, and the loser gets P2002.
   *
   * No path leaves a template with no active version, because the promotion and
   * the archival happen together or not at all.
   */
  async activate(id: string, actor: string, reason: string) {
    const version = await this.prisma.promptVersion.findUnique({
      where: { id },
      select: { id: true, templateId: true, status: true, content: true, contentHash: true },
    });
    if (!version) throw new NotFoundException('Version not found.');
    if (version.status === 'ACTIVE') {
      throw new BadRequestException('That version is already active.');
    }
    if (hashContent(version.content) !== version.contentHash) {
      throw new BadRequestException({
        code: 'PROMPT_HASH_MISMATCH',
        message: 'Refusing to activate a version whose content does not match its hash.',
      });
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const incumbent = await tx.promptVersion.findFirst({
          where: { templateId: version.templateId, status: 'ACTIVE' },
          select: { id: true },
        });

        if (incumbent) {
          // Status-only change: the trigger allows this on a non-draft.
          await tx.promptVersion.update({
            where: { id: incumbent.id },
            data: { status: 'ARCHIVED' },
          });
        }

        const promoted = await tx.promptVersion.update({
          where: { id },
          data: {
            status: 'ACTIVE',
            activatedAt: new Date(),
            activatedBy: actor,
          },
          select: { id: true, label: true, status: true, activatedAt: true },
        });

        // Rollback is activating an older version, which creates a NEW
        // activation event rather than rewriting history.
        await tx.promptActivation.create({
          data: {
            promptVersionId: id,
            actor,
            reason,
            previousVersionId: incumbent?.id ?? null,
          },
        });

        return promoted;
      });

      this.settings.invalidate();
      return result;
    } catch (error) {
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
        // The partial unique index did the work. This is a lost race, not a bug.
        throw new ConflictException({
          code: 'CONCURRENT_ACTIVATION',
          message:
            'Another activation for this template completed first. '
            + 'Reload the version list and try again.',
        });
      }
      throw error;
    }
  }

  async activations(templateKey = 'rubric') {
    return this.prisma.promptActivation.findMany({
      where: { promptVersion: { template: { key: templateKey } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { promptVersion: { select: { label: true } } },
    });
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code: unknown }).code === code;
}

function isImmutabilityViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CHECK_VIOLATION_PATTERNS.some((pattern) => pattern.test(message));
}
