'use client';

import { useTheme } from 'next-themes';
import { MoonIcon, SunIcon } from 'lucide-react';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * Light/dark switch for the app frame.
 *
 * `next-themes` cannot know the resolved theme until it has read localStorage and
 * the system preference, so the icon is rendered only after mount — otherwise the
 * server emits one icon, the client immediately decides on the other, and React
 * reports a hydration mismatch. A fixed-size placeholder holds the space so the
 * sidebar footer does not shift.
 *
 * The `d` hotkey in ThemeProvider does the same thing; this is the discoverable
 * version of it.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useHydrated();

  const isDark = resolvedTheme === 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      // Static label before mount: announcing "switch to dark" while the page is
      // already dark is worse than the slightly generic wording.
      aria-label={mounted ? `Switch to ${isDark ? 'light' : 'dark'} theme` : 'Switch theme'}
      title="Switch theme (d)"
      className="text-viz-muted hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring
                 grid size-7 shrink-0 place-items-center rounded-md transition-colors
                 focus-visible:ring-2 focus-visible:outline-none"
    >
      {mounted ? (
        isDark ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />
      ) : (
        <span className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}
