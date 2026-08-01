import { ReportSkeleton } from '@/components/report/report-skeleton';

/**
 * Shown while the report page's server fetch is in flight.
 *
 * Scoped to the report route rather than the group: `/` is a form that renders
 * instantly and needs no skeleton, and a group-level `loading.tsx` would flash one
 * over it on every navigation.
 */
export default function ReportLoading() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
      <ReportSkeleton />
    </main>
  );
}
