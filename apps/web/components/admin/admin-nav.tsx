'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/lib/admin-client';

/**
 * Written as a component taking a typed href rather than mapped over an array of
 * strings. `typedRoutes` is on, and mapping widens each href to `string`, which
 * defeats the compile-time check that a link points at a route that exists.
 */
function AdminLink({
  href,
  exact,
  children,
}: {
  href: React.ComponentProps<typeof Link>['href'];
  exact?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const target = String(href);
  // Exact for /admin, prefix for the rest, or /admin would light up everywhere.
  const active = exact ? pathname === target : pathname.startsWith(target);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`focus-visible:ring-ring rounded-md px-2 py-1 text-sm focus-visible:ring-2 focus-visible:outline-none ${
        active
          ? 'bg-muted text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </Link>
  );
}

export function AdminNav() {
  const pathname = usePathname();

  // The login page renders inside this layout but has no session to sign out of.
  if (pathname === '/admin/login') return null;

  return (
    <header className="border-border border-b">
      <nav className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-1 gap-y-2 px-5 py-3 sm:px-8">
        <span className="text-muted-foreground mr-3 text-xs font-medium tracking-wider uppercase">
          Admin
        </span>

        <AdminLink href="/admin" exact>
          Status
        </AdminLink>
        <AdminLink href="/admin/providers">Providers</AdminLink>
        <AdminLink href="/admin/model">Model</AdminLink>
        <AdminLink href="/admin/prompts">Prompts</AdminLink>

        <button
          type="button"
          onClick={() => void signOut()}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring ml-auto rounded-md px-2 py-1
                     text-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          Sign out
        </button>
      </nav>
    </header>
  );
}
