import { DIMENSION_ANCHORS } from '@cbd/contracts';

/**
 * The five dimensions and their anchor ladders, as a reference rail.
 *
 * This is the sidebar's reason to exist. A rail holding three links and
 * "Recent (0)" advertises the hole rather than filling it — but the anchor ladder
 * is thirty paragraphs answering the exact question a user has with their cursor
 * in the textarea: what would a 60 look like here, and what moves it to 80? That
 * prose was sitting in a database column, invisible.
 *
 * It also means the rail is FULL on day one, with zero rows in any table, which
 * is why reference sits above navigation rather than below it.
 */

/**
 * Renders the rubric's inline emphasis without pulling in a markdown parser.
 *
 * Exactly one anchor uses it (`deliberately *not* trying to do`), and the
 * asterisks are preserved in the display data on purpose: the drift test compares
 * the strings byte for byte against rubric-v1.md, so stripping them at authoring
 * time would break the guarantee. Rendering them here is the alternative.
 */
function withEmphasis(text: string): React.ReactNode {
  const parts = text.split(/(\*[^*]+\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.startsWith('*') && part.endsWith('*') && part.length > 2 ? (
      <em key={i}>{part.slice(1, -1)}</em>
    ) : (
      part
    ),
  );
}

export function AnchorLadder({ defaultOpen }: { defaultOpen?: string | undefined }) {
  return (
    <nav aria-label="The five dimensions" className="flex flex-col gap-1">
      <h2 className="text-viz-muted px-2 pb-1 text-[0.6875rem] font-medium tracking-wider uppercase">
        The five dimensions
      </h2>

      {DIMENSION_ANCHORS.map(({ dimension, label, subtitle, anchors }) => (
        // <details> rather than an accordion component: this has to work with no
        // JavaScript, it is the densest possible markup for thirty paragraphs,
        // and the browser gives keyboard and screen-reader behaviour for free.
        <details
          key={dimension}
          open={defaultOpen === dimension}
          className="group/dim rounded-lg"
        >
          {/*
            The flex container is INSIDE the summary, not on it.
            `display: flex` applied to a <summary> makes Chrome drop its
            disclosure role: the element was exposed to the accessibility tree as
            a nameless `generic`, so a screen reader user got no indication that
            five expandable sections existed at all. Verified in the a11y tree
            before and after. `list-none` is safe — it only removes the marker.
          */}
          <summary
            className="hover:bg-muted/60 focus-visible:ring-ring cursor-pointer list-none rounded-lg px-2 py-1.5
                       text-sm font-medium focus-visible:ring-2 focus-visible:outline-none
                       [&::-webkit-details-marker]:hidden"
          >
            <span className="flex items-baseline gap-2">
              <span
                aria-hidden="true"
                className="text-viz-muted shrink-0 transition-transform group-open/dim:rotate-90"
              >
                ›
              </span>
              <span className="text-pretty">{label}</span>
            </span>
          </summary>

          <div className="flex flex-col gap-2.5 px-2 pt-1.5 pb-3 pl-6">
            <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
              {subtitle}
            </p>
            <dl className="flex flex-col gap-2">
              {anchors.map((anchor) => (
                <div key={anchor.score} className="grid grid-cols-[1.75rem_1fr] gap-x-2">
                  {/* Tabular figures so the ladder reads as a column of numbers
                      rather than ragged text. Never coloured: a 0 here is a rung
                      on a scale, not an error. */}
                  <dt className="text-viz-muted pt-px text-right text-xs tabular-nums">
                    {anchor.score}
                  </dt>
                  <dd className="text-muted-foreground text-xs leading-relaxed text-pretty">
                    {withEmphasis(anchor.text)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </details>
      ))}
    </nav>
  );
}
