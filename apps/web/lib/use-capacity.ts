'use client';

import { useEffect, useState } from 'react';

export interface Capacity {
  state: 'open' | 'limited' | 'closed';
  resetsAt: string;
}

/**
 * The day's coarse scoring capacity.
 *
 * Fetched once per mount rather than polled. The value changes on the scale of a
 * whole day, and a poll would put a request on a timer on every page for a chip
 * in the corner of a sidebar.
 *
 * Returns `null` while unknown AND on failure, so callers render nothing rather
 * than guessing. Guessing "open" would let someone write a brief into a closed
 * day; guessing "closed" would stop them using a tool that works.
 */
export function useCapacity(): Capacity | null {
  const [capacity, setCapacity] = useState<Capacity | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/quota', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: Capacity | null) => {
        if (value && typeof value.state === 'string') setCapacity(value);
      })
      .catch(() => {
        // Including the abort on unmount. A capacity chip is ambient; its failure
        // must never surface as an error to someone trying to score a brief.
      });

    return () => controller.abort();
  }, []);

  return capacity;
}
