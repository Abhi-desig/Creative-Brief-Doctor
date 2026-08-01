'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useIsLocalBrief } from '@/lib/use-local-briefs';
import { Button } from '@/components/ui/button';

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
export function AuthorActions({ publicId }: { publicId: string }) {
  const isAuthor = useIsLocalBrief(publicId);
  const [copied, setCopied] = useState(false);

  // Renders nothing at all for a stakeholder, and nothing during the first paint
  // for the author. No skeleton: reserving space for a row most readers never see
  // would put a hole in the document.
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

  return (
    <section
      // Hidden in print: a PDF of this report is for the recipient, and controls
      // that cannot be pressed on paper are noise.
      className="border-border flex flex-col gap-3 border-t pt-6 print:hidden"
      aria-label="Actions for this report"
    >
      <p className="text-viz-muted text-xs">
        You scored this brief on this device.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={copyLink} className="gap-2">
          {copied ? (
            <CheckIcon className="size-4" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-4" aria-hidden="true" />
          )}
          {copied ? 'Link copied' : 'Copy link'}
        </Button>
        {/*
          Re-scoring means pasting the brief again rather than a one-click rerun.
          A button that silently spends one of the day's ten model calls is not
          something to put next to "copy link" — and the paste page is where the
          capacity chip lives, so the cost is visible before it is incurred.
        */}
        <Link
          href="/"
          data-slot="button"
          className="text-viz-muted hover:text-foreground focus-visible:ring-ring self-center rounded-md px-2 py-1
                     text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
        >
          Score another brief
        </Link>
      </div>
    </section>
  );
}
