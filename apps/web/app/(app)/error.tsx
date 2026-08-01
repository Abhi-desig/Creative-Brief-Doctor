'use client';

import { useEffect } from 'react';
import { BoundaryPage } from '@/components/boundary-page';
import { buttonVariants } from '@/components/ui/button';

/**
 * Errors inside the app frame — the paste page, the rubric, the examples list.
 *
 * Separate copy from the report group's boundary because the reader is different.
 * Here they are using the tool and have probably just lost something they typed,
 * so the first thing to say is what happened to their text. There, they opened a
 * link someone sent them and have nothing invested in the page.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app]', error.digest ?? '', error.message);
  }, [error]);

  return (
    <BoundaryPage
      title="Something went wrong"
      description={
        'This page failed to render. Nothing was sent for scoring, so no brief '
        + 'was saved and nothing was charged against the day.'
      }
      detail={error.digest ? `Reference ${error.digest}` : undefined}
      action={
        <button type="button" onClick={reset} data-slot="button" className={buttonVariants()}>
          Try again
        </button>
      }
    />
  );
}
