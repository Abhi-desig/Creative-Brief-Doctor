import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

/**
 * The shared look for every failure and empty state: 404, error, global error.
 *
 * One component rather than four hand-rolled pages, because these are the screens
 * nobody reviews and they are exactly where an app stops looking finished. They
 * previously did not exist at all — `fetchReport` throws on any non-404, the
 * report page did not catch it, and there were no `error`/`not-found`/`loading`
 * files anywhere, so an API 500 rendered Next's bare unstyled "Application error"
 * with none of the surrounding chrome.
 *
 * Deliberately quiet: no icon, no colour, no apology. A stakeholder who opens a
 * forwarded link and hits an error should be told what to do next in one line, and
 * the tone of a report page that scores things carefully should not switch to
 * alarm because a fetch failed.
 */
export function BoundaryPage({
  title,
  description,
  detail,
  action,
}: {
  title: string;
  description: string;
  /** Technical context. Rendered small and monospaced; omitted when absent. */
  detail?: string | undefined;
  action?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-start gap-5 px-5 py-24 sm:px-8">
      <div className="flex flex-col gap-3">
        <h1 className="report-h1 text-balance">{title}</h1>
        <p className="report-lede">{description}</p>
      </div>

      {detail ? (
        <p className="text-viz-muted border-border border-l-2 pl-3 font-mono text-xs leading-relaxed break-words">
          {detail}
        </p>
      ) : null}

      {/*
        Styled as a Link rather than `<Button render={<Link/>}>`: Base UI's Button
        takes a `render` prop (there is no `asChild` here — this is Base UI, not
        Radix), and a plain anchor is the honest element for navigation anyway.
        `data-slot="button"` is set explicitly so the comfortable-density rules,
        which key off that attribute, still reach it.
      */}
      {action ?? (
        <Link
          href="/"
          data-slot="button"
          className={buttonVariants({ variant: 'outline' })}
        >
          Diagnose a brief
        </Link>
      )}
    </main>
  );
}
