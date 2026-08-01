'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { BoundaryPage } from '@/components/boundary-page';
import { buttonVariants } from '@/components/ui/button';

/**
 * Catches anything thrown while rendering a public page — most realistically
 * `fetchReport` on an API 500 or a timeout, neither of which the report page
 * catches. It lives inside the `(public)` group so it renders with the
 * comfortable density and the right background, rather than as Next's bare
 * unstyled "Application error" screen outside the layout.
 */
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server-side message is stripped from production bundles; the digest is
    // the only handle that correlates this screen with the server log.
    console.error('[report]', error.digest ?? '', error.message);
  }, [error]);

  return (
    <BoundaryPage
      title="This report could not be loaded"
      description={
        'Something failed between here and the scoring service. The report itself '
        + 'is fine — nothing was lost, and the link will keep working.'
      }
      detail={error.digest ? `Reference ${error.digest}` : undefined}
      action={
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            data-slot="button"
            className={buttonVariants()}
          >
            Try again
          </button>
          <Link href="/" data-slot="button" className={buttonVariants({ variant: 'outline' })}>
            Diagnose a brief
          </Link>
        </div>
      }
    />
  );
}
