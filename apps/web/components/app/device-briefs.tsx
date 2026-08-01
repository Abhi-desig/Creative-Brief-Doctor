'use client';

import Link from 'next/link';
import { useLocalBriefs } from '@/lib/use-local-briefs';

/**
 * "On this device" — the sidebar's list of briefs scored in this browser.
 *
 * Two rules this exists to honour:
 *
 *   - The empty state is a SENTENCE, not a list-shaped hole. An empty list with a
 *     count of zero advertises a missing feature; one line explaining that there
 *     are no accounts and the link is the record explains the design.
 *   - The score is a plain tabular figure and NEVER a coloured badge. The report
 *     is careful not to colour a low score as an error — red for 40 would tell a
 *     stakeholder the brief is broken rather than early — and the sidebar must
 *     not undo that in a place the eye lands first.
 */
export function DeviceBriefs() {
  const { briefs, hydrated, clear } = useLocalBriefs();

  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-viz-muted flex items-baseline justify-between gap-2 px-2 pb-1 text-[0.6875rem] font-medium tracking-wider uppercase">
        <span>On this device</span>
        {/* Only once known. Rendering "(0)" before hydration would flash a zero at
            someone who has ten. */}
        {hydrated && briefs.length > 0 ? (
          <span className="tabular-nums">{briefs.length}</span>
        ) : null}
      </h2>

      {!hydrated ? (
        // Reserves roughly the height of the empty-state sentence so the rail
        // does not jump when localStorage resolves.
        <div className="h-14" aria-hidden="true" />
      ) : briefs.length === 0 ? (
        <p className="text-muted-foreground px-2 text-xs leading-relaxed text-pretty">
          Briefs you score here are listed on this device. There are no accounts —
          the report link is the record, so keep it.
        </p>
      ) : (
        <>
          <ul className="flex flex-col">
            {briefs.map((brief) => (
              <li key={brief.publicId}>
                <Link
                  href={`/d/${brief.publicId}`}
                  className="hover:bg-muted/60 focus-visible:ring-ring group flex items-baseline gap-2 rounded-lg px-2 py-1.5
                             focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {brief.title ?? 'Untitled brief'}
                  </span>
                  {brief.score !== null ? (
                    <span className="text-viz-muted shrink-0 text-xs tabular-nums">
                      {brief.score}
                    </span>
                  ) : (
                    <span className="text-viz-muted shrink-0 text-xs">—</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={clear}
            className="text-viz-muted hover:text-foreground focus-visible:ring-ring mt-1 self-start rounded-md px-2 py-1
                       text-xs underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            Clear this list
          </button>
        </>
      )}
    </section>
  );
}
