/**
 * The report group. `/d/[publicId]` and nothing else.
 *
 * No sidebar, no top nav, no header — and that bareness is a feature, not an
 * omission. This is the page a stakeholder opens from a forwarded link, and an app
 * frame they cannot enter would make them react to the tool instead of the brief.
 * The report's forwardability IS the product.
 *
 * The app frame lives in `app/(app)/layout.tsx`. Both groups set
 * `data-density="comfortable"`, so the two share a type scale and padding while
 * /admin keeps the compact defaults that suit a dense operator tool.
 */
export default function ReportLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-density="comfortable" className="bg-background min-h-dvh">
      {children}
    </div>
  );
}
