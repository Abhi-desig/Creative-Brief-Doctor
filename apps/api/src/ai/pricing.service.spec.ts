import { describe, expect, it } from 'vitest';
import type { NormalizedUsage } from '@cbd/ai';
import { Prisma } from '../generated/prisma/client.js';
import { PricingService } from './pricing.service.js';

/**
 * Priced against a stub rather than a database: the arithmetic is the thing under
 * test, and a real Postgres round trip would make these slow without testing any
 * more of the calculation.
 */
function serviceWith(rows: unknown[]): PricingService {
  const prisma = {
    modelPricing: {
      findFirst: ({ where, orderBy }: {
        where: { provider: string; model: string; effectiveFrom: { lte: Date } };
        orderBy: { effectiveFrom: 'desc' };
      }) => {
        const matching = (rows as {
          provider: string; model: string; effectiveFrom: Date;
        }[])
          .filter((r) => r.provider === where.provider && r.model === where.model)
          .filter((r) => r.effectiveFrom <= where.effectiveFrom.lte)
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
        void orderBy;
        return Promise.resolve(matching[0] ?? null);
      },
    },
  };
  return new PricingService(prisma as never);
}

const d = (n: number | string) => new Prisma.Decimal(n);

/** $5 per million in, $25 per million out, cache reads at a tenth of input. */
const OPUS_ROW = {
  provider: 'ANTHROPIC',
  model: 'claude-opus-5',
  inputPerMTok: d(5),
  outputPerMTok: d(25),
  cachedReadPerMTok: d('0.5'),
  cacheWritePerMTok: d('6.25'),
  currency: 'USD',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
};

const usage = (over: Partial<NormalizedUsage> = {}): NormalizedUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  reasoningTokens: 0,
  tokenSource: 'native',
  ...over,
});

