import { BoundaryPage } from '@/components/boundary-page';

/**
 * Root 404, for URLs that match no route at all.
 *
 * Separate from the `(public)` group's not-found, which answers a different
 * question: that one means "this brief id does not exist", this one means "there
 * is no such page". Wrapped in the density attribute by hand because an unmatched
 * URL belongs to no route group, so no group layout runs.
 */
export default function RootNotFound() {
  return (
    <div data-density="comfortable" className="bg-background min-h-dvh">
      <BoundaryPage
        title="Page not found"
        description="There is nothing at this address."
      />
    </div>
  );
}
