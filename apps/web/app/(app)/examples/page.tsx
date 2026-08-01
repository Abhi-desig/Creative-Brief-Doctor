import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchExamples } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Pre-scored briefs, linking to their real reports.
 *
 * This page is indexable; the reports it links to are NOT. Every `/d/*` keeps
 * `robots: noindex`, examples included, with no special case — one real client
 * report leaking into a search index because someone extended an exception
 * outweighs whatever SEO six samples would earn. So this page carries the
 * indexable summary and the reports stay unlisted.
 *
 * The examples are seeded rows scored once through the real pipeline, with
 * backdated `createdAt` so they do not consume the deploy day's quota — the daily
 * counter is a count over `Diagnosis.createdAt` since the start of the UTC day,
 * and six examples written on deploy day would silently eat six of that day's
 * cap.
 */

export const metadata: Metadata = {
  title: 'Examples',
  description:
    'Real briefs scored against the rubric, from a two-line request to a fully '
    + 'specified brief — with the questions each one produced.',
};

/** Revalidate hourly: seeded examples change when someone reseeds, not per request. */
export const revalidate = 3600;

export default async function ExamplesPage() {
  const examples = await fetchExamples();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-5 py-16 sm:px-8 sm:py-24">
      <header className="flex flex-col gap-5">
        <h1 className="report-h1 text-balance">Examples</h1>
        <p className="report-lede max-w-2xl">
          Briefs of different shapes, scored against the same rubric. Each links to
          the report exactly as it would be produced and forwarded.
        </p>
      </header>

      {examples.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col gap-2">
            <p className="font-medium">No examples are seeded yet</p>
            <p className="text-muted-foreground text-pretty">
              Examples are scored once through the real pipeline and stored, rather
              than generated on demand — twenty model calls a day is the whole
              budget, and spending it on a gallery would leave none for actual
              briefs. Run{' '}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                pnpm --filter @cbd/api seed:examples
              </code>{' '}
              against a configured provider to populate this page.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {examples.map((example) => (
            <li key={example.publicId}>
              <Link
                href={`/d/${example.publicId}`}
                className="focus-visible:ring-ring block rounded-xl focus-visible:ring-2 focus-visible:outline-none"
              >
                <Card className="hover:ring-foreground/20 transition-shadow">
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex items-baseline justify-between gap-4">
                      <h2 className="font-medium text-pretty">{example.title}</h2>
                      {/* Plain figure, no colour. A 20 here is the point of the
                          example, not a failure to flag in red. */}
                      <span className="text-viz-muted shrink-0 text-sm tabular-nums">
                        {example.overallScore}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-sm text-pretty">
                      {example.shape}
                    </p>
                    <p className="text-viz-muted text-xs">
                      {example.questionCount} follow-up question
                      {example.questionCount === 1 ? '' : 's'}
                      {' · '}
                      {example.charCount.toLocaleString()} characters
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
