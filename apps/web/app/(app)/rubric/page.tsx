import type { Metadata } from 'next';
import {
  DIMENSION_ANCHORS,
  SCORE_ANCHORS,
  VERDICT_THRESHOLDS,
} from '@cbd/contracts';

/**
 * The scoring standard, as a document.
 *
 * Indexable, unlike every `/d/*` report. This is the page that answers "by what
 * standard?" for a stakeholder who wants to argue with a score — and giving that
 * argument a legitimate place to happen is the point. The report links here from
 * its provenance line for exactly that reason.
 *
 * Rendered from `DIMENSION_ANCHORS`, the same data the sidebar uses, which a drift
 * test holds byte-identical to the prompt the model actually receives. So this
 * page cannot describe a rubric that differs from the one being applied.
 */

export const metadata: Metadata = {
  title: 'The rubric',
  description:
    'How a brief is scored: five dimensions, six anchors each, and how the '
    + 'overall score and verdict are derived.',
};

function withEmphasis(text: string): React.ReactNode {
  const parts = text.split(/(\*[^*]+\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.startsWith('*') && part.endsWith('*') && part.length > 2 ? (
      <em key={i}>{part.slice(1, -1)}</em>
    ) : (
      part
    ),
  );
}

export default function RubricPage() {
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-5 py-16 sm:px-8 sm:py-24">
      <header className="flex flex-col gap-5">
        <p className="text-muted-foreground text-sm font-medium">Rubric v1</p>
        <h1 className="report-h1 text-balance">How a brief is scored</h1>
        <p className="report-lede max-w-2xl">
          Five dimensions, scored independently against a fixed ladder. Only what
          the brief actually says is scored — not intent that can be inferred, not
          context the team already shares, and not information that is probably
          true but is not written down.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="report-h2">The ladder</h2>
        <p className="text-muted-foreground text-pretty">
          Every dimension uses the same six rungs:{' '}
          <span className="text-foreground tabular-nums">
            {SCORE_ANCHORS.join(', ')}
          </span>
          . Nothing in between. A brief that meets every clause of one anchor and
          part of the next scores the lower one — the anchor it has fully met.
          From 40 upward each rung assumes everything below it is also present, so
          a brief missing something lower scores at the lower level.
        </p>
      </section>

      {DIMENSION_ANCHORS.map(({ dimension, label, subtitle, anchors }) => (
        <section key={dimension} className="flex flex-col gap-5">
          <header className="flex flex-col gap-1.5">
            <h2 className="report-h2">{label}</h2>
            <p className="text-muted-foreground text-pretty">{subtitle}</p>
          </header>

          <dl className="flex flex-col">
            {anchors.map((anchor, i) => (
              <div
                key={anchor.score}
                className={`grid grid-cols-[2.5rem_1fr] gap-x-4 py-3 sm:grid-cols-[3.5rem_1fr] ${
                  i > 0 ? 'border-border border-t' : ''
                }`}
              >
                {/* Never coloured. A 0 is a rung on a scale, not an error — the
                    report is careful about this and the standard must be too. */}
                <dt className="text-viz-muted pt-0.5 text-sm tabular-nums">
                  {anchor.score}
                </dt>
                <dd className="text-pretty">{withEmphasis(anchor.text)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <section className="flex flex-col gap-4">
        <h2 className="report-h2">The overall score</h2>
        <p className="text-muted-foreground text-pretty">
          The mean of the five dimension scores, rounded. It is computed from the
          five scores after the fact — the model that reads the brief is explicitly
          forbidden from producing a total, a percentage, a grade or a verdict, so
          the number cannot be talked up or down in the same pass that assigns the
          dimensions.
        </p>

        <dl className="flex flex-col">
          {[
            {
              verdict: 'Ready to brief',
              range: `${VERDICT_THRESHOLDS.READY} and above`,
              gloss: 'A creative team could start on this as written.',
            },
            {
              verdict: 'Needs work',
              range: `${VERDICT_THRESHOLDS.NEEDS_WORK}–${VERDICT_THRESHOLDS.READY - 1}`,
              gloss:
                'Workable, but a team would stop to ask questions before starting.',
            },
            {
              verdict: 'Not ready',
              range: `Below ${VERDICT_THRESHOLDS.NEEDS_WORK}`,
              gloss:
                'Enough is missing that the work would likely be redone once the '
                + 'answers arrive.',
            },
          ].map((row, i) => (
            <div
              key={row.verdict}
              className={`grid gap-x-4 py-3 sm:grid-cols-[8rem_7rem_1fr] ${
                i > 0 ? 'border-border border-t' : ''
              }`}
            >
              <dt className="font-medium">{row.verdict}</dt>
              <dd className="text-viz-muted text-sm tabular-nums">{row.range}</dd>
              <dd className="text-muted-foreground text-pretty">{row.gloss}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="report-h2">What a score is not</h2>
        <p className="text-muted-foreground text-pretty">
          A low score is not a judgement of the brief&rsquo;s author or of the idea.
          Most briefs are written early, by someone who knows things they have not
          yet had reason to write down; the score measures what is on the page, and
          the gaps are the parts still in someone&rsquo;s head. The questions exist
          to get them written down, which is why they are phrased to be forwarded
          as they are.
        </p>
      </section>
    </article>
  );
}
