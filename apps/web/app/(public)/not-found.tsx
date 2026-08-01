import { BoundaryPage } from '@/components/boundary-page';

/**
 * Reached when the report page calls `notFound()` — the brief id does not exist.
 *
 * The copy names the most likely cause rather than the least: these URLs are
 * forwarded by hand into email and chat, where they get truncated far more often
 * than reports get deleted. "Check the link is complete" is actionable; "404" is
 * not.
 */
export default function PublicNotFound() {
  return (
    <BoundaryPage
      title="No report at this link"
      description={
        'The link may have been truncated on its way here — they are easy to clip '
        + 'when pasted into chat or email. Ask whoever shared it for the whole URL.'
      }
    />
  );
}
