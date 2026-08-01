/**
 * Public route group.
 *
 * `data-density="comfortable"` is the single switch for the whole public
 * surface — it scopes the radius knob, card padding, type sizes and motion
 * defined in globals.css. /admin sits outside this group and keeps nova's
 * compact defaults, which is right for a dense operator tool and wrong for a
 * document someone forwards to a client.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-density="comfortable" className="bg-background min-h-dvh">
      {children}
    </div>
  );
}
