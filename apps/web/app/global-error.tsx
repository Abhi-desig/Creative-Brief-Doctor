'use client';

import { useEffect } from 'react';

/**
 * Last resort: a failure in the root layout itself, before any provider mounts.
 *
 * This one file cannot rely on ANYTHING the app normally provides. It replaces the
 * root layout, so there is no ThemeProvider, no Toaster, no font variable — and
 * `globals.css` may be exactly what failed to load. So the styles here are inline
 * and literal rather than tokens or utility classes: a `bg-background` that
 * resolves to nothing renders white text on white. It also must render its own
 * `<html>` and `<body>`, which is why it looks nothing like the other boundaries.
 *
 * `color-scheme` gives the browser enough to pick sensible form and scrollbar
 * colours without any of our own CSS.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global]', error.digest ?? '', error.message);
  }, [error]);

  return (
    <html lang="en" style={{ colorScheme: 'light dark' }}>
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          lineHeight: 1.6,
        }}
      >
        <main style={{ maxWidth: '32rem' }}>
          <h1
            style={{
              margin: '0 0 0.75rem',
              fontSize: '1.5rem',
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            Something went wrong
          </h1>
          <p style={{ margin: '0 0 1.5rem', opacity: 0.75 }}>
            The page could not be rendered at all. Reloading usually clears it.
          </p>
          {error.digest ? (
            <p
              style={{
                margin: '0 0 1.5rem',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '0.75rem',
                opacity: 0.6,
              }}
            >
              Reference {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              font: 'inherit',
              fontSize: '0.875rem',
              fontWeight: 500,
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
