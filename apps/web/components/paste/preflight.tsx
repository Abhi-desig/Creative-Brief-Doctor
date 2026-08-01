'use client';

import { useMemo } from 'react';
import { observe } from '@/lib/preflight';

/**
 * Renders the pre-flight observations. The logic lives in lib/preflight.
 */

export function Preflight({ text }: { text: string }) {
  const observations = useMemo(() => observe(text), [text]);

  // Nothing worth saying about an almost-empty box, and a panel that appears on
  // the first keystroke is noise while someone is still pasting.
  if (text.trim().length < 120) return null;

  return (
    <section className="flex flex-col gap-2" aria-label="About this document">
      <p className="text-viz-muted text-xs">
        {/* Names the limit explicitly, so nobody reads the list as a preview of
            the score. */}
        What is in the box — not a prediction of the score.
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {observations.map((observation) => (
          <li key={observation.label} className="text-muted-foreground text-xs">
            {observation.label}
            {observation.detail ? (
              <span className="text-viz-muted"> · {observation.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
