'use client';

import { useEffect, useState } from 'react';
import { useCapacity, type Capacity } from '@/lib/use-capacity';

const COPY: Record<Capacity['state'], string> = {
  open: 'Capacity today · open',
  limited: 'Capacity today · limited',
  closed: 'Closed for today',
};

/**
 * The day's scoring capacity, stated before anyone commits a brief to the box.
 *
 * Shows a state, never a count — see `PublicQuota` on the API side. "3 of 400
 * left" invites racing for the last call, advertises how small the tier is, and
 * contradicts the per-IP hourly limit a visitor cannot see.
 *
 * No colour. A closed day is a fact about the tool's budget, not a fault the
 * reader caused or can fix, and an amber pill in the corner of every page reads as
 * a warning about their brief.
 */
export function CapacityChip() {
  const capacity = useCapacity();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Nothing until known: a chip that says "open" and then corrects itself to
  // "closed" is worse than one that appears a moment late.
  if (!mounted || !capacity) return null;

  return (
    <p
      className="text-viz-muted text-xs"
      // Announced when it changes to closed mid-session, but not fussily.
      aria-live="polite"
    >
      {COPY[capacity.state]}
      {capacity.state === 'closed' && capacity.resetsAt ? (
        <>
          {' · '}
          <ResetTime iso={capacity.resetsAt} />
        </>
      ) : null}
    </p>
  );
}

/**
 * Rendered client-side only, because a UTC reset instant formatted on the server
 * would be in the server's locale and produce a hydration mismatch against the
 * reader's.
 */
function ResetTime({ iso }: { iso: string }) {
  const when = new Date(iso);
  return (
    <time dateTime={iso}>
      back {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
    </time>
  );
}
