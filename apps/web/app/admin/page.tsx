'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/admin-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

/**
 * Operational status.
 *
 * Polls once a minute. That cadence is only viable because the `promptTest` tier
 * was removed from admin reads — it capped every one of them at 20 per hour, so
 * this page would have gone dead after twenty minutes of being left open, which
 * is the normal way an operator uses a status page.
 */

interface Status {
  provider: {
    kind: string | null;
    label: string | null;
    model: string | null;
    degradedReason: string | null;
  };
  prompt: { label: string | null; hashMatches: boolean };
  today: {
    diagnoses: number;
    spendUsd: number | null;
    quotaUsed: number;
    quotaCap: number;
    quotaResetsAt: string;
  };
  failuresLast24h: { action: string; count: number }[];
}

const POLL_MS = 60_000;

export default function StatusPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await adminFetch<Status>('status', signal ? { signal } : {}));
      setError(null);
    } catch (caught) {
      if ((caught as { name?: string })?.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : 'Could not load status.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [load]);

  if (!status) {
    return (
      <div className="flex items-center gap-2 py-12">
        {error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : (
          <>
            <Spinner className="size-4" />
            <p className="text-muted-foreground text-sm">Loading status…</p>
          </>
        )}
      </div>
    );
  }

  const { provider, prompt, today, failuresLast24h } = status;
  const scoring = !provider.degradedReason && prompt.hashMatches;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Status</h1>
        <p className="text-muted-foreground text-sm">
          {scoring
            ? 'Scoring normally.'
            : 'Not currently scoring — see the reason below.'}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Provider</CardTitle>
          </CardHeader>
          <CardContent>
            <Rows
              rows={[
                ['Kind', provider.kind ?? '—'],
                ['Label', provider.label ?? '—'],
                ['Model', provider.model ?? '—'],
                ...(provider.degradedReason
                  ? ([['Degraded', provider.degradedReason]] as [string, string][])
                  : []),
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <Rows
              rows={[
                ['Active version', prompt.label ?? 'none'],
                // A mismatch means the stored hash and a fresh hash of the content
                // disagree, which would make a diagnosis attributable to bytes
                // that have since changed. Stated plainly rather than hidden.
                ['Content hash', prompt.hashMatches ? 'matches' : 'MISMATCH'],
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Today</CardTitle>
          </CardHeader>
          <CardContent>
            <Rows
              rows={[
                ['Diagnoses', String(today.diagnoses)],
                ['Quota', `${today.quotaUsed} / ${today.quotaCap}`],
                [
                  'Spend',
                  // null is "no pricing configured", which is the correct and
                  // expected state on a free tier — never rendered as $0.00,
                  // which would read as "this cost nothing".
                  today.spendUsd === null
                    ? 'not priced'
                    : `$${today.spendUsd.toFixed(4)}`,
                ],
                ['Resets', new Date(today.quotaResetsAt).toLocaleString()],
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Failures (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            {failuresLast24h.length === 0 ? (
              <p className="text-muted-foreground text-sm">None recorded.</p>
            ) : (
              <Rows
                rows={failuresLast24h.map((f) => [f.action, String(f.count)] as [string, string])}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {error ? (
        // Shown alongside stale data rather than replacing it: an operator would
        // rather see a minute-old status with a warning than an empty page.
        <p className="text-destructive text-sm" role="alert">
          {error} — showing the last successful read.
        </p>
      ) : null}
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="flex flex-col text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 border-b py-1.5 last:border-0">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
