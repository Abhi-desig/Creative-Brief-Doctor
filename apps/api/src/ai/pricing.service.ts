import { Injectable, Logger } from '@nestjs/common';
import type { NormalizedUsage } from '@cbd/ai';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Turns token counts into money.
 *
 * `ModelPricing` was defined, migrated, seeded and truncated by the test harness,
 * and read by absolutely nothing — `costUsd` was the literal `null` at the one
 * call site, and the admin panel's `spendUsd` could therefore never be anything
 * else. The engine's `mergeUsage` carefully accumulates tokens across a repair
 * round trip "so the cost figure is honest" for a figure that was never computed.
 * This is the missing half.
 *
 * Three rules, each of which is a way this gets silently wrong:
 *
 *   1. NO PRICE ROW MEANS `null`, NEVER `0`. Gemini's free tier genuinely has no
 *      price table, so absence is the correct and expected state — not an error,
 *      but also not "this cost nothing". A zero is indistinguishable from a real
 *      free call and quietly understates spend the moment a paid model is added.
 *   2. `Decimal` end to end, never float. These are fractions of a cent
 *      multiplied by six-figure token counts; binary floating point turns a
 *      per-million-token rate into a long tail of rounding error, and the numbers
 *      are stored in a `Decimal(12,6)` column anyway.
 *   3. Cached input is priced separately AND deducted from fresh input. See the
 *      convention on `NormalizedUsage.inputTokens`: cached reads are a SUBSET of
 *      the input count, so billing the whole figure at the fresh rate and the
 *      cached figure again at the cached rate double-charges the cached portion.
 */

const TOKENS_PER_MILLION = new Prisma.Decimal(1_000_000);

export interface PriceBreakdown {
  /** null when no price row covers this model. */
  totalUsd: Prisma.Decimal | null;
  freshInputUsd: Prisma.Decimal;
  cachedReadUsd: Prisma.Decimal;
  cacheWriteUsd: Prisma.Decimal;
  outputUsd: Prisma.Decimal;
  /** Which price row was used, for the admin panel's "as of" line. */
  effectiveFrom: Date | null;
  currency: string | null;
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The cost of one call, or `null` if this model has no price row.
   *
   * @param at The moment to price at — the row with the newest `effectiveFrom`
   *   at or before this. Defaults to now. Passing the diagnosis's own timestamp
   *   would let a historical run be re-priced at the rate that applied then.
   */
  async costOf(
    provider: 'GOOGLE' | 'ANTHROPIC',
    model: string,
    usage: NormalizedUsage,
    at: Date = new Date(),
  ): Promise<Prisma.Decimal | null> {
    return (await this.breakdown(provider, model, usage, at)).totalUsd;
  }

  /** The same calculation, itemised. The admin cost card shows the parts. */
  async breakdown(
    provider: 'GOOGLE' | 'ANTHROPIC',
    model: string,
    usage: NormalizedUsage,
    at: Date = new Date(),
  ): Promise<PriceBreakdown> {
    const zero = new Prisma.Decimal(0);
    const empty: PriceBreakdown = {
      totalUsd: null,
      freshInputUsd: zero,
      cachedReadUsd: zero,
      cacheWriteUsd: zero,
      outputUsd: zero,
      effectiveFrom: null,
      currency: null,
    };

    const price = await this.prisma.modelPricing.findFirst({
      where: { provider, model, effectiveFrom: { lte: at } },
      // Newest rate that had taken effect. A future-dated row is deliberately
      // invisible until it applies, so prices can be loaded ahead of a change.
      orderBy: { effectiveFrom: 'desc' },
    });

    if (!price) {
      this.logger.debug(`No price row for ${provider}/${model}; cost reported as null.`);
      return empty;
    }

    /**
     * Cached reads are a subset of `inputTokens`, so the freshly-processed
     * portion is the difference. Clamped at zero: a provider reporting more
     * cached tokens than input tokens is incoherent, and a negative cost is worse
     * than a slightly wrong one.
     */
    const cachedRead = new Prisma.Decimal(Math.max(0, usage.cachedReadTokens));
    const freshInput = new Prisma.Decimal(
      Math.max(0, usage.inputTokens - usage.cachedReadTokens),
    );
    const cacheWrite = new Prisma.Decimal(Math.max(0, usage.cachedWriteTokens));

    /**
     * Reasoning tokens are billed as output. The port guarantees they are NOT
     * already inside `outputTokens`, so they are added rather than assumed —
     * omitting them would under-report the cost of every thinking-enabled call,
     * which on a reasoning model is most of the bill.
     */
    const output = new Prisma.Decimal(
      Math.max(0, usage.outputTokens) + Math.max(0, usage.reasoningTokens),
    );

    const perMillion = (tokens: Prisma.Decimal, rate: Prisma.Decimal | null): Prisma.Decimal =>
      rate === null ? zero : tokens.mul(rate).div(TOKENS_PER_MILLION);

    /**
     * A null cached-read rate falls back to the FRESH rate rather than to zero.
     * "This vendor does not discount cache reads" and "cache reads are free" are
     * different claims, and only one of them can be inferred from a missing
     * column. Charging full price is the conservative reading.
     */
    const freshInputUsd = perMillion(freshInput, price.inputPerMTok);
    const cachedReadUsd = perMillion(cachedRead, price.cachedReadPerMTok ?? price.inputPerMTok);
    // A null cache-WRITE rate does mean free: vendors that charge for cache
    // writes always publish the rate, and Gemini's implicit caching gives no
    // write signal at all (the adapter reports 0).
    const cacheWriteUsd = perMillion(cacheWrite, price.cacheWritePerMTok);
    const outputUsd = perMillion(output, price.outputPerMTok);

    return {
      totalUsd: freshInputUsd.add(cachedReadUsd).add(cacheWriteUsd).add(outputUsd),
      freshInputUsd,
      cachedReadUsd,
      cacheWriteUsd,
      outputUsd,
      effectiveFrom: price.effectiveFrom,
      currency: price.currency,
    };
  }
}
