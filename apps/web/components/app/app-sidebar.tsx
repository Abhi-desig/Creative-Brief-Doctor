import Link from 'next/link';
import { AnchorLadder } from './anchor-ladder';
import { DeviceBriefs } from './device-briefs';
import { CapacityChip } from './capacity-chip';
import { ThemeToggle } from './theme-toggle';

/**
 * The app frame's left rail.
 *
 * Order is the whole design: REFERENCE ABOVE NAVIGATION. On a first visit the nav
 * is two links and the device list is empty, so leading with them would put a
 * near-empty rail in the most valuable column on the page. Leading with the anchor
 * ladder means the top of the rail is dense, real prose before anything else
 * registers — and it happens to answer the question someone actually has while
 * staring at an empty textarea.
 *
 * Never rendered on /d/[publicId]. A stakeholder who opens a forwarded report and
 * sees an app frame they cannot enter reacts to the tool instead of the brief.
 */
function NavLink({
  href,
  children,
}: {
  href: React.ComponentProps<typeof Link>['href'];
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="hover:bg-muted/60 focus-visible:ring-ring rounded-lg px-2 py-1.5 text-sm
                 focus-visible:ring-2 focus-visible:outline-none"
    >
      {children}
    </Link>
  );
}

export function AppSidebar() {
  return (
    <div className="flex h-full flex-col gap-7 overflow-y-auto px-3 py-6">
      <Link
        href="/"
        className="focus-visible:ring-ring rounded-md px-2 text-sm font-semibold tracking-tight
                   focus-visible:ring-2 focus-visible:outline-none"
      >
        Creative Brief Doctor
      </Link>

      <AnchorLadder />

      <nav aria-label="Tool" className="flex flex-col gap-1">
        <h2 className="text-viz-muted px-2 pb-1 text-[0.6875rem] font-medium tracking-wider uppercase">
          Tool
        </h2>
        {/*
          Written out rather than mapped over an array. `typedRoutes` is on, and
          mapping widens each href to `string`, which defeats the check that
          catches a link to a route that does not exist — the whole reason the
          option is enabled.
        */}
        <NavLink href="/">Diagnose a brief</NavLink>
        <NavLink href="/rubric">The full rubric</NavLink>
        <NavLink href="/examples">Examples</NavLink>
      </nav>

      <DeviceBriefs />

      {/* Pushed to the bottom. Both are ambient controls rather than content. */}
      <footer className="mt-auto flex items-center justify-between gap-2 px-2 pt-4">
        <CapacityChip />
        <ThemeToggle />
      </footer>
    </div>
  );
}
