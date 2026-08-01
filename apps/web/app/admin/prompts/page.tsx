'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, AdminApiError } from '@/lib/admin-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { SAMPLE_BRIEFS } from '@/lib/sample-briefs';

/**
 * Rubric versions.
 *
 * The important affordance here is TEST BEFORE ACTIVATE. Until the test endpoint
 * existed, a draft went straight from this editor to ACTIVE, where it immediately
 * governed every public diagnosis — so editing the rubric was a change you could
 * only evaluate in production, on someone else's brief. Activation is now the
 * last step rather than the only one.
 *
 * Content is immutable once a version is not DRAFT; the API forks a new draft
 * rather than mutating, and a database trigger enforces it. Nothing here needs to
 * check that — it will simply be refused.
 */

interface Version {
  id: string;
  label: string;
  contentHash: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  changeNote: string | null;
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
  activatedBy: string | null;
}

interface TestRun {
  id: string;
  promptLabel: string;
  model: string;
  stopReason: string;
  scores: { overallScore: number; verdict: string; summary: string };
  rawOutput: string;
  latencyMs: number;
  costUsd: string | null;
  degradations: { code: string; detail?: string }[];
}

export default function PromptsPage() {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [status, setStatus] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<TestRun | null>(null);
  const [briefText, setBriefText] = useState(SAMPLE_BRIEFS[1]?.text ?? '');

  const load = useCallback(async () => {
    try {
      const template = await adminFetch<{ versions: Version[] }>('prompts');
      setVersions(template.versions);
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not load prompts.',
      });
    }
  }, []);

  // `load` awaits before it touches state, so the update lands in a microtask
  // rather than synchronously — the cascading render this rule guards against
  // cannot happen here. The analysis is conservative about any function that
  // transitively setStates.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function testDraft(id: string) {
    setTesting(id);
    setStatus(null);
    setResult(null);
    try {
      setResult(await adminFetch<TestRun>(`prompts/${id}/test`, {
        method: 'POST',
        body: { briefText },
      }));
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof AdminApiError ? error.message : 'The test run failed.',
      });
    } finally {
      setTesting(null);
    }
  }

  async function activate(id: string) {
    const reason = window.prompt('Why is this being activated? (recorded in the audit log)');
    if (!reason) return;

    setBusy(id);
    setStatus(null);
    try {
      await adminFetch(`prompts/${id}/activate`, { method: 'POST', body: { reason } });
      setStatus({ kind: 'ok', text: 'Activated. It governs the next diagnosis.' });
      await load();
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof AdminApiError ? error.message : 'Could not activate.',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Prompts</h1>
        <p className="text-muted-foreground text-sm">
          Test a draft against the active model before it governs anything public.
        </p>
      </header>

      {status ? (
        <p
          className={`text-sm ${status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {status.text}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Test brief</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="briefText">The brief a test run scores</FieldLabel>
            <Textarea
              id="briefText"
              rows={6}
              value={briefText}
              onChange={(e) => setBriefText(e.target.value)}
              className="resize-y font-mono text-xs"
            />
            <FieldDescription>
              A test run spends a real model call and counts against the same daily
              cap as public scoring — the quota is shared, so pretending otherwise
              is how a free tier gets exhausted by an afternoon of tuning.
            </FieldDescription>
          </Field>
          <div className="flex flex-wrap gap-2">
            {SAMPLE_BRIEFS.map((sample) => (
              <Button
                key={sample.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setBriefText(sample.text)}
              >
                {sample.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Last test run</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
              {[
                ['Version', result.promptLabel],
                ['Model', result.model],
                ['Overall', String(result.scores.overallScore)],
                ['Verdict', result.scores.verdict],
                ['Stop reason', result.stopReason],
                ['Latency', `${result.latencyMs} ms`],
                ['Cost', result.costUsd === null ? 'not priced' : `$${result.costUsd}`],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b py-1">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>

            {result.degradations.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">Degradations</p>
                {/* The most valuable output of a test run: a draft that only
                    parses after a repair pass is a draft with a problem. */}
                <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
                  {result.degradations.map((d, i) => (
                    <li key={i}>
                      {d.code}
                      {d.detail ? ` — ${d.detail}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <details>
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm">
                Raw model output
              </summary>
              <pre className="bg-muted/40 mt-2 max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
                {result.rawOutput}
              </pre>
            </details>
          </CardContent>
        </Card>
      ) : null}

      {versions === null ? (
        <div className="flex items-center gap-2 py-8">
          <Spinner className="size-4" />
          <p className="text-muted-foreground text-sm">Loading…</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {versions.map((version) => (
            <Card key={version.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <p className="font-medium">
                    {version.label}{' '}
                    <span className="text-muted-foreground text-xs font-normal">
                      {version.status.toLowerCase()}
                    </span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {version.changeNote ?? 'No change note'} · {version.createdBy} ·{' '}
                    <span className="font-mono">{version.contentHash.slice(0, 12)}</span>
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={testing === version.id || briefText.trim().length < 40}
                    onClick={() => void testDraft(version.id)}
                    className="gap-2"
                  >
                    {testing === version.id && <Spinner className="size-3" />}
                    Test
                  </Button>

                  {version.status === 'DRAFT' ? (
                    <Button
                      size="sm"
                      disabled={busy === version.id}
                      onClick={() => void activate(version.id)}
                    >
                      Activate
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
