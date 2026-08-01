import { AppSidebar } from '@/components/app/app-sidebar';

/**
 * The app frame: everything except the shareable report.
 *
 * `/d/[publicId]` deliberately sits in its OWN group with no frame at all. That is
 * the single most important structural decision on the public surface — the
 * report's forwardability is the product, and wrapping it in navigation a
 * stakeholder cannot use converts an objective-looking document into a product
 * demo.
 *
 * `data-density="comfortable"` is carried here too, so both public groups share
 * the same padding, radius and type scale while /admin keeps compact defaults.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-density="comfortable" className="bg-background min-h-dvh">
      {/*
        Single column below `lg`. The rail is reference material, not navigation
        you need to reach the tool, so on a narrow screen it belongs after the
        content rather than behind a hamburger that implies you are missing
        something.
      */}
      <div className="mx-auto flex w-full max-w-[100rem] flex-col lg:flex-row">
        <aside
          className="border-border order-2 shrink-0 border-t lg:sticky lg:top-0 lg:order-1 lg:h-dvh
                     lg:w-72 lg:border-t-0 lg:border-r xl:w-80"
        >
          <AppSidebar />
        </aside>

        <main className="order-1 min-w-0 flex-1 lg:order-2">{children}</main>
      </div>
    </div>
  );
}
