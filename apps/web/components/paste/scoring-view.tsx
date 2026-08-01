'use client';

import { ReportSkeleton } from '@/components/report/report-skeleton';
import { ScoringProgress, type Phase } from './scoring-progress';

/**
 * What the page shows while a brief is being scored.
 *
 * Replaces a spinner and three dots. Scoring takes a measured mean of 22 seconds
 * and up to 33 in the worst case, and for all of it the page previously showed no
 * indication of what was coming — then hard-navigated to a report the reader had
 * never seen the shape of. That gap was the single largest premium-feel deficit in
 * the product.
 *
 * The skeleton is the REPORT'S OWN SHAPE — score meter, summary, five dimensions,
 * questions — so the wait is spent looking at the thing that is about to arrive,
 * and the eventual navigation is a fill rather than a jump.
 *
 * The final `router.push` is deliberately kept. This is a preview of the artefact,
 * not the artefact: the canonical report is server-rendered so that what the
 * author ends up looking at is byte-identical to what a stakeholder opening the
 * link sees. Rendering the real result here instead would create two code paths
 * for one document, and the one the author saw would be the one nobody tested.
 */
export function ScoringView({ phase, title }: { phase: Phase; title: string }) {
  return (
    <section
      className="flex flex-col gap-8"
      // The whole region is a live status: a screen reader user gets the phase
      // changes without the skeleton being announced as content.
      aria-busy="true"
      aria-live="polite"
    >
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm font-medium">Scoring</p>
          <h2 className="report-h1 text-balance">{title}</h2>
        </div>
        <ScoringProgress phase={phase} />
        <p className="text-viz-muted text-sm">
          Usually about twenty seconds. The report opens on its own when it is
          ready — nothing is lost if you switch tabs.
        </p>
      </header>

      {/* aria-hidden on the skeleton itself, inside ReportSkeleton, so the live
          region announces the phase and not a wall of empty placeholders. */}
      <ReportSkeleton />
    </section>
  );
}
