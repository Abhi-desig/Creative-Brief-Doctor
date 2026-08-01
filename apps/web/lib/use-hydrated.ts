'use client';

import { useSyncExternalStore } from 'react';

/**
 * False during server render and the first client render, true afterwards.
 *
 * For anything that can only be known in the browser — the resolved theme, a
 * value from localStorage — and where rendering the wrong answer first would
 * either mismatch hydration or visibly flip.
 *
 * `useSyncExternalStore` rather than the more familiar
 * `useEffect(() => setMounted(true), [])`. That pattern works, but it calls
 * setState synchronously in an effect body, which forces a second render pass on
 * every mount and is what the React Compiler's `set-state-in-effect` rule flags.
 * This expresses the same idea as what it actually is: a value with a different
 * server snapshot than client snapshot.
 *
 * `subscribe` is a no-op because the answer never changes after hydration — it
 * goes false → true exactly once, which the snapshot swap already handles.
 */
const noop = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
