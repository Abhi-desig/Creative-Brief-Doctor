import { VERDICT_THRESHOLDS, type Verdict } from '@cbd/contracts';

/**
 * The overall score.
 *
 * Form: hero figure + meter. Per the dataviz form heuristic, a single ratio
 * against a limit is a meter, and the one number a view leads with is a hero
 * figure — not a gauge, not a donut, not a one-bar bar chart.
 *
 * Colour: ONE hue at every score. The default meter contract has the fill carry
 * severity (accent -> warning -> danger); that is deliberately not used here.
 * Severity colour would make a low score render as an error, and this report's
 * entire purpose is to be forwardable without reading as an accusation. The
 * magnitude is carried by fill LENGTH and by the number itself.
 *
 * The track is a lighter step of the same ramp, so the full 0-100 scale stays
 * visible: a score of 12 must read as "12 out of 100", not as a lonely stub.
 */

export function ScoreMeter({
  score,
  verdict,
}: {
  score: number;
  verdict: Verdict;
}) {
  const pct = Math.max(0, Math.min(100, score));
  const decision = DECISION[verdict];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="flex items-baseline gap-3">
          <span className="report-display text-foreground">{pct}</span>
          <span className="text-muted-foreground pb-2 text-lg font-medium">/ 100</span>
        </div>

        <div className="flex flex-col gap-1 pb-1">
          {/* The verdict is phrased as a decision, not a grade. */}
          <p className="text-foreground text-xl font-semibold tracking-[-0.01em]">
            {decision.headline}
          </p>
          <p className="text-muted-foreground text-sm">{decision.sub}</p>
        </div>
      </div>

      <Meter value={pct} label={`Overall score ${pct} out of 100`} />

      {/* Band boundaries, so the number sits in a scale the reader can see. */}
      <div
        className="text-viz-muted relative h-4 text-xs"
        aria-hidden="true"
      >
        {[
          { at: 0, text: '0' },
          { at: VERDICT_THRESHOLDS.NEEDS_WORK, text: String(VERDICT_THRESHOLDS.NEEDS_WORK) },
          { at: VERDICT_THRESHOLDS.READY, text: String(VERDICT_THRESHOLDS.READY) },
          { at: 100, text: '100' },
        ].map((tick) => (
          <span
            key={tick.at}
            className="absolute -translate-x-1/2 tabular-nums first:translate-x-0"
            style={{
              left: `${tick.at}%`,
              transform:
                tick.at === 0
                  ? 'none'
                  : tick.at === 100
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            {tick.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The bar itself. Rounded data-end anchored to the baseline, per the mark spec,
 * and a 2px surface gap between fill and track so the two never smear together.
 */
export function Meter({
  value,
  label,
  height = 'h-3',
  variant = 'meter',
}: {
  value: number;
  label: string;
  height?: string;
  /**
   * 'meter'  — a ratio against a limit. Same-ramp track, per the mark spec, so
   *            state reads across the whole bar.
   * 'bar'    — a bar-chart mark. NO track: a bar's zero is an absent bar against
   *            a recessive rail.
   *
   * This distinction is load-bearing, not cosmetic. Giving a bar a same-ramp
   * track makes a score of 0 render as a full-width band of the fill hue — which
   * reads as 100, the exact opposite of the value. Caught by rendering a
   * zero-score report and looking at it.
   */
  variant?: 'meter' | 'bar';
}) {
  const pct = Math.max(0, Math.min(100, value));
  const isMeter = variant === 'meter';

  return (
    <div
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`relative w-full overflow-hidden rounded-full ${height} ${
        isMeter ? 'bg-viz-track' : 'bg-viz-grid'
      }`}
    >
      {pct > 0 && (
        <div
          className="bg-viz-fill absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${pct}%`,
            // 2px surface ring so the fill end reads as an edge, not a blend.
            ...(isMeter ? { boxShadow: '0 0 0 2px var(--color-card)' } : {}),
            transition: 'width var(--dur-slow) var(--ease-out-soft)',
          }}
        />
      )}
    </div>
  );
}

/**
 * Verdict as a decision the reader can act on.
 *
 * "READY" is not "you scored well" and "NOT_READY" is not "you failed" — both
 * describe the state of the document and what happens next.
 */
const DECISION: Record<Verdict, { headline: string; sub: string }> = {
  READY: {
    headline: 'Ready to brief',
    sub: 'A team could start from this. The questions below would sharpen it.',
  },
  NEEDS_WORK: {
    headline: 'Needs input before we start',
    sub: 'Most of it is here. A few answers would unblock the work.',
  },
  NOT_READY: {
    headline: 'Needs input before we start',
    sub: 'The essentials are still open. The questions below are where to begin.',
  },
};
