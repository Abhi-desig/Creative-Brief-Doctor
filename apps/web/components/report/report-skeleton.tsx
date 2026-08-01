import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The report's own shape, unfilled.
 *
 * Deliberately mirrors the real card order on the report page — score, summary,
 * five dimensions, questions — so the page does not reflow when the content
 * lands. A generic centred spinner would be less work and would also throw away
 * the one thing a skeleton is for: telling the reader what is about to appear.
 *
 * `Skeleton` was installed and never used until now.
 */
export function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-hidden="true">
      <header className="flex flex-col gap-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-9 w-3/5" />
      </header>

      {/* Score meter: one big figure and a verdict line. */}
      <Card>
        <CardContent className="flex items-center gap-6">
          <Skeleton className="size-20 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-44" />
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/* Exactly five: the count is a fixed property of the rubric, so the
              skeleton can be honest about it rather than guessing. */}
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-4">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-8" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
