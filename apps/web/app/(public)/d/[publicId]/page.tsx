import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { fetchReport } from '@/lib/api';
import { ScoreMeter } from '@/components/report/score-meter';
import { DimensionBars } from '@/components/report/dimension-bars';
import { QuestionsBlock } from '@/components/report/questions-block';

/**
 * The shareable report. A Server Component, so a pasted link unfurls with real
 * OG metadata and renders fully for a stakeholder with no session and no
 * JavaScript — this page's whole job is to be forwardable.
 */

interface PageProps {
  params: Promise<{ publicId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { publicId } = await params;
  const report = await fetchReport(publicId).catch(() => null);

  if (!report?.diagnosis) {
    return { title: 'Brief diagnosis', robots: { index: false, follow: false } };
  }

  const { diagnosis, brief } = report;
  const name = brief.title ?? 'Brief';
  const decision =
    diagnosis.verdict === 'READY' ? 'Ready to brief' : 'Needs input before we start';

  return {
    title: `${name} — ${decision}`,
    description:
      `Scored ${diagnosis.overallScore} out of 100 across five dimensions, `
      + `with ${diagnosis.questions.length} follow-up questions.`,
    // A shared report URL is a private working document between colleagues. It
    // is unguessable rather than secret, but it should never end up in an index.
    robots: { index: false, follow: false },
    openGraph: {
      title: `${name} — ${decision}`,
      description: diagnosis.summary,
      type: 'article',
      ...(process.env.NEXT_PUBLIC_APP_URL
        ? { url: `${process.env.NEXT_PUBLIC_APP_URL}/d/${publicId}` }
        : {}),
    },
    twitter: {
      card: 'summary',
      title: `${name} — ${decision}`,
      description: diagnosis.summary,
    },
  };
}

export default async function ReportPage({ params }: PageProps) {
  const { publicId } = await params;
  const report = await fetchReport(publicId);
  if (!report) notFound();

  const { brief, diagnosis } = report;

  if (!diagnosis) {
    return (
      <Shell>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>This brief has not been scored yet</EmptyTitle>
            <EmptyDescription>
              It was saved, but the diagnosis did not finish. Open it from the
              paste page to run it again.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Shell>
    );
  }

  const scoredAt = new Date(diagnosis.createdAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <Shell>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm font-medium">Brief diagnosis</p>
          <h1 className="report-h1 text-balance">{brief.title ?? 'Untitled brief'}</h1>
        </header>

        <Card>
          <CardContent>
            <ScoreMeter score={diagnosis.overallScore} verdict={diagnosis.verdict} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="report-lede text-foreground/90">{diagnosis.summary}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>The five dimensions</CardTitle>
          </CardHeader>
          <CardContent>
            <DimensionBars rows={diagnosis.dimensions} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Questions to send back</CardTitle>
          </CardHeader>
          <CardContent>
            <QuestionsBlock questions={diagnosis.questions} briefTitle={brief.title} />
          </CardContent>
        </Card>

        {/*
          Provenance: rubric version and date ONLY.
          Never the provider or the model. A stakeholder who reads "scored by
          gemini-2.5-flash" argues with the tooling instead of their brief. Full
          attribution lives in the database and the admin panel.
        */}
        <footer className="text-viz-muted flex flex-wrap gap-x-2 gap-y-1 pt-2 text-sm">
          <span>Rubric {diagnosis.rubricVersion}</span>
          <span aria-hidden="true">·</span>
          <span>Scored {scoredAt}</span>
        </footer>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
      {children}
    </main>
  );
}