describe('PricingService', () => {
  describe('a known row and known usage', () => {
    it('prices input and output at the published per-million rates', async () => {
      const service = serviceWith([OPUS_ROW]);
      const cost = await service.costOf(
        'ANTHROPIC',
        'claude-opus-5',
        usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      );
      // 1M in at $5 + 1M out at $25.
      expect(cost?.toString()).toBe('30');
    });

    it('handles fractional token counts without floating point drift', async () => {
      const service = serviceWith([OPUS_ROW]);
      const cost = await service.costOf(
        'ANTHROPIC',
        'claude-opus-5',
        usage({ inputTokens: 12_345, outputTokens: 6_789 }),
      );
      // 12345/1e6*5 = 0.061725 ; 6789/1e6*25 = 0.169725 ; total 0.23145
      expect(cost?.toString()).toBe('0.23145');
      // The float version of this sum is 0.23144999999999998.
      expect(cost?.equals(d('0.23145'))).toBe(true);
    });
  });

  describe('cached versus fresh input', () => {
    it('deducts cached reads from fresh input rather than billing both in full', async () => {
      const service = serviceWith([OPUS_ROW]);
      const breakdown = await service.breakdown(
        'ANTHROPIC',
        'claude-opus-5',
        // Cached reads are a SUBSET of inputTokens: 100k total, 80k of it cached.
        usage({ inputTokens: 100_000, cachedReadTokens: 80_000 }),
      );

      // 20k fresh at $5/M = 0.10 ; 80k cached at $0.50/M = 0.04
      expect(breakdown.freshInputUsd.toString()).toBe('0.1');
      expect(breakdown.cachedReadUsd.toString()).toBe('0.04');
      expect(breakdown.totalUsd?.toString()).toBe('0.14');

      // Guard against the regression this rule exists for: billing the full input
      // figure at the fresh rate AND the cached figure again would give 0.54.
      expect(breakdown.totalUsd?.equals(d('0.54'))).toBe(false);
    });

    it('is cheaper with caching than without, for identical total input', async () => {
      const service = serviceWith([OPUS_ROW]);
      const cold = await service.costOf(
        'ANTHROPIC', 'claude-opus-5', usage({ inputTokens: 100_000 }),
      );
      const warm = await service.costOf(
        'ANTHROPIC', 'claude-opus-5',
        usage({ inputTokens: 100_000, cachedReadTokens: 80_000 }),
      );
      expect(warm!.lessThan(cold!)).toBe(true);
    });

    it('charges cache writes at their own rate', async () => {
      const service = serviceWith([OPUS_ROW]);
      const breakdown = await service.breakdown(
        'ANTHROPIC', 'claude-opus-5', usage({ cachedWriteTokens: 1_000_000 }),
      );
      expect(breakdown.cacheWriteUsd.toString()).toBe('6.25');
    });

    it('falls back to the FRESH rate when no cached-read rate is published', async () => {
      // "Not discounted" and "free" are different claims; only the conservative
      // one can be inferred from a missing column.
      const service = serviceWith([{ ...OPUS_ROW, cachedReadPerMTok: null }]);
      const breakdown = await service.breakdown(
        'ANTHROPIC', 'claude-opus-5',
        usage({ inputTokens: 100_000, cachedReadTokens: 80_000 }),
      );
      expect(breakdown.cachedReadUsd.toString()).toBe('0.4'); // 80k at $5/M
      expect(breakdown.totalUsd?.toString()).toBe('0.5');
    });

    it('treats a missing cache-write rate as free', async () => {
      const service = serviceWith([{ ...OPUS_ROW, cacheWritePerMTok: null }]);
      const breakdown = await service.breakdown(
        'ANTHROPIC', 'claude-opus-5', usage({ cachedWriteTokens: 1_000_000 }),
      );
      expect(breakdown.cacheWriteUsd.toString()).toBe('0');
    });

    it('clamps incoherent usage where cached exceeds total input', async () => {
      const service = serviceWith([OPUS_ROW]);
      const breakdown = await service.breakdown(
        'ANTHROPIC', 'claude-opus-5',
        usage({ inputTokens: 1_000, cachedReadTokens: 5_000 }),
      );
      // Never negative: a wrong-but-positive figure beats a negative cost.
      expect(breakdown.freshInputUsd.toString()).toBe('0');
      expect(breakdown.totalUsd?.isNegative()).toBe(false);
    });
  });

  describe('reasoning tokens', () => {
    it('bills them as output, on top of outputTokens', async () => {
      const service = serviceWith([OPUS_ROW]);
      const breakdown = await service.breakdown(
        'ANTHROPIC', 'claude-opus-5',
        // The port guarantees reasoning is NOT already inside outputTokens.
        usage({ outputTokens: 1_000_000, reasoningTokens: 1_000_000 }),
      );
      expect(breakdown.outputUsd.toString()).toBe('50');
    });
  });

  describe('no price row', () => {
    it('returns null, never zero', async () => {
      const service = serviceWith([]);
      const cost = await service.costOf(
        'GOOGLE', 'gemini-2.5-flash',
        usage({ inputTokens: 500_000, outputTokens: 500_000 }),
      );
      // The distinction that matters: `null` renders as "not configured", `0`
      // renders as "this was free" and silently understates spend.
      expect(cost).toBeNull();
      expect(cost).not.toBe(0);
    });

    it('returns null for a different model on a priced provider', async () => {
      const service = serviceWith([OPUS_ROW]);
      const cost = await service.costOf(
        'ANTHROPIC', 'claude-some-other-model', usage({ inputTokens: 1_000 }),
      );
      expect(cost).toBeNull();
    });

    it('reports null total but zeroed parts in the breakdown', async () => {
      const service = serviceWith([]);
      const breakdown = await service.breakdown(
        'GOOGLE', 'gemini-2.5-flash', usage({ inputTokens: 1_000 }),
      );
      expect(breakdown.totalUsd).toBeNull();
      expect(breakdown.currency).toBeNull();
      expect(breakdown.effectiveFrom).toBeNull();
    });
  });

  describe('effective dating', () => {
    const OLD = { ...OPUS_ROW, inputPerMTok: d(10), effectiveFrom: new Date('2026-01-01Z') };
    const NEW = { ...OPUS_ROW, inputPerMTok: d(5), effectiveFrom: new Date('2026-06-01Z') };

    it('uses the newest rate at or before the given moment', async () => {
      const service = serviceWith([OLD, NEW]);
      const cost = await service.costOf(
        'ANTHROPIC', 'claude-opus-5', usage({ inputTokens: 1_000_000 }),
        new Date('2026-08-01Z'),
      );
      expect(cost?.toString()).toBe('5');
    });

    it('prices a historical call at the rate that applied then', async () => {
      const service = serviceWith([OLD, NEW]);
      const cost = await service.costOf(
        'ANTHROPIC', 'claude-opus-5', usage({ inputTokens: 1_000_000 }),
        new Date('2026-03-01Z'),
      );
      expect(cost?.toString()).toBe('10');
    });

    it('ignores a future-dated row so prices can be loaded ahead of a change', async () => {
      const service = serviceWith([OLD, NEW]);
      const cost = await service.costOf(
        'ANTHROPIC', 'claude-opus-5', usage({ inputTokens: 1_000_000 }),
        new Date('2026-02-01Z'),
      );
      expect(cost?.toString()).toBe('10');
    });

    it('returns null before any row takes effect', async () => {
      const service = serviceWith([NEW]);
      const cost = await service.costOf(
        'ANTHROPIC', 'claude-opus-5', usage({ inputTokens: 1_000_000 }),
        new Date('2025-12-01Z'),
      );
      expect(cost).toBeNull();
    });
  });

  it('costs nothing for a call that used no tokens', async () => {
    const service = serviceWith([OPUS_ROW]);
    const cost = await service.costOf('ANTHROPIC', 'claude-opus-5', usage());
    // Zero here is correct and distinguishable from null: a row EXISTS.
    expect(cost?.toString()).toBe('0');
  });
});
