import type { Metadata } from 'next';
import { AdminNav } from '@/components/admin/admin-nav';

/**
 * The admin frame.
 *
 * Note what is ABSENT: `data-density="comfortable"`. The public surface carries
 * that attribute for a document someone forwards to a client; an operator tool
 * wants the compact defaults, where more rows fit on a screen and scanning beats
 * reading. Two densities from one component library, switched by one attribute.
 */

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin' },
  // Belt and braces alongside the middleware gate. An admin panel should never
  // appear in an index even if a route is accidentally left public.
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background min-h-dvh">
      <AdminNav />
      <main className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8">{children}</main>
    </div>
  );
}
