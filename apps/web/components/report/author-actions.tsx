'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useIsLocalBrief, useLocalBriefs } from '@/lib/use-local-briefs';
import { StreamAbortedError, streamDiagnosis } from '@/lib/sse-client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { ScoringProgress, type Phase } from '@/components/paste/scoring-progress';

/**
 * Actions only the person who created this report can see.
 *
 * Identity-free personalisation from the only claim localStorage can honestly
 * make: if this browser's index contains this `publicId`, this browser created
 * this report. No account, no fingerprint, no server-side identity.
 *
 * Critically, this renders CLIENT-SIDE AFTER HYDRATION. The server's HTML is
 * byte-identical for every reader, so nothing about the page varies by who is
 * asking — a stakeholder opening a forwarded link simply has no entry and sees a
 * clean document. That is also why it sits after the questions block rather than
 * in a header: an action row above the fold that appears a moment after load
 * would shift the document under the reader.
 */
export function AuthorActions({
  publicId,
  scored,
  timesScored,
}: {
  publicId: string;
  /** False when the brief exists but has no diagnosis — the dropped-stream case. */
  scored: boolean;
  timesScored: number;
}) {
  const router = useRouter();
  const isAuthor = useIsLocalBrief(publicId);
  const { remember } = useLocalBriefs();
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  if (!isAuthor) return null;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is permission-gated. The URL is in the address bar regardless.
      setCopied(false);
    }
  }

  /**
   * Re-runs the diagnosis for this brief.
   *
   * This is the recovery path for a stream that dropped before its result frame.
   * The brief row exists from the moment it was created, so the link already
   * resolves — but without this the page said "not scored yet" with no way
   * forward, and five briefs in the dev database reached exactly that state.
   *
   * It spends a real model call against the shared daily cap, so it is labelled
   * as re-scoring rather than as a refresh, and it is never the primary action on
   * a report that already has one.
   */
  async function rescore() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('reading');

    try {
      await streamDiagnosis(
        publicId,
        (next) => {
          if (mountedRef.current) setPhase(next);
        },
        controller.signal,
      );
      remember({ publicId, title: null, score: null, scoredAt: Date.now() });
      // Server-rendered refresh rather than client state: the report is the
      // canonical artefact and must be re-read, not patched.
      router.refresh();
      if (mountedRef.current) setPhase(null);
    } catch (error) {
      if (error instanceof StreamAbortedError || !mountedRef.current) return;
      setPhase(null);
      toast.add({
        title: 'Re-scoring did not finish',
        description: error instanceof Error ? error.message : 'Something went wrong.',
      });
    }
  }

  const busy = phase !== null;

  return (
    <section
      // Hidden in print: a PDF of this report is for the recipient, and controls
      // that cannot be pressed on paper are noise.
      className="border-border flex flex-col gap-3 border-t pt-6 print:hidden"
      aria-label="Actions for this report"
    >
      <p className="text-viz-muted text-xs">
        You scored this brief on this device.
        {timesScored > 1 ? ` It has been scored ${timesScored} times.` : ''}
      </p>

      {busy ? (
        <ScoringProgress phase={phase} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={copyLink} className="gap-2">
            {copied ? (
              <CheckIcon className="size-4" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-4" aria-hidden="true" />
            )}
            {copied ? 'Link copied' : 'Copy link'}
          </Button>

          <Button
            // Primary only when there is nothing here yet — that is the dropped
            // stream, and re-scoring is the only useful thing to do.
            variant={scored ? 'outline' : 'default'}
            onClick={() => void rescore()}
            className="gap-2"
          >
            {busy && <Spinner className="size-4" />}
            {scored ? 'Score again' : 'Try scoring again'}
          </Button>

          <Link
            href="/"
            className="text-viz-muted hover:text-foreground focus-visible:ring-ring self-center rounded-md px-2 py-1
                       text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
          >
            Score another brief
          </Link>
        </div>
      )}

      {!busy ? (
        <p className="text-viz-muted text-xs">
          Re-scoring runs the brief through the model again and counts against the
          day&rsquo;s shared limit.
        </p>
      ) : null}
    </section>
  );
}
