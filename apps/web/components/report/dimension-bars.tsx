'use client';

import { useState } from 'react';
import { DIMENSIONS, type Dimension } from '@cbd/contracts';
import { Meter } from './score-meter';

/**
 * The five dimension scores.
 *
 * Form: horizontal bars. Magnitude across long-named categories, so horizontal
 * rather than columns — the labels read straight across instead of turning.
 *
 * Colour: every bar takes the SAME hue. The dimensions are nominal — swapping
 * CONSTRAINTS and SUCCESS_METRICS would not change the meaning — so per the
 * colour formula they are not a categorical palette and must not be coloured by
 * value. Colouring nominal bars by their value spends the identity channel
 * re-encoding what length already shows, and here it would also give a low score
 * a "bad" colour, which is the one thing this report must never do.
 *
 * One series, so no legend box: the section heading names it.
 */

export interface DimensionRow {
  dimension: Dimension;
  score: number;
  rationale: string;
  gaps: string[];
  evidence: string[];
}

export const DIMENSION_LABEL: Record<Dimension, string> = {
  OBJECTIVE_CLARITY: 'Objective clarity',
  AUDIENCE_SPECIFICITY: 'Audience specificity',
  MESSAGE_SUBSTANCE: 'Message substance',
  CONSTRAINTS: 'Constraints',
  SUCCESS_METRICS: 'Success metrics',
};

const DIMENSION_BLURB: Record<Dimension, string> = {
  OBJECTIVE_CLARITY: 'What the work is for, and what should change because of it',
  AUDIENCE_SPECIFICITY: 'Who this is for, in enough detail to make a creative decision',
  MESSAGE_SUBSTANCE: 'Whether there is something to actually say',
  CONSTRAINTS: 'The real boundaries the work has to live inside',
  SUCCESS_METRICS: 'How anyone will know whether this worked',
};

export function DimensionBars({ rows }: { rows: DimensionRow[] }) {
  const byDimension = new Map(rows.map((r) => [r.dimension, r]));
  // Contract order, always — never sorted by score. A stable running order lets
  // someone compare two reports side by side.
  const ordered = DIMENSIONS.map((d) => byDimension.get(d)).filter(
    (r): r is DimensionRow => r !== undefined,
  );

  return (
    <div className="flex flex-col divide-y">
      {ordered.map((row) => (
        <DimensionRowView key={row.dimension} row={row} />
      ))}
    </div>
  );
}

function DimensionRowView({ row }: { row: DimensionRow }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const hasDetail = row.gaps.length > 0 || row.evidence.length > 0;

  return (
    <section className="flex flex-col gap-4 py-6 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-foreground text-base font-medium tracking-tight">
              {DIMENSION_LABEL[row.dimension]}
            </h3>
            <p className="text-muted-foreground text-sm text-pretty">
              {DIMENSION_BLURB[row.dimension]}
            </p>
          </div>
          {/* Direct label. Value text wears an ink token, never the mark colour. */}
          <span className="text-foreground shrink-0 text-lg font-semibold tabular-nums">
            {row.score}
          </span>
        </div>

        <Meter
          value={row.score}
          label={`${DIMENSION_LABEL[row.dimension]}: ${row.score} out of 100`}
          height="h-2"
          variant="bar"
        />
      </div>

      <p className="text-foreground/90 text-[0.9375rem]/relaxed text-pretty">
        {row.rationale}
      </p>

      {row.gaps.length > 0 && (
        <ul className="flex flex-col gap-2">
          {row.gaps.map((gap) => (
            <li
              key={gap}
              className="text-muted-foreground flex gap-2.5 text-[0.9375rem]/relaxed"
            >
              <span
                aria-hidden="true"
                className="bg-viz-muted/60 mt-[0.6em] size-1 shrink-0 rounded-full"
              />
              <span className="text-pretty">{gap}</span>
            </li>
          ))}
        </ul>
      )}

      {hasDetail && row.evidence.length > 0 && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            aria-expanded={showEvidence}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mx-1 w-fit rounded-md px-1 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:outline-none"
          >
            {showEvidence ? 'Hide' : 'Show'} what this is based on
            <span className="text-viz-muted ml-1.5 tabular-nums">
              ({row.evidence.length})
            </span>
          </button>

          {showEvidence && (
            <ul className="flex flex-col gap-2.5">
              {row.evidence.map((quote, i) => (
                <li
                  key={`${row.dimension}-${i}`}
                  className="border-viz-track text-muted-foreground border-l-2 pl-4 text-[0.9375rem]/relaxed"
                >
                  {/* Verbatim from the brief. This is what makes a score
                      defensible to someone who disputes it. */}
                  <q className="text-pretty italic">{quote}</q>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
